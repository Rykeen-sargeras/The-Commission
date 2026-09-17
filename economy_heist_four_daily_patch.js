'use strict';

const Discord = require('discord.js');
const economyModule = require('./economy');
const discordEconomy = require('./economy_discord');
const { HEIST_CHANNEL_ID, HEIST_TYPES } = require('./economy_special_events');

const HEIST_ENTRY_FEE = 100_000;
const HEIST_BASE_REWARD = 150_000;
const HEIST_MAX_REWARD = 1_000_000;
const HEIST_BASE_SUCCESS = 66;
const HEIST_SUCCESS_PER_PLAYER = 1.5;
const HEIST_SIGNUP_MS = 15 * 60 * 1000;
const LATE_JOIN_WINDOW_MS = 3 * 60 * 1000;
const EASTERN_TIME_ZONE = 'America/New_York';
const HEIST_LOCAL_HOURS = Object.freeze([3, 9, 15, 21]);
const REMINDER_LOCAL_HOURS = new Set([9, 21]);
const REMINDER_WINDOW_MINUTES = 15;
const REMINDER_SLOT_SETTING = 'four_daily_heist_last_reminder_slot';

const easternFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
});

function easternParts(ms) {
    const values = {};
    for (const part of easternFormatter.formatToParts(new Date(ms))) {
        if (part.type !== 'literal') values[part.type] = Number(part.value);
    }
    return values;
}

function calendarShift(parts, days) {
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function easternLocalEpoch({ year, month, day, hour, minute = 0, second = 0 }) {
    const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    let guess = targetAsUtc;
    for (let iteration = 0; iteration < 4; iteration += 1) {
        const actual = easternParts(guess);
        const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
        const delta = targetAsUtc - actualAsUtc;
        if (!delta) break;
        guess += delta;
    }
    return guess;
}

function fourDailySchedule(now = Date.now()) {
    const local = easternParts(now);
    const today = { year: local.year, month: local.month, day: local.day };
    const candidates = HEIST_LOCAL_HOURS.map(hour => ({
        hour,
        at: easternLocalEpoch({ ...today, hour }),
    }));

    let current = [...candidates].reverse().find(slot => slot.at <= now);
    if (!current) {
        const previousDay = calendarShift(today, -1);
        current = { hour: 21, at: easternLocalEpoch({ ...previousDay, hour: 21 }) };
    }

    let next = candidates.find(slot => slot.at > current.at);
    if (!next) {
        const nextDay = calendarShift(today, 1);
        next = { hour: 3, at: easternLocalEpoch({ ...nextDay, hour: 3 }) };
    }

    return {
        startsAt: current.at,
        signupEndsAt: current.at + HEIST_SIGNUP_MS,
        nextAt: next.at,
    };
}

function heistSuccessChance(playerCount) {
    return Math.min(100, HEIST_BASE_SUCCESS + (Math.max(0, Number(playerCount) || 0) * HEIST_SUCCESS_PER_PLAYER));
}

function scaledReward(playerCount) {
    return Math.min(HEIST_MAX_REWARD, HEIST_BASE_REWARD * Math.max(1, Number(playerCount) || 1));
}

function equalPayouts(entries, pool) {
    const payouts = new Map();
    if (!entries.length || pool <= 0) return payouts;
    const share = Math.floor(pool / entries.length);
    let paid = 0;
    entries.forEach((entry, index) => {
        const payout = index === entries.length - 1 ? pool - paid : share;
        paid += payout;
        payouts.set(entry.user_id, payout);
    });
    return payouts;
}

function capPayouts(outcome, cap = HEIST_MAX_REWARD) {
    const rows = [...outcome.payouts.entries()];
    const total = rows.reduce((sum, [, value]) => sum + Number(value || 0), 0);
    if (total <= cap) {
        outcome.rewardPool = total;
        return outcome;
    }

    const scaled = new Map();
    let paid = 0;
    rows.forEach(([userId, value], index) => {
        const payout = index === rows.length - 1
            ? cap - paid
            : Math.floor((Number(value || 0) / total) * cap);
        paid += payout;
        scaled.set(userId, payout);
    });
    outcome.payouts = scaled;
    outcome.rewardPool = cap;
    outcome.story = [...(outcome.story || []), `💰 The heist payout hit the **${cap.toLocaleString('en-US')} Blood Money** maximum.`];
    return outcome;
}

function randomBoss(random = Math.random) {
    const bosses = HEIST_TYPES.filter(type => type.id !== 'normal');
    return bosses[Math.floor(Math.min(0.999999, Math.max(0, random())) * bosses.length)];
}

function reminderSlot(now = Date.now()) {
    const local = easternParts(now);
    if (!REMINDER_LOCAL_HOURS.has(local.hour) || local.minute >= REMINDER_WINDOW_MINUTES) return null;
    return `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}-${String(local.hour).padStart(2, '0')}`;
}

function installFourDailyHeists() {
    const PreviousEconomyService = economyModule.EconomyService;

    class FourDailyHeistEconomyService extends PreviousEconomyService {
        constructor(options = {}) {
            super(options);
            this.config.heistEntryFee = HEIST_ENTRY_FEE;
            this.config.heistMinimumPlayers = 1;
        }

        // Disable the older round-based automatic pinger. This patch owns the
        // 9 AM / 9 PM Eastern reminders explicitly.
        setting(guildId, key) {
            if (key === 'special_heist_last_ping_at') return String(Date.now());
            return super.setting(guildId, key);
        }

        heistSchedule(now = Date.now()) {
            return fourDailySchedule(now);
        }

        queueNextHeist(guildId, userId, interactionId, targetStart, now = Date.now()) {
            return this.transaction(() => {
                const existing = this.queuedHeistEntry(guildId, userId);
                if (existing) {
                    return {
                        queued: true,
                        alreadyQueued: true,
                        targetStart: existing.target_start,
                        balance: this.member(guildId, userId)?.balance || 0,
                    };
                }
                const reserved = this.reserveWager(guildId, userId, HEIST_ENTRY_FEE, interactionId, `heist-queue:${targetStart}`, now);
                this.db.prepare(`INSERT INTO special_heist_queue(guild_id,user_id,target_start,entry_fee,queued_at,interaction_id)
                    VALUES(?,?,?,?,?,?)`).run(guildId, userId, targetStart, HEIST_ENTRY_FEE, now, interactionId || '');
                return { queued: true, alreadyQueued: false, targetStart, balance: reserved.balance };
            });
        }

        joinHeist(guildId, userId, roundId, interactionId, now = Date.now()) {
            const state = this.heistState(guildId, now);
            const remaining = state.phase === 'signup' ? state.round.signup_ends_at - now : 0;
            if (state.phase !== 'signup' || remaining <= LATE_JOIN_WINDOW_MS) {
                return this.queueNextHeist(guildId, userId, interactionId, state.nextAt, now);
            }

            return this.transaction(() => {
                const round = this.heistRound(state.round.round_id);
                if (!round || round.guild_id !== guildId || round.status !== 'signup' || now >= round.signup_ends_at) {
                    return this.queueNextHeist(guildId, userId, interactionId, this.heistSchedule(now).nextAt, now);
                }
                const existing = this.db.prepare('SELECT * FROM heist_entries WHERE round_id=? AND user_id=?')
                    .get(round.round_id, userId);
                if (existing) return { alreadyEntered: true, balance: this.member(guildId, userId)?.balance || 0, round };

                const member = this.ensureMember(guildId, userId, now);
                this.assertUsable(member);
                const reserved = this.reserveWager(guildId, userId, HEIST_ENTRY_FEE, interactionId, `heist:${round.round_id}`, now);
                this.db.prepare('INSERT INTO heist_entries(round_id,guild_id,user_id,entry_fee,joined_at) VALUES(?,?,?,?,?)')
                    .run(round.round_id, guildId, userId, HEIST_ENTRY_FEE, now);
                this.db.prepare('UPDATE heist_rounds SET pot=pot+?,entry_fee=? WHERE round_id=?')
                    .run(HEIST_ENTRY_FEE, HEIST_ENTRY_FEE, round.round_id);
                return { alreadyEntered: false, balance: reserved.balance, round: this.heistRound(round.round_id) };
            });
        }

        heistState(guildId, now = Date.now()) {
            const schedule = this.heistSchedule(now);

            const stale = this.db.prepare("SELECT round_id FROM heist_rounds WHERE guild_id=? AND status='signup' AND created_at<? ORDER BY created_at DESC LIMIT 1")
                .get(guildId, schedule.startsAt);
            if (stale) this.resolveHeist(stale.round_id, now);

            let current = this.db.prepare(`SELECT round_id FROM heist_rounds
                WHERE guild_id=? AND created_at>=? AND created_at<?
                ORDER BY created_at DESC LIMIT 1`).get(guildId, schedule.startsAt, schedule.nextAt);

            if (!current) {
                const round = this.createHeistRound(guildId, now);
                current = { round_id: round.round_id };
            }

            let round = this.heistRound(current.round_id);
            if (round.entry_fee !== HEIST_ENTRY_FEE && round.status === 'signup') {
                this.db.prepare('UPDATE heist_rounds SET entry_fee=?,signup_ends_at=? WHERE round_id=?')
                    .run(HEIST_ENTRY_FEE, schedule.signupEndsAt, round.round_id);
                round = this.heistRound(round.round_id);
            }

            if (round.status === 'signup' && now < schedule.signupEndsAt) {
                round = this.transferQueuedEntries(round, now);
                return { phase: 'signup', round, nextAt: schedule.signupEndsAt };
            }
            if (round.status === 'signup') round = this.resolveHeist(round.round_id, schedule.signupEndsAt);
            return { phase: 'cooldown', round, nextAt: schedule.nextAt };
        }

        bossOutcome(round, entries, type) {
            const chance = heistSuccessChance(entries.length);
            const success = this.random() * 100 < chance;
            const rewardPool = success ? scaledReward(entries.length) : 0;
            const story = [
                `${type.emoji} **${type.name}** hits the crew head-on.`,
                `Crew success chance: **${chance.toFixed(1)}%** (${HEIST_BASE_SUCCESS}% base + ${HEIST_SUCCESS_PER_PLAYER}% per player).`,
            ];
            if (success) story.push(`${type.name} goes down. The crew secures **${rewardPool.toLocaleString('en-US')} Blood Money**.`);
            else story.push(`${type.name} wins the fight and the crew loses the entry pot.`);
            return {
                eventType: type.id,
                variant: 'boss',
                success,
                chance,
                rewardPool,
                payouts: success ? equalPayouts(entries, rewardPool) : new Map(),
                story,
            };
        }

        pvpOutcome(round, entries, now = Date.now()) {
            const attackers = new Set(entries.map(entry => entry.user_id));
            const victims = this.db.prepare('SELECT user_id,balance FROM economy_members WHERE guild_id=? AND balance>0 ORDER BY balance DESC')
                .all(round.guild_id)
                .filter(member => !attackers.has(member.user_id));
            if (!victims.length) return this.bossOutcome(round, entries, randomBoss(this.random));

            const victim = victims[Math.floor(this.random() * victims.length)];
            const chance = heistSuccessChance(entries.length);
            const success = this.random() * 100 < chance;
            const percent = 1 + Math.floor(this.random() * 10);
            let stolenAmount = 0;
            const story = [
                `⚔️ **PvP Battle:** the crew targets <@${victim.user_id}>.`,
                `Crew success chance: **${chance.toFixed(1)}%** (${HEIST_BASE_SUCCESS}% base + ${HEIST_SUCCESS_PER_PLAYER}% per player).`,
            ];

            if (success) {
                const liveBalance = Number(this.member(round.guild_id, victim.user_id)?.balance || 0);
                const tenPercentCap = Math.floor(liveBalance * 0.10);
                stolenAmount = Math.min(tenPercentCap, Math.floor(liveBalance * percent / 100));
                if (stolenAmount > 0) {
                    this.applyDelta(round.guild_id, victim.user_id, -stolenAmount, 'heist-robbed', round.round_id, null, now);
                }
                const rewardPool = Math.min(HEIST_MAX_REWARD, scaledReward(entries.length) + stolenAmount);
                story.push(`<@${victim.user_id}> is robbed for **${stolenAmount.toLocaleString('en-US')} Blood Money**. The 10% balance cap is enforced.`);
                story.push(`The crew payout is **${rewardPool.toLocaleString('en-US')} Blood Money**.`);
                return {
                    eventType: 'pvp', variant: 'robbery', success: true, chance,
                    victimId: victim.user_id, stolenAmount, rewardPool,
                    payouts: equalPayouts(entries, rewardPool), story,
                };
            }

            story.push(`<@${victim.user_id}> wins the PvP defense. No balance is taken and the crew loses the entry pot.`);
            return {
                eventType: 'pvp', variant: 'defended-robbery', success: false, chance,
                victimId: victim.user_id, stolenAmount: 0, defenseAmount: 0, rewardPool: 0,
                payouts: new Map(), story,
            };
        }

        resolveHeist(roundId, now = Date.now()) {
            return this.transaction(() => {
                const round = this.heistRound(roundId);
                if (!round || round.status !== 'signup') return round;
                const entries = round.entries || [];
                if (!entries.length) {
                    this.saveOutcome(roundId, {
                        eventType: 'cancelled', variant: 'cancelled', rewardPool: 0,
                        story: ['The heist window closed with nobody signed up.'],
                    });
                    this.db.prepare("UPDATE heist_rounds SET status='cancelled',success=0,payout_total=0,completed_at=? WHERE round_id=?")
                        .run(now, roundId);
                    return this.heistRound(roundId);
                }

                const pvpBuyer = entries.find(entry => this.heistItemQuantity?.(round.guild_id, entry.user_id, 'pvp-contract') > 0);
                let outcome;
                if (pvpBuyer) {
                    this.adjustHeistItem(round.guild_id, pvpBuyer.user_id, 'pvp-contract', -1, now);
                    outcome = this.pvpOutcome(round, entries, now);
                    outcome.story = [`📜 <@${pvpBuyer.user_id}> used a **PvP Contract**.`, ...(outcome.story || [])];
                } else if (this.random() < 0.5) {
                    outcome = this.pvpOutcome(round, entries, now);
                } else {
                    outcome = this.bossOutcome(round, entries, randomBoss(this.random));
                }

                if (this.applyHeistStoreEffects) outcome = this.applyHeistStoreEffects(round, outcome, now);
                outcome = capPayouts(outcome);
                const payoutTotal = this.payAttackers(round, entries, outcome.payouts, now);
                this.saveOutcome(roundId, outcome);
                this.db.prepare("UPDATE heist_rounds SET status='complete',success_chance=?,success=?,payout_total=?,completed_at=? WHERE round_id=?")
                    .run(Math.round(outcome.chance), outcome.success ? 1 : 0, payoutTotal, now, roundId);
                return this.heistRound(roundId);
            });
        }
    }

    economyModule.EconomyService = FourDailyHeistEconomyService;

    const previousCreateIntegration = discordEconomy.createEconomyIntegration;
    discordEconomy.createEconomyIntegration = function createFourDailyHeistIntegration(client, economy, options = {}) {
        const integration = previousCreateIntegration(client, economy, options);
        const previousHandleButton = integration.handleButton;
        const previousStop = integration.stop;
        let timer = null;

        function panelPayload(state) {
            const round = state.round;
            const signup = state.phase === 'signup';
            const players = Number(round?.participantCount || 0);
            const chance = heistSuccessChance(players);
            const reward = scaledReward(Math.max(1, players));
            const description = signup
                ? `A **Boss or PvP heist** is open now. Signup closes <t:${Math.floor(Number(round.signup_ends_at) / 1000)}:R>.`
                : `The next Boss / PvP heist opens <t:${Math.floor(Number(state.nextAt) / 1000)}:R>.`;
            const components = [new Discord.ActionRowBuilder().addComponents(
                ...(signup && round?.round_id ? [
                    new Discord.ButtonBuilder().setCustomId(`econ:heist:join:${round.round_id}`).setLabel('Join Heist · 100K').setEmoji('⚔️').setStyle(Discord.ButtonStyle.Danger),
                    new Discord.ButtonBuilder().setCustomId(`econ:heist:status:${round.round_id}`).setLabel('My Entry').setStyle(Discord.ButtonStyle.Secondary),
                ] : []),
                new Discord.ButtonBuilder().setCustomId('econ:heist:notify').setLabel('Ping Me for Heists').setEmoji('🔔').setStyle(Discord.ButtonStyle.Secondary),
            )];
            return {
                embeds: [new Discord.EmbedBuilder()
                    .setColor(signup ? 0x9b1c31 : 0x6f42c1)
                    .setTitle(signup ? '⚔️ Boss / PvP Heist · Entry Open' : '⚔️ Boss / PvP Heist · Stand By')
                    .setDescription(description)
                    .addFields(
                        { name: 'Entry', value: `100,000 ${economy.config.currencyName}`, inline: true },
                        { name: 'Players', value: signup ? `${players} joined` : 'Signup closed', inline: true },
                        { name: 'Current reward', value: `${reward.toLocaleString('en-US')} ${economy.config.currencyName}`, inline: true },
                        { name: 'Reward scaling', value: '150K per player · 1,000,000 maximum total payout', inline: false },
                        { name: 'Success rate', value: signup ? `${chance.toFixed(1)}% now · 66% base + 1.5% per player` : '66% base + 1.5% per player', inline: false },
                        { name: 'Schedule', value: '4 heists/day · 3 AM · 9 AM · 3 PM · 9 PM Eastern', inline: false },
                        { name: 'Battles', value: 'Every heist is either a **Boss Battle** or **PvP Battle**.', inline: false },
                        { name: 'Heist pings', value: 'Opt-in reminders are sent at **9 AM and 9 PM Eastern only**.', inline: false },
                    )
                    .setFooter({ text: 'Persistent heist panel · 100K entry · PvP balance theft capped at 10%' })
                    .setTimestamp()],
                components,
            };
        }

        async function refreshPanel(guild) {
            const channel = guild.channels.cache.get(HEIST_CHANNEL_ID) || await guild.channels.fetch(HEIST_CHANNEL_ID).catch(() => null);
            if (!channel?.isTextBased()) return null;
            const state = economy.heistState(guild.id);
            let panelId = economy.setting(guild.id, 'heist_panel_message');
            let panel = panelId ? await channel.messages.fetch(panelId).catch(() => null) : null;
            if (!panel) {
                panel = await channel.send(panelPayload(state));
                economy.setSetting(guild.id, 'heist_panel_message', panel.id);
            } else {
                await panel.edit(panelPayload(state)).catch(() => {});
            }
            return panel;
        }

        async function sendScheduledReminder(guild) {
            const slot = reminderSlot();
            if (!slot || economy.setting(guild.id, REMINDER_SLOT_SETTING) === slot) return;
            const state = economy.heistState(guild.id);
            if (state.phase !== 'signup') return;

            let roleId = economy.setting(guild.id, 'heist_alert_role_id');
            let role = roleId ? await guild.roles.fetch(roleId).catch(() => null) : null;
            if (!role) {
                const roles = await guild.roles.fetch().catch(() => guild.roles.cache);
                role = [...roles.values()].find(item => String(item.name || '').toLowerCase() === 'heist') || null;
                if (role) {
                    roleId = role.id;
                    economy.setSetting(guild.id, 'heist_alert_role_id', roleId);
                }
            }
            if (!role) return;

            const channel = guild.channels.cache.get(HEIST_CHANNEL_ID) || await guild.channels.fetch(HEIST_CHANNEL_ID).catch(() => null);
            if (!channel?.isTextBased()) return;
            const message = await channel.send({
                content: `<@&${role.id}> 🔔 **A new heist has started.** Entry is **100,000 ${economy.config.currencyName}**. This round is a **Boss or PvP battle**. Signup closes <t:${Math.floor(Number(state.round.signup_ends_at) / 1000)}:R>.`,
                allowedMentions: { roles: [role.id] },
            }).catch(() => null);
            if (message) economy.setSetting(guild.id, REMINDER_SLOT_SETTING, slot);
        }

        integration.handleButton = async interaction => {
            if (interaction.isButton?.() && interaction.customId.startsWith('econ:heist:join:')) {
                try {
                    const minimumAge = Number(economy.config.minimumAccountAgeDays || 0);
                    if (Date.now() - interaction.user.createdTimestamp < minimumAge * 86400000) {
                        throw new Error(`Your Discord account must be at least ${minimumAge} days old.`);
                    }
                    const roundId = interaction.customId.split(':').at(-1);
                    const result = economy.joinHeist(interaction.guild.id, interaction.user.id, roundId, interaction.id);
                    if (result.queued) {
                        const text = result.alreadyQueued
                            ? `⏭️ You are already queued for the next heist <t:${Math.floor(result.targetStart / 1000)}:R>.`
                            : `⏭️ Signup is closing, so your **100,000 ${economy.config.currencyName}** entry was reserved for the next heist <t:${Math.floor(result.targetStart / 1000)}:R>. Balance: **${Number(result.balance || 0).toLocaleString('en-US')}**.`;
                        await interaction.reply({ content: text, ephemeral: true });
                    } else if (result.alreadyEntered) {
                        await interaction.reply({ content: 'You are already entered in this heist.', ephemeral: true });
                    } else {
                        await interaction.reply({ content: `⚔️ You entered the heist for **100,000 ${economy.config.currencyName}**. Balance: **${Number(result.balance || 0).toLocaleString('en-US')}**.`, ephemeral: true });
                    }
                    await refreshPanel(interaction.guild);
                } catch (error) {
                    await interaction.reply({ content: `❌ ${error.message}`, ephemeral: true }).catch(() => {});
                }
                return true;
            }

            const handled = await previousHandleButton(interaction);
            if (handled && interaction.isButton?.() && interaction.customId === 'econ:heist:notify' && interaction.replied) {
                const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
                const roleId = economy.setting(interaction.guild.id, 'heist_alert_role_id');
                const enabled = Boolean(member && roleId && member.roles.cache.has(roleId));
                await interaction.editReply({
                    content: enabled
                        ? '🔔 Heist pings are **on**. The `heist` role is pinged at **9 AM and 9 PM Eastern** only.'
                        : '🔕 Heist pings are now **off** for you.',
                }).catch(() => {});
            }
            return handled;
        };

        const start = () => {
            const run = () => {
                for (const guild of client.guilds.cache.values()) {
                    refreshPanel(guild).catch(error => console.error(`Four-daily heist panel error in ${guild.name}:`, error.message));
                    sendScheduledReminder(guild).catch(error => console.error(`Scheduled heist reminder error in ${guild.name}:`, error.message));
                }
            };
            run();
            timer = setInterval(run, 5_000);
            timer.unref?.();
        };
        if (client.isReady?.()) start(); else client.once('ready', start);

        integration.updateHeistPanel = async guild => refreshPanel(guild);
        integration.stop = async (...args) => {
            if (timer) clearInterval(timer);
            return previousStop?.(...args);
        };
        return integration;
    };
}

module.exports = {
    EASTERN_TIME_ZONE,
    HEIST_BASE_REWARD,
    HEIST_BASE_SUCCESS,
    HEIST_ENTRY_FEE,
    HEIST_LOCAL_HOURS,
    HEIST_MAX_REWARD,
    HEIST_SUCCESS_PER_PLAYER,
    fourDailySchedule,
    heistSuccessChance,
    installFourDailyHeists,
    scaledReward,
};
