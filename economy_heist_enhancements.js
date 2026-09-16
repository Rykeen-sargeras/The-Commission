'use strict';

const Discord = require('discord.js');
const economyModule = require('./economy');
const discordEconomy = require('./economy_discord');
const {
    HEIST_ENTRY_FEE,
    HEIST_INTERVAL_MS,
    HEIST_SIGNUP_MS,
    HEIST_TYPES,
    pickHeistType,
} = require('./economy_special_events');

const HEIST_ALERT_ROLE_NAME = 'heist';
const HEIST_ALERT_COOLDOWN_MS = 60 * 60 * 1000;
const LATE_JOIN_WINDOW_MS = 3 * 60 * 1000;
const BOSS_EXTRA_SIGNUP_MS = 5 * 60 * 1000;
const PERSONAL_LOOT_MULTIPLIER = 1.25;
const CREW_LOOT_BONUS = 0.25;
const MAX_CREW_LOOT_BONUS = 1.0;
const PERSONAL_LOOT_USES = 3;

const HEIST_STORE_ITEMS = Object.freeze({
    'hot-tip': Object.freeze({
        key: 'hot-tip',
        name: 'Hot Tip',
        cost: 25_000,
        quantity: PERSONAL_LOOT_USES,
        description: '+25% personal heist payout for your next 3 completed heists.',
    }),
    'loaded-van': Object.freeze({
        key: 'loaded-van',
        name: 'Loaded Getaway Van',
        cost: 75_000,
        quantity: 1,
        description: '+25% crew reward pool on your next heist. Multiple crew boosts stack up to +100%.',
    }),
    'pvp-contract': Object.freeze({
        key: 'pvp-contract',
        name: 'PvP Contract',
        cost: 50_000,
        quantity: 1,
        description: 'Forces your next eligible 2+ player heist into a PvP robbery encounter.',
    }),
});

function installHeistEnhancements() {
    const BaseEconomyService = economyModule.EconomyService;

    class EnhancedHeistEconomyService extends BaseEconomyService {
        constructor(options = {}) {
            super(options);
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS special_heist_plans (
                    round_id TEXT PRIMARY KEY,
                    event_type TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY(round_id) REFERENCES heist_rounds(round_id)
                );
                CREATE TABLE IF NOT EXISTS special_heist_queue (
                    guild_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    target_start INTEGER NOT NULL,
                    entry_fee INTEGER NOT NULL,
                    queued_at INTEGER NOT NULL,
                    interaction_id TEXT NOT NULL DEFAULT '',
                    PRIMARY KEY(guild_id, user_id)
                );
                CREATE TABLE IF NOT EXISTS heist_store_inventory (
                    guild_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    item_key TEXT NOT NULL,
                    quantity INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY(guild_id, user_id, item_key)
                );
            `);
        }

        heistStoreStatus(guildId, userId, now = Date.now()) {
            this.ensureMember(guildId, userId, now);
            const rows = this.db.prepare('SELECT item_key,quantity FROM heist_store_inventory WHERE guild_id=? AND user_id=?')
                .all(guildId, userId);
            const inventory = Object.fromEntries(rows.map(row => [row.item_key, Number(row.quantity || 0)]));
            return { inventory, balance: this.member(guildId, userId).balance };
        }

        heistItemQuantity(guildId, userId, itemKey) {
            return Number(this.db.prepare('SELECT quantity FROM heist_store_inventory WHERE guild_id=? AND user_id=? AND item_key=?')
                .get(guildId, userId, itemKey)?.quantity || 0);
        }

        adjustHeistItem(guildId, userId, itemKey, delta, now = Date.now()) {
            const current = this.heistItemQuantity(guildId, userId, itemKey);
            const quantity = Math.max(0, current + Number(delta || 0));
            this.db.prepare(`INSERT INTO heist_store_inventory(guild_id,user_id,item_key,quantity,updated_at)
                VALUES(?,?,?,?,?) ON CONFLICT(guild_id,user_id,item_key)
                DO UPDATE SET quantity=excluded.quantity,updated_at=excluded.updated_at`)
                .run(guildId, userId, itemKey, quantity, now);
            return quantity;
        }

        buyHeistStoreItem(guildId, userId, itemKey, interactionId, now = Date.now()) {
            const item = HEIST_STORE_ITEMS[itemKey];
            if (!item) throw new Error('Unknown heist-store item.');
            return this.transaction(() => {
                const member = this.ensureMember(guildId, userId, now);
                this.assertUsable(member);
                if (member.balance < item.cost) throw new Error(`You need ${item.cost.toLocaleString('en-US')} ${this.config.currencyName} for ${item.name}.`);
                const balance = this.applyDelta(guildId, userId, -item.cost, 'heist-store-purchase', item.key, interactionId, now);
                const quantity = this.adjustHeistItem(guildId, userId, item.key, item.quantity, now);
                return { item, quantity, balance, ...this.heistStoreStatus(guildId, userId, now) };
            });
        }

        heistPlan(roundId) {
            return this.db.prepare('SELECT * FROM special_heist_plans WHERE round_id=?').get(roundId) || null;
        }

        ensureHeistPlan(round) {
            if (!round) return null;
            let plan = this.heistPlan(round.round_id);
            if (!plan) {
                const type = pickHeistType(this.random);
                this.db.prepare('INSERT INTO special_heist_plans(round_id,event_type,created_at) VALUES(?,?,?)')
                    .run(round.round_id, type.id, Date.now());
                plan = this.heistPlan(round.round_id);
                if (type.id !== 'normal') {
                    const bossEndsAt = round.created_at + HEIST_SIGNUP_MS + BOSS_EXTRA_SIGNUP_MS;
                    if (round.signup_ends_at < bossEndsAt) {
                        this.db.prepare('UPDATE heist_rounds SET signup_ends_at=? WHERE round_id=?')
                            .run(bossEndsAt, round.round_id);
                    }
                }
            }
            return plan;
        }

        heistRound(roundId) {
            const round = super.heistRound(roundId);
            if (!round) return null;
            const plan = this.heistPlan(roundId);
            return { ...round, plannedEventType: plan?.event_type || '' };
        }

        createHeistRound(guildId, now = Date.now()) {
            const round = super.createHeistRound(guildId, now);
            this.ensureHeistPlan(round);
            return this.heistRound(round.round_id);
        }

        queuedHeistEntry(guildId, userId) {
            return this.db.prepare('SELECT * FROM special_heist_queue WHERE guild_id=? AND user_id=?').get(guildId, userId) || null;
        }

        transferQueuedEntries(round, now = Date.now()) {
            if (!round || round.status !== 'signup') return round;
            const queued = this.db.prepare('SELECT * FROM special_heist_queue WHERE guild_id=? AND target_start<=? ORDER BY queued_at')
                .all(round.guild_id, round.created_at);
            if (!queued.length) return round;

            for (const entry of queued) {
                const alreadyEntered = this.db.prepare('SELECT 1 FROM heist_entries WHERE round_id=? AND user_id=?').get(round.round_id, entry.user_id);
                if (alreadyEntered) {
                    if (entry.entry_fee > 0) this.applyDelta(round.guild_id, entry.user_id, entry.entry_fee, 'heist-queue-refund', round.round_id, null, now);
                } else {
                    this.db.prepare('INSERT INTO heist_entries(round_id,guild_id,user_id,entry_fee,joined_at) VALUES(?,?,?,?,?)')
                        .run(round.round_id, round.guild_id, entry.user_id, entry.entry_fee, now);
                    this.db.prepare('UPDATE heist_rounds SET pot=pot+? WHERE round_id=?').run(entry.entry_fee, round.round_id);
                }
                this.db.prepare('DELETE FROM special_heist_queue WHERE guild_id=? AND user_id=?').run(round.guild_id, entry.user_id);
            }
            return this.heistRound(round.round_id);
        }

        queueNextHeist(guildId, userId, interactionId, targetStart, now = Date.now()) {
            return this.transaction(() => {
                const existing = this.queuedHeistEntry(guildId, userId);
                if (existing) {
                    return { queued: true, alreadyQueued: true, targetStart: existing.target_start, balance: this.member(guildId, userId)?.balance || 0 };
                }
                const reserved = this.reserveWager(guildId, userId, HEIST_ENTRY_FEE, interactionId, `heist-queue:${targetStart}`, now);
                this.db.prepare(`INSERT INTO special_heist_queue(guild_id,user_id,target_start,entry_fee,queued_at,interaction_id)
                    VALUES(?,?,?,?,?,?)`).run(guildId, userId, targetStart, HEIST_ENTRY_FEE, now, interactionId || '');
                return { queued: true, alreadyQueued: false, targetStart, balance: reserved.balance };
            });
        }

        heistState(guildId, now = Date.now()) {
            const schedule = this.heistSchedule(now);
            let active = this.db.prepare("SELECT round_id FROM heist_rounds WHERE guild_id=? AND status='signup' ORDER BY created_at DESC LIMIT 1").get(guildId);
            if (active) {
                let round = this.heistRound(active.round_id);
                this.ensureHeistPlan(round);
                round = this.heistRound(active.round_id);
                if (round.created_at < schedule.startsAt || now >= round.signup_ends_at) {
                    round = this.resolveHeist(round.round_id, Math.max(round.signup_ends_at, now));
                } else {
                    round = this.transferQueuedEntries(round, now);
                    return { phase: 'signup', round, nextAt: round.signup_ends_at };
                }
            }

            let current = this.db.prepare(`SELECT round_id FROM heist_rounds WHERE guild_id=? AND created_at>=? AND created_at<?
                ORDER BY created_at DESC LIMIT 1`).get(guildId, schedule.startsAt, schedule.nextAt);
            if (!current) {
                let round = this.createHeistRound(guildId, now);
                round = this.transferQueuedEntries(round, now);
                if (now < round.signup_ends_at) return { phase: 'signup', round, nextAt: round.signup_ends_at };
                current = { round_id: this.resolveHeist(round.round_id, round.signup_ends_at).round_id };
            }

            let round = this.heistRound(current.round_id);
            this.ensureHeistPlan(round);
            round = this.heistRound(current.round_id);
            if (round.status === 'signup' && now < round.signup_ends_at) {
                round = this.transferQueuedEntries(round, now);
                return { phase: 'signup', round, nextAt: round.signup_ends_at };
            }
            if (round.status === 'signup') round = this.resolveHeist(round.round_id, round.signup_ends_at);
            return { phase: 'cooldown', round, nextAt: schedule.nextAt };
        }

        joinHeist(guildId, userId, roundId, interactionId, now = Date.now()) {
            const state = this.heistState(guildId, now);
            const remaining = state.phase === 'signup' ? state.round.signup_ends_at - now : 0;

            if (state.phase === 'signup' && remaining > LATE_JOIN_WINDOW_MS) {
                return super.joinHeist(guildId, userId, state.round.round_id, interactionId, now);
            }

            const targetStart = state.phase === 'signup'
                ? this.heistSchedule(now).nextAt
                : state.nextAt;
            return this.queueNextHeist(guildId, userId, interactionId, targetStart, now);
        }

        applyHeistStoreEffects(round, outcome, now = Date.now()) {
            const entries = round.entries || [];
            const crewBoosters = entries.filter(entry => this.heistItemQuantity(round.guild_id, entry.user_id, 'loaded-van') > 0);
            if (crewBoosters.length) {
                const bonus = Math.min(MAX_CREW_LOOT_BONUS, crewBoosters.length * CREW_LOOT_BONUS);
                for (const [userId, payout] of outcome.payouts.entries()) {
                    outcome.payouts.set(userId, Math.floor(payout * (1 + bonus)));
                }
                outcome.rewardPool = Math.floor(Number(outcome.rewardPool || 0) * (1 + bonus));
                outcome.story = [...(outcome.story || []), `🚐 Loaded Getaway Van boost: crew loot increased by **${Math.round(bonus * 100)}%**.`];
                crewBoosters.forEach(entry => this.adjustHeistItem(round.guild_id, entry.user_id, 'loaded-van', -1, now));
            }

            for (const entry of entries) {
                const uses = this.heistItemQuantity(round.guild_id, entry.user_id, 'hot-tip');
                if (uses <= 0) continue;
                const payout = Number(outcome.payouts.get(entry.user_id) || 0);
                if (payout > 0) outcome.payouts.set(entry.user_id, Math.floor(payout * PERSONAL_LOOT_MULTIPLIER));
                this.adjustHeistItem(round.guild_id, entry.user_id, 'hot-tip', -1, now);
            }
            return outcome;
        }

        resolveHeist(roundId, now = Date.now()) {
            return this.transaction(() => {
                const round = this.heistRound(roundId);
                if (!round || round.status !== 'signup') return round;
                const entries = round.entries;
                if (entries.length === 0) {
                    this.saveOutcome(roundId, { eventType: 'cancelled', variant: 'cancelled', rewardPool: round.pot, story: ['The mystery job is called off because nobody joined.'] });
                    this.db.prepare("UPDATE heist_rounds SET status='cancelled',success=0,payout_total=?,completed_at=? WHERE round_id=?")
                        .run(round.pot, now, roundId);
                    return this.heistRound(roundId);
                }

                let outcome;
                if (entries.length === 1) {
                    outcome = this.soloOutcome(round, entries[0]);
                } else {
                    const pvpBuyer = entries.find(entry => this.heistItemQuantity(round.guild_id, entry.user_id, 'pvp-contract') > 0);
                    if (pvpBuyer) {
                        this.adjustHeistItem(round.guild_id, pvpBuyer.user_id, 'pvp-contract', -1, now);
                        outcome = this.robberyOutcome(round, entries, now);
                        outcome.story = [`📜 <@${pvpBuyer.user_id}> cashed in a **PvP Contract** and forced a robbery battle.`, ...(outcome.story || [])];
                    } else {
                        const planned = this.heistPlan(roundId)?.event_type || 'normal';
                        const type = HEIST_TYPES.find(item => item.id === planned) || HEIST_TYPES.find(item => item.id === 'normal');
                        outcome = type.id !== 'normal'
                            ? this.bossOutcome(round, entries, type)
                            : (this.random() < 0.5 ? this.deathmatchOutcome(round, entries) : this.robberyOutcome(round, entries, now));
                    }
                }

                outcome = this.applyHeistStoreEffects(round, outcome, now);
                const payoutTotal = this.payAttackers(round, entries, outcome.payouts, now);
                this.saveOutcome(roundId, outcome);
                this.db.prepare("UPDATE heist_rounds SET status='complete',success_chance=?,success=?,payout_total=?,completed_at=? WHERE round_id=?")
                    .run(Math.round(outcome.chance), outcome.success ? 1 : 0, payoutTotal, now, roundId);
                return this.heistRound(roundId);
            });
        }
    }

    economyModule.EconomyService = EnhancedHeistEconomyService;

    const previousCreateIntegration = discordEconomy.createEconomyIntegration;
    discordEconomy.createEconomyIntegration = function createEnhancedHeistIntegration(client, economy, options = {}) {
        const integration = previousCreateIntegration(client, economy, options);
        const previousHandleButton = integration.handleButton;
        const previousStop = integration.stop;
        let alertButtonTimer = null;

        async function ensureAlertRole(guild) {
            const roles = await guild.roles.fetch().catch(() => guild.roles.cache);
            const role = [...roles.values()].find(item => item.name.toLowerCase() === HEIST_ALERT_ROLE_NAME) || null;
            if (!role) throw new Error('The Discord role **heist** could not be found. Create it or restore it before using heist pings.');
            if (economy.setting(guild.id, 'heist_alert_role_id') !== role.id) economy.setSetting(guild.id, 'heist_alert_role_id', role.id);
            return role;
        }

        async function addAlertButton(guild) {
            const channel = await guild.channels.fetch(economy.config.heistChannelId).catch(() => null);
            if (!channel?.isTextBased()) return;
            const panelId = economy.setting(guild.id, 'heist_panel_message');
            if (!panelId) return;
            const panel = await channel.messages.fetch(panelId).catch(() => null);
            if (!panel) return;
            const rows = panel.components.map(row => Discord.ActionRowBuilder.from(row));
            const alreadyPresent = rows.some(row => row.components.some(component => component.data?.custom_id === 'econ:heist:notify'));
            if (alreadyPresent) return;
            const button = new Discord.ButtonBuilder().setCustomId('econ:heist:notify').setLabel('Ping Me for Heists').setEmoji('🔔').setStyle(Discord.ButtonStyle.Secondary);
            if (!rows.length) rows.push(new Discord.ActionRowBuilder());
            const target = rows.find(row => row.components.length < 5) || new Discord.ActionRowBuilder();
            if (!rows.includes(target)) rows.push(target);
            target.addComponents(button);
            await panel.edit({ components: rows }).catch(() => {});
        }

        async function maybePingHeistRole(guild, state) {
            if (state.phase !== 'signup') return;
            if (economy.setting(guild.id, 'special_heist_last_ping_round') === state.round.round_id) return;
            const lastPingAt = Number(economy.setting(guild.id, 'special_heist_last_ping_at') || 0);
            if (Date.now() - lastPingAt < HEIST_ALERT_COOLDOWN_MS) return;

            const role = await ensureAlertRole(guild).catch(() => null);
            if (!role) return;
            const channel = await guild.channels.fetch(economy.config.heistChannelId).catch(() => null);
            if (!channel?.isTextBased()) return;

            const planned = HEIST_TYPES.find(type => type.id === state.round.plannedEventType);
            const isBoss = planned && planned.id !== 'normal';
            const text = isBoss
                ? `<@&${role.id}> 🚨 **Boss encounter started: ${planned.emoji} ${planned.name}!** Signup is extended by 5 minutes.`
                : `<@&${role.id}> 🎭 **A new heist has started.** Join the crew before entry closes.`;
            await channel.send({ content: text, allowedMentions: { roles: [role.id] } }).catch(() => {});
            economy.setSetting(guild.id, 'special_heist_last_ping_round', state.round.round_id);
            economy.setSetting(guild.id, 'special_heist_last_ping_at', String(Date.now()));
        }

        async function enhanceGuild(guild) {
            const state = economy.heistState(guild.id);
            await maybePingHeistRole(guild, state);
            await addAlertButton(guild);
        }

        integration.handleButton = async interaction => {
            if (interaction.isButton?.() && interaction.customId === 'econ:heist:notify') {
                try {
                    const role = await ensureAlertRole(interaction.guild);
                    const member = await interaction.guild.members.fetch(interaction.user.id);
                    if (member.roles.cache.has(role.id)) {
                        await member.roles.remove(role, 'User disabled heist alerts');
                        await interaction.reply({ content: '🔕 Heist pings are now **off** for you.', ephemeral: true });
                    } else {
                        await member.roles.add(role, 'User enabled heist alerts');
                        await interaction.reply({ content: '🔔 Heist pings are now **on** for you. You now have the **heist** role. The bot will ping it no more than once per hour.', ephemeral: true });
                    }
                } catch (error) {
                    await interaction.reply({ content: `❌ ${error.message}`, ephemeral: true }).catch(() => {});
                }
                return true;
            }

            if (interaction.isButton?.() && interaction.customId.startsWith('econ:heist:join:')) {
                try {
                    const minimumAge = Number(economy.config.minimumAccountAgeDays || 0);
                    if (Date.now() - interaction.user.createdTimestamp < minimumAge * 86400000) {
                        throw new Error(`Your Discord account must be at least ${minimumAge} days old.`);
                    }
                    const roundId = interaction.customId.split(':').at(-1);
                    const result = economy.joinHeist(interaction.guild.id, interaction.user.id, roundId, interaction.id);
                    if (result.queued) {
                        const message = result.alreadyQueued
                            ? `⏭️ You are already queued for the next heist, opening <t:${Math.floor(result.targetStart / 1000)}:R>.`
                            : `⏭️ This heist is within 3 minutes of closing (or already closed), so your **${HEIST_ENTRY_FEE.toLocaleString('en-US')} ${economy.config.currencyName}** entry was reserved for the next heist <t:${Math.floor(result.targetStart / 1000)}:R>. Balance: **${result.balance.toLocaleString('en-US')}**.`;
                        await interaction.reply({ content: message, ephemeral: true });
                    } else if (result.alreadyEntered) {
                        await interaction.reply({ content: 'You are already entered in this heist.', ephemeral: true });
                    } else {
                        await interaction.reply({ content: `🔫 You entered the heist for **${HEIST_ENTRY_FEE.toLocaleString('en-US')} ${economy.config.currencyName}**. Balance: **${result.balance.toLocaleString('en-US')}**.`, ephemeral: true });
                    }
                    await integration.updateHeistPanel?.(interaction.guild).catch(() => {});
                    await addAlertButton(interaction.guild);
                } catch (error) {
                    await interaction.reply({ content: `❌ ${error.message}`, ephemeral: true }).catch(() => {});
                }
                return true;
            }

            const handled = await previousHandleButton(interaction);
            if (handled && interaction.customId?.startsWith('econ:heist:')) {
                await addAlertButton(interaction.guild).catch(() => {});
            }
            return handled;
        };

        const startEnhancer = () => {
            const refresh = () => {
                for (const guild of client.guilds.cache.values()) enhanceGuild(guild).catch(error => console.error(`Heist enhancement error in ${guild.name}:`, error.message));
            };
            refresh();
            alertButtonTimer = setInterval(refresh, 5_000);
        };
        if (client.isReady?.()) startEnhancer(); else client.once('ready', startEnhancer);

        integration.stop = async () => {
            if (alertButtonTimer) clearInterval(alertButtonTimer);
            return previousStop();
        };
        return integration;
    };
}

module.exports = {
    BOSS_EXTRA_SIGNUP_MS,
    HEIST_ALERT_COOLDOWN_MS,
    HEIST_ALERT_ROLE_NAME,
    HEIST_STORE_ITEMS,
    LATE_JOIN_WINDOW_MS,
    installHeistEnhancements,
};
