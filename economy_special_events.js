'use strict';

const Discord = require('discord.js');
const economyModule = require('./economy');
const discordEconomy = require('./economy_discord');

const HEIST_CHANNEL_ID = '1547079010637578301';
const HEIST_ENTRY_FEE = 10_000;
const HEIST_INTERVAL_MS = 30 * 60 * 1000;
const HEIST_SIGNUP_MS = (9 * 60 + 30) * 1000;
const MAX_ROBBERY_PERCENT = 10;

// The requested ratios total slightly over 100%, so preserve their relationship
// and normalize them at selection time.
const HEIST_TYPES = Object.freeze([
    Object.freeze({ id: 'gidgyzilla', name: 'Gidgyzilla', emoji: '🦖', weight: 1 / 5, bossPool: 350_000 }),
    Object.freeze({ id: 'scooter-rat', name: 'Scooter Rat', emoji: '🐀', weight: 2 / 11, bossPool: 275_000 }),
    Object.freeze({ id: 'gnomestar', name: 'Gnomestar', emoji: '🧙', weight: 1 / 8, bossPool: 225_000 }),
    Object.freeze({ id: 'normal', name: 'Normal Heist', emoji: '🔫', weight: 1 / 2, bossPool: 0 }),
]);

const BOSS_STORIES = Object.freeze({
    gidgyzilla: ['The pavement splits as Gidgyzilla rises over the city.', 'The crew combines its firepower and aims for the glowing weak point.'],
    'scooter-rat': ['A chrome scooter screams around the corner. Scooter Rat is at the handlebars.', 'The crew closes ranks before the rat can escape with the vault keys.'],
    gnomestar: ['The lights flicker and Gnomestar steps out of a cloud of cursed glitter.', 'The crew pushes forward together while the boss bends luck against them.'],
});

const money = value => Number(value || 0).toLocaleString('en-US');

function randomInt(minimum, maximum, random = Math.random) {
    const low = Math.ceil(minimum);
    const high = Math.floor(maximum);
    return high <= low ? low : low + Math.floor(random() * (high - low + 1));
}

function shuffled(entries, random = Math.random) {
    const result = [...entries];
    for (let index = result.length - 1; index > 0; index -= 1) {
        const other = Math.floor(random() * (index + 1));
        [result[index], result[other]] = [result[other], result[index]];
    }
    return result;
}

function pickHeistType(random = Math.random) {
    const total = HEIST_TYPES.reduce((sum, type) => sum + type.weight, 0);
    let roll = Math.min(0.999999999, Math.max(0, random())) * total;
    for (const type of HEIST_TYPES) {
        roll -= type.weight;
        if (roll < 0) return type;
    }
    return HEIST_TYPES.at(-1);
}

function pickWinners(entries, random = Math.random) {
    if (entries.length <= 1) return [...entries];
    const minimum = Math.max(1, Math.ceil(entries.length * 0.35));
    const maximum = Math.max(minimum, Math.min(entries.length - 1, Math.ceil(entries.length * 0.75)));
    return shuffled(entries, random).slice(0, randomInt(minimum, maximum, random));
}

function distributePool(pool, winners) {
    const payouts = new Map();
    if (!winners.length || pool <= 0) return payouts;
    const totalWeight = winners.reduce((sum, _, index) => sum + winners.length - index, 0);
    let paid = 0;
    winners.forEach((winner, index) => {
        const payout = index === winners.length - 1
            ? pool - paid
            : Math.floor(pool * (winners.length - index) / totalWeight);
        paid += payout;
        payouts.set(winner.user_id, payout);
    });
    return payouts;
}

function shouldAnnounceHeistResult(state) {
    if (!state || state.phase === 'signup') return false;
    return state.round?.status !== 'cancelled' || Number(state.round?.participantCount || 0) > 0;
}

function installSpecialEconomyEvents() {
    const BaseEconomyService = economyModule.EconomyService;

    class SpecialEconomyService extends BaseEconomyService {
        constructor(options = {}) {
            super(options);
            Object.assign(this.config, {
                heistChannelId: HEIST_CHANNEL_ID,
                heistEntryFee: HEIST_ENTRY_FEE,
                heistEntryMinutes: 9,
                heistCooldownMinutes: 20,
                heistMinimumPlayers: 2,
                gamblingDailyWagerCap: 0,
                gamblingHourlyWagerCap: 0,
                gamblingMaxActionsPerMinute: 0,
                gamblingMaxActionsPerHour: 0,
                blackjackMaximumWager: 0,
                blackjackDailyCap: 0,
                pokerMaximumWager: 0,
                pokerDailyCap: 0,
            });
            this.db.exec(`CREATE TABLE IF NOT EXISTS special_heist_outcomes (
                round_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, variant TEXT NOT NULL DEFAULT '',
                victim_id TEXT NOT NULL DEFAULT '', stolen_amount INTEGER NOT NULL DEFAULT 0,
                defense_amount INTEGER NOT NULL DEFAULT 0, reward_pool INTEGER NOT NULL DEFAULT 0,
                story_json TEXT NOT NULL DEFAULT '[]',
                FOREIGN KEY(round_id) REFERENCES heist_rounds(round_id)
            )`);
        }

        // No daily, hourly, per-game, action-count, or percentage cap. A player
        // can wager any positive amount that exists in their balance.
        reserveWager(guildId, userId, wager, interactionId, related, now = Date.now()) {
            const amount = Math.max(0, Number.parseInt(wager, 10) || 0);
            const row = this.ensureMember(guildId, userId, now);
            this.assertUsable(row);
            if (!this.config.gamblingEnabled) throw new Error('Gambling is currently disabled.');
            if (amount < 1) throw new Error('Wager must be at least 1.');
            if (amount > row.balance) throw new Error(`You only have ${money(row.balance)} ${this.config.currencyName}.`);
            const balance = this.applyDelta(guildId, userId, -amount, 'wager', related, interactionId, now);
            this.db.prepare(`UPDATE economy_members SET lifetime_wagered=lifetime_wagered+?,daily_wagered=daily_wagered+?
                WHERE guild_id=? AND user_id=?`).run(amount, amount, guildId, userId);
            return { amount, balance };
        }

        diceMaximumWager() { return null; }

        startProgressiveWager(guildId, userId, wager, interactionId, related, now = Date.now()) {
            return { ...this.reserveWager(guildId, userId, wager, interactionId, related, now), maximumWager: null };
        }

        heistSchedule(now = Date.now()) {
            const startsAt = Math.floor(now / HEIST_INTERVAL_MS) * HEIST_INTERVAL_MS;
            return { startsAt, signupEndsAt: startsAt + HEIST_SIGNUP_MS, nextAt: startsAt + HEIST_INTERVAL_MS };
        }

        heistRound(roundId) {
            const round = super.heistRound(roundId);
            if (!round) return null;
            const outcome = this.db.prepare('SELECT * FROM special_heist_outcomes WHERE round_id=?').get(roundId);
            return {
                ...round,
                eventType: outcome?.event_type || '', variant: outcome?.variant || '',
                victimId: outcome?.victim_id || '', stolenAmount: outcome?.stolen_amount || 0,
                defenseAmount: outcome?.defense_amount || 0, rewardPool: outcome?.reward_pool || 0,
                story: outcome ? JSON.parse(outcome.story_json || '[]') : [],
            };
        }

        saveOutcome(roundId, outcome) {
            this.db.prepare(`INSERT OR REPLACE INTO special_heist_outcomes
                (round_id,event_type,variant,victim_id,stolen_amount,defense_amount,reward_pool,story_json)
                VALUES(?,?,?,?,?,?,?,?)`).run(
                roundId, outcome.eventType, outcome.variant || '', outcome.victimId || '',
                outcome.stolenAmount || 0, outcome.defenseAmount || 0, outcome.rewardPool || 0,
                JSON.stringify(outcome.story || []),
            );
        }

        payAttackers(round, entries, payouts, now) {
            let total = 0;
            for (const entry of entries) {
                const payout = payouts.get(entry.user_id) || 0;
                total += payout;
                if (payout) this.applyDelta(round.guild_id, entry.user_id, payout, 'heist-payout', round.round_id, null, now);
                this.db.prepare('UPDATE heist_entries SET payout=? WHERE round_id=? AND user_id=?').run(payout, round.round_id, entry.user_id);
                this.db.prepare(`UPDATE economy_members SET lifetime_won=lifetime_won+?,lifetime_lost=lifetime_lost+?,
                    gambling_wins=gambling_wins+?,gambling_losses=gambling_losses+? WHERE guild_id=? AND user_id=?`)
                    .run(payout, payout ? 0 : entry.entry_fee, payout ? 1 : 0, payout ? 0 : 1, round.guild_id, entry.user_id);
            }
            return total;
        }

        bossOutcome(round, entries, type) {
            const chance = Math.min(90, 48 + Math.max(0, entries.length - 1) * 6);
            const success = this.random() * 100 < chance;
            const story = [...BOSS_STORIES[type.id]];
            if (!success) {
                story.push(`${type.name} breaks the crew's formation and escapes with the entry pot.`);
                return { eventType: type.id, variant: 'boss', success, chance, rewardPool: 0, payouts: new Map(), story };
            }
            const rewardPool = type.bossPool + Math.floor(round.pot * randomInt(75, 150, this.random) / 100);
            const winners = pickWinners(entries, this.random);
            story.push(`${type.name} falls. ${winners.length} crew member${winners.length === 1 ? '' : 's'} claim the boss reward.`);
            return { eventType: type.id, variant: 'boss', success, chance, rewardPool, payouts: distributePool(rewardPool, winners), story };
        }

        deathmatchOutcome(round, entries) {
            const percent = randomInt(35, 85, this.random);
            const rewardPool = Math.floor(round.pot * percent / 100);
            const winners = pickWinners(entries, this.random);
            return {
                eventType: 'normal', variant: 'deathmatch', success: true, chance: 100, rewardPool,
                payouts: distributePool(rewardPool, winners),
                story: ['The doors slam shut and the mystery job becomes a crew-against-crew street fight.', `${winners.length} survivor${winners.length === 1 ? '' : 's'} split ${percent}% of the entry pot.`],
            };
        }

        robberyOutcome(round, entries, now) {
            const attackers = new Set(entries.map(entry => entry.user_id));
            const victims = this.db.prepare('SELECT user_id,balance FROM economy_members WHERE guild_id=? AND balance>0 ORDER BY balance DESC')
                .all(round.guild_id).filter(member => !attackers.has(member.user_id));
            if (!victims.length) return this.deathmatchOutcome(round, entries);
            const victim = victims[Math.floor(this.random() * victims.length)];
            const percent = randomInt(1, MAX_ROBBERY_PERCENT, this.random);
            const attempted = Math.max(1, Math.min(Math.floor(victim.balance * MAX_ROBBERY_PERCENT / 100), Math.floor(victim.balance * percent / 100)));
            const defended = this.random() < 0.45;
            const story = [`The target is revealed: <@${victim.user_id}>. The crew moves in for ${percent}% of the target's balance.`];
            if (!defended) {
                const stolen = Math.min(attempted, this.member(round.guild_id, victim.user_id)?.balance || 0);
                if (stolen) this.applyDelta(round.guild_id, victim.user_id, -stolen, 'heist-robbed', round.round_id, null, now);
                const rewardPool = stolen + Math.floor(round.pot * randomInt(35, 85, this.random) / 100);
                const winners = pickWinners(entries, this.random);
                story.push(`<@${victim.user_id}> is robbed for ${money(stolen)}. Only ${winners.length} attacker${winners.length === 1 ? '' : 's'} escape with a payout.`);
                return { eventType: 'normal', variant: 'robbery', success: true, chance: 55, victimId: victim.user_id, stolenAmount: stolen, rewardPool, payouts: distributePool(rewardPool, winners), story };
            }
            const charged = shuffled(entries, this.random).filter(() => this.random() < 0.55);
            if (!charged.length) charged.push(entries[0]);
            let defenseAmount = 0;
            for (const attacker of charged) {
                const balance = this.member(round.guild_id, attacker.user_id)?.balance || 0;
                const counter = Math.min(HEIST_ENTRY_FEE, Math.floor(balance * randomInt(1, MAX_ROBBERY_PERCENT, this.random) / 100));
                if (counter) {
                    this.applyDelta(round.guild_id, attacker.user_id, -counter, 'heist-defense-loss', round.round_id, null, now);
                    defenseAmount += counter;
                }
            }
            if (defenseAmount) this.applyDelta(round.guild_id, victim.user_id, defenseAmount, 'heist-defense-win', round.round_id, null, now);
            story.push(`<@${victim.user_id}> successfully defends the balance and counter-robs ${money(defenseAmount)} from the attackers.`);
            return { eventType: 'normal', variant: 'defended-robbery', success: false, chance: 55, victimId: victim.user_id, defenseAmount, rewardPool: defenseAmount, payouts: new Map(), story };
        }

        resolveHeist(roundId, now = Date.now()) {
            return this.transaction(() => {
                const round = this.heistRound(roundId);
                if (!round || round.status !== 'signup') return round;
                const entries = round.entries;
                if (entries.length < 2) {
                    for (const entry of entries) if (entry.entry_fee) this.applyDelta(round.guild_id, entry.user_id, entry.entry_fee, 'heist-refund', roundId, null, now);
                    this.saveOutcome(roundId, { eventType: 'cancelled', variant: 'cancelled', rewardPool: round.pot, story: ['The mystery job is called off because fewer than two players joined.'] });
                    this.db.prepare("UPDATE heist_rounds SET status='cancelled',success=0,payout_total=?,completed_at=? WHERE round_id=?").run(round.pot, now, roundId);
                    return this.heistRound(roundId);
                }
                const type = pickHeistType(this.random);
                const outcome = type.id !== 'normal'
                    ? this.bossOutcome(round, entries, type)
                    : (this.random() < 0.5 ? this.deathmatchOutcome(round, entries) : this.robberyOutcome(round, entries, now));
                const payoutTotal = this.payAttackers(round, entries, outcome.payouts, now);
                this.saveOutcome(roundId, outcome);
                this.db.prepare("UPDATE heist_rounds SET status='complete',success_chance=?,success=?,payout_total=?,completed_at=? WHERE round_id=?")
                    .run(Math.round(outcome.chance), outcome.success ? 1 : 0, payoutTotal, now, roundId);
                return this.heistRound(roundId);
            });
        }
    }

    economyModule.EconomyService = SpecialEconomyService;
    const previousCreateIntegration = discordEconomy.createEconomyIntegration;
    discordEconomy.createEconomyIntegration = function createSpecialEventIntegration(client, economy, options = {}) {
        const integration = previousCreateIntegration(client, economy, { ...options, customHeistPanel: true });
        const originalHandleButton = integration.handleButton;
        let timer = null;

        function signupPayload(state) {
            const round = state.round;
            return { embeds: [new Discord.EmbedBuilder().setColor(0x9b1c31).setTitle('🎭 Mystery Heist · Entry Open')
                .setDescription(`The job is classified. Its type is revealed only when the role-play begins. Entry closes <t:${Math.floor(round.signup_ends_at / 1000)}:R>.`)
                .addFields(
                    { name: 'Entry', value: `10,000 ${economy.config.currencyName}`, inline: true },
                    { name: 'Players', value: `${round.participantCount} / 2 minimum`, inline: true },
                    { name: 'Pot', value: money(round.pot), inline: true },
                    { name: 'Possible jobs', value: 'Boss battle, crew deathmatch, or a robbery against a random funded member.', inline: false },
                    { name: 'Robbery rules', value: 'No more than 10% of a target balance. The target may defend and counter-rob attackers.', inline: false },
                    { name: 'Gambling limits', value: 'None. Only the available account balance limits a wager.', inline: false },
                ).setFooter({ text: 'Every 30 minutes · 9 minutes 30 seconds to enter' }).setTimestamp()], components: [new Discord.ActionRowBuilder().addComponents(
                    new Discord.ButtonBuilder().setCustomId(`econ:heist:join:${round.round_id}`).setLabel('Join Mystery Heist · 10K').setEmoji('🎭').setStyle(Discord.ButtonStyle.Danger),
                    new Discord.ButtonBuilder().setCustomId(`econ:heist:status:${round.round_id}`).setLabel('My Entry').setStyle(Discord.ButtonStyle.Secondary),
                )] };
        }

        function resultPayload(state) {
            const round = state.round;
            if (round.status === 'cancelled') return { embeds: [new Discord.EmbedBuilder().setColor(0xd29922).setTitle('↩️ Mystery Heist Cancelled').setDescription('Fewer than two players joined. All entry fees were refunded.').setTimestamp()], components: [] };
            const boss = HEIST_TYPES.find(type => type.id === round.eventType && type.id !== 'normal');
            const title = boss ? `${boss.emoji} ${boss.name} · ${round.success ? 'Crew Victory' : 'Crew Defeated'}`
                : round.variant === 'deathmatch' ? '🔫 Normal Heist · Deathmatch'
                    : round.variant === 'defended-robbery' ? '🛡️ Normal Heist · Target Defended' : '💰 Normal Heist · Robbery';
            const winners = round.entries.filter(entry => entry.payout > 0).sort((a, b) => b.payout - a.payout);
            const fields = [{ name: 'Selected winners', value: winners.length ? winners.map(entry => `<@${entry.user_id}> — **${money(entry.payout)}**`).join('\n') : 'No attackers received a payout.', inline: false }, { name: 'Total attacker payout', value: money(round.payout_total), inline: true }, { name: 'Next mystery job', value: `<t:${Math.floor(state.nextAt / 1000)}:R>`, inline: true }];
            if (round.victimId) fields.unshift({ name: round.variant === 'defended-robbery' ? 'Target defended' : 'Target robbed', value: `<@${round.victimId}> · ${money(round.variant === 'defended-robbery' ? round.defenseAmount : round.stolenAmount)} ${economy.config.currencyName}`, inline: false });
            return { embeds: [new Discord.EmbedBuilder().setColor(round.success ? 0x2ea043 : 0x9b1c31).setTitle(title).setDescription(round.story.join('\n\n')).addFields(...fields).setTimestamp()], components: [new Discord.ActionRowBuilder().addComponents(new Discord.ButtonBuilder().setCustomId(`econ:heist:status:${round.round_id}`).setLabel('My Result').setStyle(Discord.ButtonStyle.Secondary))] };
        }

        async function updateMysteryPanel(guild) {
            const channel = await guild.channels.fetch(HEIST_CHANNEL_ID).catch(() => null);
            if (!channel?.isTextBased()) return null;
            const state = economy.heistState(guild.id);
            const payload = state.phase === 'signup' ? signupPayload(state) : resultPayload(state);
            let message = economy.setting(guild.id, 'heist_panel_message')
                ? await channel.messages.fetch(economy.setting(guild.id, 'heist_panel_message')).catch(() => null) : null;
            if (message) await message.edit(payload); else { message = await channel.send(payload); economy.setSetting(guild.id, 'heist_panel_message', message.id); }
            if (state.phase !== 'signup' && economy.setting(guild.id, 'special_heist_last_story') !== state.round.round_id) {
                if (shouldAnnounceHeistResult(state)) {
                    await channel.send({ content: `🎭 **Heist type revealed:** ${payload.embeds[0].data.title}`, embeds: [new Discord.EmbedBuilder().setColor(0x6f42c1).setTitle('The Role-Play').setDescription(state.round.story.join('\n\n')).setTimestamp()], allowedMentions: { users: state.round.victimId ? [state.round.victimId] : [] } });
                }
                economy.setSetting(guild.id, 'special_heist_last_story', state.round.round_id);
            }
            return message;
        }

        const start = () => { const refresh = () => { for (const guild of client.guilds.cache.values()) updateMysteryPanel(guild).catch(error => console.error(`Mystery heist panel error in ${guild.name}:`, error.message)); }; refresh(); timer = setInterval(refresh, 15_000); };
        if (client.isReady?.()) start(); else client.once('ready', start);
        integration.updateHeistPanel = updateMysteryPanel;
        integration.handleButton = async interaction => { const handled = await originalHandleButton(interaction); if (handled && interaction.customId?.startsWith('econ:heist:')) await updateMysteryPanel(interaction.guild).catch(() => {}); return handled; };
        const originalStop = integration.stop;
        integration.stop = async () => { if (timer) clearInterval(timer); return originalStop(); };
        return integration;
    };
}

module.exports = { HEIST_CHANNEL_ID, HEIST_ENTRY_FEE, HEIST_INTERVAL_MS, HEIST_SIGNUP_MS, HEIST_TYPES, MAX_ROBBERY_PERCENT, distributePool, installSpecialEconomyEvents, pickHeistType, pickWinners, shouldAnnounceHeistResult };
