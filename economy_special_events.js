'use strict';

const crypto = require('node:crypto');
const Discord = require('discord.js');
const economyModule = require('./economy');
const discordEconomy = require('./economy_discord');
const { GAME_HOURLY_LIMIT, gameCategory } = require('./economy/core');

const WEAPONS = Object.freeze([
    'Tommy Gun', 'Sawed-Off Shotgun', 'Crowbar', 'Switchblade', 'Baseball Bat',
    'Brass Knuckles', 'Revolver', 'Pipe Wrench', 'Machete', 'Pool Cue',
]);
const HEIST_REWARD_MULTIPLIER = 1.4;
const HEIST_PODIUM_WEIGHTS = Object.freeze([10, 3, 1]);
const GIDGY_POOL = 100000;
const GIDGY_MAX_BID = 25000;

function money(value) {
    return Number(value || 0).toLocaleString('en-US');
}

function easternParts(now = Date.now()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(now));
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return {
        key: `${values.year}-${values.month}-${values.day}`,
        hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second),
    };
}

function deterministicWeapon(roundId, userId) {
    const digest = crypto.createHash('sha256').update(`${roundId}:${userId}`).digest();
    return WEAPONS[digest.readUInt32BE(0) % WEAPONS.length];
}

function shuffled(entries, random) {
    const result = [...entries];
    for (let index = result.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(random() * (index + 1));
        [result[index], result[swap]] = [result[swap], result[index]];
    }
    return result;
}

function installSpecialEconomyEvents() {
    const BaseEconomyService = economyModule.EconomyService;

    class SpecialEconomyService extends BaseEconomyService {
        constructor(options = {}) {
            super(options);
            this.config.gamblingHourlyWagerCap = 100000;
            this.config.heistEntryFee = 5000;
            this.config.heistMinimumPlayers = 2;
            this.config.heistEntryMinutes = 28;
            this.config.heistCooldownMinutes = 2;
            this.initializeGidgyzilla();
        }

        initializeGidgyzilla() {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS gidgyzilla_rounds (
                    round_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, date_key TEXT NOT NULL,
                    status TEXT NOT NULL, boss_pool INTEGER NOT NULL DEFAULT 100000,
                    total_bid INTEGER NOT NULL DEFAULT 0, success_chance REAL NOT NULL DEFAULT 0,
                    success INTEGER, payout_total INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL, completed_at INTEGER,
                    UNIQUE(guild_id, date_key)
                );
                CREATE TABLE IF NOT EXISTS gidgyzilla_entries (
                    round_id TEXT NOT NULL, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
                    bid INTEGER NOT NULL DEFAULT 0, payout INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
                    PRIMARY KEY(round_id, user_id),
                    FOREIGN KEY(round_id) REFERENCES gidgyzilla_rounds(round_id)
                );
            `);
        }

        reserveWager(guildId, userId, wager, interactionId, related, now = Date.now()) {
            const amount = Math.max(0, Number.parseInt(wager, 10) || 0);
            const category = gameCategory(related);
            if (category) {
                const count = this.db.prepare(`SELECT COUNT(*) AS total FROM economy_transactions
                    WHERE guild_id=? AND user_id=? AND type='wager' AND related LIKE ? AND created_at>=?`)
                    .get(guildId, userId, `${category}:%`, now - 3600000).total;
                if (count >= GAME_HOURLY_LIMIT) {
                    throw new Error(`${category.replaceAll('-', ' ')} hourly limit reached: maximum ${GAME_HOURLY_LIMIT} game(s) per hour.`);
                }
            }
            const row = this.ensureMember(guildId, userId, now);
            this.assertUsable(row);
            if (!this.config.gamblingEnabled) throw new Error('Gambling is currently disabled.');
            if (amount < 1) throw new Error('Wager must be at least 1.');
            if (amount > row.balance) throw new Error(`You only have ${row.balance} ${this.config.currencyName}.`);
            const dailyRemaining = Math.max(0, this.config.gamblingDailyWagerCap - row.daily_wagered);
            if (amount > dailyRemaining) {
                throw new Error(`Daily gambling allowance remaining: ${dailyRemaining} ${this.config.currencyName}.`);
            }
            const hourlyExempt = String(related || '').startsWith('heist:') || String(related || '').startsWith('duel:');
            if (!hourlyExempt) {
                const hourlyWagered = this.db.prepare(`SELECT COALESCE(SUM(-amount),0) AS total FROM economy_transactions
                    WHERE guild_id=? AND user_id=? AND type='wager' AND created_at>?
                    AND related NOT LIKE 'heist:%' AND related NOT LIKE 'duel:%'`)
                    .get(guildId, userId, now - 3600000).total;
                const hourlyRemaining = Math.max(0, this.config.gamblingHourlyWagerCap - hourlyWagered);
                if (amount > hourlyRemaining) {
                    throw new Error(`Hourly gambling allowance remaining: ${hourlyRemaining} ${this.config.currencyName} (100,000 maximum wagered per hour).`);
                }
            }
            const balance = this.applyDelta(guildId, userId, -amount, 'wager', related, interactionId, now);
            this.db.prepare('UPDATE economy_members SET lifetime_wagered=lifetime_wagered+?,daily_wagered=daily_wagered+? WHERE guild_id=? AND user_id=?')
                .run(amount, amount, guildId, userId);
            return { amount, balance };
        }

        heistSchedule(now = Date.now()) {
            const halfHour = 30 * 60 * 1000;
            const startsAt = Math.floor(now / halfHour) * halfHour;
            return {
                startsAt,
                signupEndsAt: startsAt + (28 * 60000),
                nextAt: startsAt + halfHour,
            };
        }

        heistRound(roundId) {
            const round = super.heistRound(roundId);
            if (!round) return null;
            const entries = round.entries.map(entry => ({
                ...entry,
                weapon: deterministicWeapon(roundId, entry.user_id),
            }));
            return { ...round, entries, participantCount: entries.length };
        }

        resolveHeist(roundId, now = Date.now()) {
            return this.transaction(() => {
                const round = this.heistRound(roundId);
                if (!round || round.status !== 'signup') return round;
                const entries = round.entries;
                if (entries.length < this.config.heistMinimumPlayers) {
                    for (const entry of entries) {
                        if (entry.entry_fee > 0) this.applyDelta(round.guild_id, entry.user_id, entry.entry_fee, 'heist-refund', roundId, null, now);
                    }
                    this.db.prepare("UPDATE heist_rounds SET status='cancelled',success=0,payout_total=?,completed_at=? WHERE round_id=?")
                        .run(round.pot, now, roundId);
                    return this.heistRound(roundId);
                }

                const ranked = shuffled(entries, this.random);
                const podiumCount = Math.min(3, ranked.length);
                const rewardPool = Math.floor(round.pot * HEIST_REWARD_MULTIPLIER);
                const activeWeights = HEIST_PODIUM_WEIGHTS.slice(0, podiumCount);
                const weightTotal = activeWeights.reduce((sum, weight) => sum + weight, 0);
                let distributed = 0;

                for (let index = 0; index < ranked.length; index += 1) {
                    const entry = ranked[index];
                    let payout = 0;
                    if (index < podiumCount) {
                        payout = index === podiumCount - 1
                            ? rewardPool - distributed
                            : Math.floor(rewardPool * (activeWeights[index] / weightTotal));
                        distributed += payout;
                        if (payout) this.applyDelta(round.guild_id, entry.user_id, payout, 'heist-payout', `${roundId}:place-${index + 1}`, null, now);
                    }
                    this.db.prepare('UPDATE heist_entries SET payout=? WHERE round_id=? AND user_id=?').run(payout, roundId, entry.user_id);
                    this.db.prepare(`UPDATE economy_members SET lifetime_won=lifetime_won+?,lifetime_lost=lifetime_lost+?,
                        gambling_wins=gambling_wins+?,gambling_losses=gambling_losses+? WHERE guild_id=? AND user_id=?`)
                        .run(payout, payout ? 0 : entry.entry_fee, payout ? 1 : 0, payout ? 0 : 1, round.guild_id, entry.user_id);
                }
                this.db.prepare("UPDATE heist_rounds SET status='complete',success_chance=100,success=1,payout_total=?,completed_at=? WHERE round_id=?")
                    .run(distributed, now, roundId);
                return this.heistRound(roundId);
            });
        }

        gidgyRound(guildId, dateKey = easternParts().key) {
            const row = this.db.prepare('SELECT * FROM gidgyzilla_rounds WHERE guild_id=? AND date_key=?').get(guildId, dateKey);
            if (!row) return null;
            const entries = this.db.prepare('SELECT user_id,bid,payout,updated_at FROM gidgyzilla_entries WHERE round_id=? ORDER BY bid DESC,updated_at ASC').all(row.round_id);
            return { ...row, entries, participantCount: entries.length };
        }

        ensureGidgyRound(guildId, now = Date.now()) {
            const parts = easternParts(now);
            let round = this.gidgyRound(guildId, parts.key);
            if (round) return round;
            const roundId = crypto.randomUUID();
            this.db.prepare(`INSERT OR IGNORE INTO gidgyzilla_rounds(round_id,guild_id,date_key,status,boss_pool,created_at)
                VALUES(?,?,?,'open',?,?)`).run(roundId, guildId, parts.key, GIDGY_POOL, now);
            return this.gidgyRound(guildId, parts.key);
        }

        gidgyState(guildId, now = Date.now()) {
            const parts = easternParts(now);
            if (parts.hour < 17) return { phase: 'upcoming', round: null };
            let round = this.ensureGidgyRound(guildId, now);
            if (parts.hour === 17 && parts.minute < 30 && round.status === 'open') return { phase: 'open', round };
            if (round.status === 'open') round = this.resolveGidgyzilla(guildId, now);
            return { phase: 'complete', round };
        }

        bidGidgyzilla(guildId, userId, amount, interactionId, now = Date.now()) {
            return this.transaction(() => {
                const state = this.gidgyState(guildId, now);
                if (state.phase !== 'open') throw new Error('Gidgyzilla only accepts team bids from 5:00 PM to 5:30 PM Eastern.');
                const bid = Math.max(1, Number.parseInt(amount, 10) || 0);
                const existing = state.round.entries.find(entry => entry.user_id === userId);
                const currentBid = existing?.bid || 0;
                if (currentBid + bid > GIDGY_MAX_BID) throw new Error(`Your Gidgyzilla bid total cannot exceed ${money(GIDGY_MAX_BID)} ${this.config.currencyName}.`);
                const member = this.ensureMember(guildId, userId, now);
                this.assertUsable(member);
                if (bid > member.balance) throw new Error(`You only have ${money(member.balance)} ${this.config.currencyName}.`);
                const balance = this.applyDelta(guildId, userId, -bid, 'gidgyzilla-bid', state.round.round_id, interactionId, now);
                this.db.prepare(`INSERT INTO gidgyzilla_entries(round_id,guild_id,user_id,bid,updated_at) VALUES(?,?,?,?,?)
                    ON CONFLICT(round_id,user_id) DO UPDATE SET bid=bid+excluded.bid,updated_at=excluded.updated_at`)
                    .run(state.round.round_id, guildId, userId, bid, now);
                this.db.prepare('UPDATE gidgyzilla_rounds SET total_bid=total_bid+? WHERE round_id=?').run(bid, state.round.round_id);
                return { balance, round: this.gidgyRound(guildId, state.round.date_key) };
            });
        }

        resolveGidgyzilla(guildId, now = Date.now()) {
            return this.transaction(() => {
                const parts = easternParts(now);
                const round = this.gidgyRound(guildId, parts.key);
                if (!round || round.status !== 'open') return round;
                const chance = Math.min(90, 35 + ((round.total_bid / 1000) * 0.75));
                const success = round.total_bid > 0 && (this.random() * 100) < chance;
                let payoutTotal = 0;
                if (success && round.total_bid > 0) {
                    let distributed = 0;
                    for (let index = 0; index < round.entries.length; index += 1) {
                        const entry = round.entries[index];
                        const payout = index === round.entries.length - 1
                            ? GIDGY_POOL - distributed
                            : Math.floor(GIDGY_POOL * (entry.bid / round.total_bid));
                        distributed += payout;
                        payoutTotal += payout;
                        if (payout) this.applyDelta(guildId, entry.user_id, payout, 'gidgyzilla-payout', round.round_id, null, now);
                        this.db.prepare('UPDATE gidgyzilla_entries SET payout=? WHERE round_id=? AND user_id=?').run(payout, round.round_id, entry.user_id);
                    }
                }
                this.db.prepare(`UPDATE gidgyzilla_rounds SET status='complete',success_chance=?,success=?,payout_total=?,completed_at=? WHERE round_id=?`)
                    .run(chance, success ? 1 : 0, payoutTotal, now, round.round_id);
                return this.gidgyRound(guildId, parts.key);
            });
        }
    }

    economyModule.EconomyService = SpecialEconomyService;

    const previousCreateIntegration = discordEconomy.createEconomyIntegration;
    discordEconomy.createEconomyIntegration = function createSpecialEventIntegration(client, economy, options = {}) {
        const integration = previousCreateIntegration(client, economy, options);
        const originalHandleButton = integration.handleButton;
        const originalUpdateHeistPanel = integration.updateHeistPanel;
        let specialTimer = null;

        function deathmatchPayload(state) {
            const round = state.round;
            if (state.phase === 'signup') {
                const rewardPool = Math.floor(round.pot * HEIST_REWARD_MULTIPLIER);
                const sample = round.participantCount >= 3
                    ? [Math.floor(rewardPool * 10 / 14), Math.floor(rewardPool * 3 / 14), rewardPool - Math.floor(rewardPool * 10 / 14) - Math.floor(rewardPool * 3 / 14)]
                    : [];
                const prizes = sample.length
                    ? `1st: **${money(sample[0])}** · 2nd: **${money(sample[1])}** · 3rd: **${money(sample[2])}**`
                    : 'Top finishers split the boosted reward pool once 2+ players enter.';
                return {
                    embeds: [new Discord.EmbedBuilder().setColor(0x9b1c31).setTitle('🔫 Deathmatch Heist · Entry Open')
                        .setDescription(`Every fighter gets a random weapon. Entry closes <t:${Math.floor(state.nextAt / 1000)}:R>. No maximum player count.`)
                        .addFields(
                            { name: 'Entry', value: `5,000 ${economy.config.currencyName}`, inline: true },
                            { name: 'Players', value: `${round.participantCount} / 2 minimum`, inline: true },
                            { name: 'Entry pot', value: money(round.pot), inline: true },
                            { name: 'Reward pool', value: money(rewardPool), inline: true },
                            { name: 'Current prizes', value: prizes, inline: false },
                            { name: 'Budget rule', value: 'Heist entries do **not** count toward the 100k hourly gambling cap.', inline: false },
                        ).setFooter({ text: 'Runs every 30 minutes · Top 3 paid when 3+ enter' }).setTimestamp()],
                    components: [new Discord.ActionRowBuilder().addComponents(
                        new Discord.ButtonBuilder().setCustomId(`econ:heist:join:${round.round_id}`).setLabel('Enter Deathmatch · 5K').setEmoji('🔫').setStyle(Discord.ButtonStyle.Danger),
                        new Discord.ButtonBuilder().setCustomId(`econ:heist:status:${round.round_id}`).setLabel('My Fighter').setStyle(Discord.ButtonStyle.Secondary),
                    )],
                };
            }
            const cancelled = round.status === 'cancelled';
            const winners = [...round.entries].filter(entry => entry.payout > 0).sort((a, b) => b.payout - a.payout);
            const podium = winners.length
                ? winners.map((entry, index) => `**${index + 1}.** <@${entry.user_id}> — ${money(entry.payout)} · ${entry.weapon}`).join('\n')
                : 'No winners this round.';
            return {
                embeds: [new Discord.EmbedBuilder().setColor(cancelled ? 0xd29922 : 0x2ea043)
                    .setTitle(cancelled ? '↩️ Deathmatch Cancelled' : '🏆 Deathmatch Results')
                    .setDescription(cancelled ? 'Fewer than 2 fighters entered, so all entry fees were refunded.' : podium)
                    .addFields({ name: 'Next fight', value: `<t:${Math.floor(state.nextAt / 1000)}:R>`, inline: true })
                    .setTimestamp()],
                components: [new Discord.ActionRowBuilder().addComponents(
                    new Discord.ButtonBuilder().setCustomId(`econ:heist:status:${round.round_id}`).setLabel('My Result').setStyle(Discord.ButtonStyle.Secondary),
                )],
            };
        }

        async function updateDeathmatchPanel(guild) {
            await originalUpdateHeistPanel(guild);
            if (!economy.config.heistChannelId) return;
            const channel = await guild.channels.fetch(economy.config.heistChannelId).catch(() => null);
            const messageId = economy.setting(guild.id, 'heist_panel_message');
            const message = channel?.isTextBased() && messageId ? await channel.messages.fetch(messageId).catch(() => null) : null;
            if (message) await message.edit(deathmatchPayload(economy.heistState(guild.id))).catch(() => {});
        }

        function gidgyPayload(state) {
            const round = state.round;
            if (state.phase === 'open') {
                const chance = Math.min(90, 35 + ((round.total_bid / 1000) * 0.75));
                return {
                    embeds: [new Discord.EmbedBuilder().setColor(0x7c3aed).setTitle('🦖 GIDGYZILLA HAS ARRIVED')
                        .setDescription('The server works together to defeat Gidgyzilla. Bid Blood Money to raise the team odds. Bigger bids earn a bigger share of the 100k boss pool if the team wins.')
                        .addFields(
                            { name: 'Boss pool', value: `100,000 ${economy.config.currencyName}`, inline: true },
                            { name: 'Team bid', value: money(round.total_bid), inline: true },
                            { name: 'Current win chance', value: `${chance.toFixed(1)}%`, inline: true },
                            { name: 'Personal max', value: `25,000 ${economy.config.currencyName}`, inline: true },
                            { name: 'Closes', value: '5:30 PM Eastern', inline: true },
                            { name: 'Payout', value: 'Weighted by each player’s share of the team bid.', inline: false },
                        ).setTimestamp()],
                    components: [new Discord.ActionRowBuilder().addComponents(
                        new Discord.ButtonBuilder().setCustomId('econ:gidgy:bid').setLabel('Bid Against Gidgyzilla').setEmoji('🩸').setStyle(Discord.ButtonStyle.Danger),
                        new Discord.ButtonBuilder().setCustomId('econ:gidgy:status').setLabel('My Bid').setStyle(Discord.ButtonStyle.Secondary),
                    )],
                };
            }
            const won = round?.success === 1;
            const lines = round?.entries?.length
                ? round.entries.map(entry => `<@${entry.user_id}> — bid ${money(entry.bid)} · payout ${money(entry.payout)}`).join('\n')
                : 'Nobody challenged Gidgyzilla today.';
            return {
                embeds: [new Discord.EmbedBuilder().setColor(won ? 0x2ea043 : 0x9b1c31)
                    .setTitle(won ? '🦖💥 Gidgyzilla Defeated!' : '🦖 Gidgyzilla Escaped')
                    .setDescription(lines)
                    .addFields(
                        { name: 'Final chance', value: `${Number(round?.success_chance || 0).toFixed(1)}%`, inline: true },
                        { name: 'Boss payout', value: money(round?.payout_total || 0), inline: true },
                    ).setFooter({ text: 'Gidgyzilla returns tomorrow at 5:00 PM Eastern' }).setTimestamp()],
                components: [],
            };
        }

        async function updateGidgyPanel(guild) {
            if (!economy.config.heistChannelId) return;
            const state = economy.gidgyState(guild.id);
            if (state.phase === 'upcoming') return;
            const channel = await guild.channels.fetch(economy.config.heistChannelId).catch(() => null);
            if (!channel?.isTextBased()) return;
            const stored = economy.setting(guild.id, 'gidgyzilla_panel_message');
            let message = stored ? await channel.messages.fetch(stored).catch(() => null) : null;
            const payload = gidgyPayload(state);
            if (message) await message.edit(payload);
            else {
                message = await channel.send(payload);
                economy.setSetting(guild.id, 'gidgyzilla_panel_message', message.id);
            }
        }

        async function refreshSpecialPanels() {
            for (const guild of client.guilds.cache.values()) {
                await updateDeathmatchPanel(guild).catch(error => console.error(`Deathmatch panel error in ${guild.name}:`, error.message));
                await updateGidgyPanel(guild).catch(error => console.error(`Gidgyzilla panel error in ${guild.name}:`, error.message));
            }
        }

        const startTimer = () => {
            refreshSpecialPanels().catch(() => {});
            specialTimer = setInterval(() => refreshSpecialPanels().catch(() => {}), 30000);
        };
        if (client.isReady?.()) startTimer(); else client.once('ready', startTimer);

        integration.updateHeistPanel = updateDeathmatchPanel;
        integration.handleButton = async function handleSpecialButtons(interaction) {
            if (interaction.isButton?.() && interaction.customId === 'econ:gidgy:bid') {
                const modal = new Discord.ModalBuilder().setCustomId('econ:gidgy:bidmodal').setTitle('Fight Gidgyzilla');
                const input = new Discord.TextInputBuilder().setCustomId('amount').setLabel('Bid amount (1 - 25,000)').setStyle(Discord.TextInputStyle.Short).setRequired(true).setPlaceholder('5000');
                modal.addComponents(new Discord.ActionRowBuilder().addComponents(input));
                await interaction.showModal(modal);
                return true;
            }
            if (interaction.isModalSubmit?.() && interaction.customId === 'econ:gidgy:bidmodal') {
                try {
                    const result = economy.bidGidgyzilla(interaction.guild.id, interaction.user.id, interaction.fields.getTextInputValue('amount'), interaction.id);
                    const mine = result.round.entries.find(entry => entry.user_id === interaction.user.id);
                    await interaction.reply({ content: `🦖 Your total Gidgyzilla bid is **${money(mine.bid)} ${economy.config.currencyName}**. Balance: **${money(result.balance)}**.`, ephemeral: true });
                    await updateGidgyPanel(interaction.guild);
                } catch (error) {
                    await interaction.reply({ content: `❌ ${error.message}`, ephemeral: true }).catch(() => {});
                }
                return true;
            }
            if (interaction.isButton?.() && interaction.customId === 'econ:gidgy:status') {
                const state = economy.gidgyState(interaction.guild.id);
                const mine = state.round?.entries?.find(entry => entry.user_id === interaction.user.id);
                const text = mine
                    ? `Your Gidgyzilla bid: **${money(mine.bid)}**${state.phase === 'complete' ? ` · payout: **${money(mine.payout)}**` : ''}.`
                    : 'You have not bid against Gidgyzilla today.';
                await interaction.reply({ content: `🦖 ${text}`, ephemeral: true });
                return true;
            }
            const handled = await originalHandleButton(interaction);
            if (handled && interaction.customId?.startsWith('econ:heist:')) {
                const [, , , roundId] = interaction.customId.split(':');
                const status = economy.heistEntryStatus(roundId, interaction.user.id);
                if (status?.entered) {
                    const entry = status.round.entries.find(item => item.user_id === interaction.user.id);
                    await interaction.followUp({ content: `🗡️ Your deathmatch weapon: **${entry.weapon}**.`, ephemeral: true }).catch(() => {});
                }
                await updateDeathmatchPanel(interaction.guild).catch(() => {});
            }
            return handled;
        };

        const originalStop = integration.stop;
        integration.stop = async function stopSpecialEvents() {
            if (specialTimer) clearInterval(specialTimer);
            return originalStop();
        };
        return integration;
    };
}

module.exports = { installSpecialEconomyEvents };
