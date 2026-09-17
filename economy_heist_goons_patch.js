'use strict';

const Discord = require('discord.js');
const economyModule = require('./economy');
const discordEconomy = require('./economy_discord');

const HOT_TIP_KEY = 'hot-tip';
const GOON_KEY = 'hired-goon';
const REMOVED_KEYS = new Set(['loaded-van', 'pvp-contract']);
const HOT_TIP_COST = 50_000;
const HOT_TIP_USES = 2;
const HOT_TIP_MULTIPLIER = 1.25;
const GOON_COST = 100_000;
const GOON_DURATION_MS = 24 * 60 * 60 * 1000;
const GOON_MAX_ACTIVE = 2;
const GOON_BOSS_CUT = 0.50;
const GOON_PVP_LOSS_SHARE = 0.25;
const HEIST_ENTRY_FEE = 100_000;
const HEIST_BASE_REWARD = 150_000;
const HEIST_MAX_REWARD = 1_000_000;
const HEIST_BASE_SUCCESS = 66;
const HEIST_SUCCESS_PER_PLAYER = 1.5;
const LUCK_SHOP_GUILD_ID = '1532503754350264571';
const LUCK_SHOP_CHANNEL_ID = '1532787416098672750';
const LUCK_PANEL_SETTING = 'luck_shop_panel_message';

const HEIST_STORE_ITEMS = Object.freeze({
    [HOT_TIP_KEY]: Object.freeze({
        key: HOT_TIP_KEY,
        name: 'Hot Tip',
        cost: HOT_TIP_COST,
        quantity: HOT_TIP_USES,
        description: '+25% personal heist payout for your next 2 winning heists.',
    }),
    [GOON_KEY]: Object.freeze({
        key: GOON_KEY,
        name: 'Hired Goon',
        cost: GOON_COST,
        quantity: 1,
        description: 'Hire one goon for 24 hours. Up to 2 may be active at once.',
    }),
});

function money(value) {
    return Number(value || 0).toLocaleString('en-US');
}

function scaledReward(playerCount) {
    return Math.min(HEIST_MAX_REWARD, HEIST_BASE_REWARD * Math.max(1, Number(playerCount) || 1));
}

function successChance(playerCount) {
    return Math.min(100, HEIST_BASE_SUCCESS + (Math.max(0, Number(playerCount) || 0) * HEIST_SUCCESS_PER_PLAYER));
}

function installHeistGoonsPatch() {
    const PreviousEconomyService = economyModule.EconomyService;

    class HeistGoonsEconomyService extends PreviousEconomyService {
        constructor(options = {}) {
            super(options);
            this.db.exec(`CREATE TABLE IF NOT EXISTS heist_hired_goons (
                guild_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                slot INTEGER NOT NULL,
                purchased_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                PRIMARY KEY(guild_id,user_id,slot)
            )`);
        }

        cleanupExpiredGoons(now = Date.now()) {
            this.db.prepare('DELETE FROM heist_hired_goons WHERE expires_at<=?').run(now);
        }

        activeGoons(guildId, userId, now = Date.now()) {
            this.cleanupExpiredGoons(now);
            return this.db.prepare('SELECT slot,purchased_at,expires_at FROM heist_hired_goons WHERE guild_id=? AND user_id=? AND expires_at>? ORDER BY slot')
                .all(guildId, userId, now);
        }

        activeGoonCount(guildId, userId, now = Date.now()) {
            return this.activeGoons(guildId, userId, now).length;
        }

        heistItemQuantity(guildId, userId, itemKey) {
            if (REMOVED_KEYS.has(itemKey)) return 0;
            if (itemKey === GOON_KEY) return this.activeGoonCount(guildId, userId);
            return super.heistItemQuantity(guildId, userId, itemKey);
        }

        heistStoreStatus(guildId, userId, now = Date.now()) {
            const status = super.heistStoreStatus(guildId, userId, now);
            const goons = this.activeGoons(guildId, userId, now);
            status.inventory[HOT_TIP_KEY] = Number(status.inventory[HOT_TIP_KEY] || 0);
            status.inventory[GOON_KEY] = goons.length;
            delete status.inventory['loaded-van'];
            delete status.inventory['pvp-contract'];
            status.goons = goons;
            return status;
        }

        buyHeistStoreItem(guildId, userId, itemKey, interactionId, now = Date.now()) {
            if (REMOVED_KEYS.has(itemKey)) throw new Error('That heist item is no longer sold.');
            const item = HEIST_STORE_ITEMS[itemKey];
            if (!item) return super.buyHeistStoreItem(guildId, userId, itemKey, interactionId, now);

            return this.transaction(() => {
                const member = this.ensureMember(guildId, userId, now);
                this.assertUsable(member);
                if (member.balance < item.cost) {
                    throw new Error(`You need ${money(item.cost)} ${this.config.currencyName} for ${item.name}.`);
                }

                if (itemKey === HOT_TIP_KEY) {
                    const balance = this.applyDelta(guildId, userId, -item.cost, 'heist-store-purchase', item.key, interactionId, now);
                    const quantity = this.adjustHeistItem(guildId, userId, HOT_TIP_KEY, HOT_TIP_USES, now);
                    return { item, quantity, balance, ...this.heistStoreStatus(guildId, userId, now) };
                }

                const active = this.activeGoons(guildId, userId, now);
                if (active.length >= GOON_MAX_ACTIVE) throw new Error('You already have the maximum of 2 active hired goons.');
                const used = new Set(active.map(row => Number(row.slot)));
                const slot = [1, 2].find(number => !used.has(number));
                const balance = this.applyDelta(guildId, userId, -item.cost, 'heist-store-purchase', `${item.key}:${slot}`, interactionId, now);
                this.db.prepare(`INSERT OR REPLACE INTO heist_hired_goons(guild_id,user_id,slot,purchased_at,expires_at)
                    VALUES(?,?,?,?,?)`).run(guildId, userId, slot, now, now + GOON_DURATION_MS);
                return { item, quantity: active.length + 1, balance, ...this.heistStoreStatus(guildId, userId, now) };
            });
        }

        goonRoster(round, entries, now = Date.now()) {
            const roster = [];
            for (const entry of entries || []) {
                const count = this.activeGoonCount(round.guild_id, entry.user_id, now);
                if (count > 0) roster.push({ ownerId: entry.user_id, count });
            }
            return roster;
        }

        applyGoonShares(entries, goons, rewardPool) {
            const totalGoons = goons.reduce((sum, row) => sum + row.count, 0);
            const effectivePlayers = entries.length + totalGoons;
            const payouts = new Map();
            if (!effectivePlayers || rewardPool <= 0) return { payouts, effectivePlayers, totalGoons, share: 0 };

            const share = Math.floor(rewardPool / effectivePlayers);
            let allocated = 0;
            entries.forEach((entry, index) => {
                const baseShare = index === entries.length - 1 && totalGoons === 0 ? rewardPool - allocated : share;
                allocated += baseShare;
                payouts.set(entry.user_id, baseShare);
            });

            for (const row of goons) {
                const commission = Math.floor(share * GOON_BOSS_CUT) * row.count;
                payouts.set(row.ownerId, Number(payouts.get(row.ownerId) || 0) + commission);
            }
            return { payouts, effectivePlayers, totalGoons, share };
        }

        bossOutcome(round, entries, type) {
            const now = Date.now();
            const goons = this.goonRoster(round, entries, now);
            const totalGoons = goons.reduce((sum, row) => sum + row.count, 0);
            const effectivePlayers = entries.length + totalGoons;
            const chance = successChance(effectivePlayers);
            const success = this.random() * 100 < chance;
            const rewardPool = success ? scaledReward(effectivePlayers) : 0;
            const shares = this.applyGoonShares(entries, goons, rewardPool);
            const story = [
                `${type.emoji || '👑'} **${type.name || 'Boss'}** hits the crew head-on.`,
                `Success chance: **${chance.toFixed(1)}%** using **${entries.length} player${entries.length === 1 ? '' : 's'} + ${totalGoons} hired goon${totalGoons === 1 ? '' : 's'}**.`,
            ];
            if (success) {
                story.push(`The crew secures **${money(rewardPool)} Blood Money** before goon commissions.`);
                if (totalGoons) story.push(`🤵 Bosses collect **50% of each hired goon's cut**.`);
            } else {
                story.push(`${type.name || 'The boss'} wins the fight and the crew loses the entry pot.`);
            }
            return {
                eventType: type.id || 'boss', variant: 'boss', success, chance,
                rewardPool, payouts: success ? shares.payouts : new Map(), story,
            };
        }

        pvpOutcome(round, entries, now = Date.now()) {
            const goons = this.goonRoster(round, entries, now);
            const totalGoons = goons.reduce((sum, row) => sum + row.count, 0);
            const effectivePlayers = entries.length + totalGoons;
            const attackers = new Set(entries.map(entry => entry.user_id));
            const victims = this.db.prepare('SELECT user_id,balance FROM economy_members WHERE guild_id=? AND balance>0 ORDER BY balance DESC')
                .all(round.guild_id).filter(member => !attackers.has(member.user_id));
            if (!victims.length) return this.bossOutcome(round, entries, { id: 'fallback-boss', name: 'Fallback Boss', emoji: '👑' });

            const victim = victims[Math.floor(this.random() * victims.length)];
            const chance = successChance(effectivePlayers);
            const success = this.random() * 100 < chance;
            const story = [
                `⚔️ **PvP Battle:** the crew targets <@${victim.user_id}>.`,
                `Success chance: **${chance.toFixed(1)}%** using **${entries.length} player${entries.length === 1 ? '' : 's'} + ${totalGoons} hired goon${totalGoons === 1 ? '' : 's'}**.`,
            ];

            if (success) {
                const liveBalance = Number(this.member(round.guild_id, victim.user_id)?.balance || 0);
                const percent = 1 + Math.floor(this.random() * 10);
                const stolenAmount = Math.min(Math.floor(liveBalance * 0.10), Math.floor(liveBalance * percent / 100));
                if (stolenAmount > 0) this.applyDelta(round.guild_id, victim.user_id, -stolenAmount, 'heist-robbed', round.round_id, null, now);
                const rewardPool = Math.min(HEIST_MAX_REWARD, scaledReward(effectivePlayers) + stolenAmount);
                const shares = this.applyGoonShares(entries, goons, rewardPool);
                story.push(`<@${victim.user_id}> is robbed for **${money(stolenAmount)} Blood Money**. The 10% balance cap is enforced.`);
                if (totalGoons) story.push(`🤵 Bosses collect **50% of each hired goon's cut**.`);
                return {
                    eventType: 'pvp', variant: 'robbery', success: true, chance,
                    victimId: victim.user_id, stolenAmount, rewardPool,
                    payouts: shares.payouts, story,
                };
            }

            let bossLossTotal = 0;
            for (const row of goons) {
                const desiredLoss = Math.floor(HEIST_ENTRY_FEE * GOON_PVP_LOSS_SHARE) * row.count;
                const balance = Number(this.member(round.guild_id, row.ownerId)?.balance || 0);
                const loss = Math.min(balance, desiredLoss);
                if (loss > 0) {
                    this.applyDelta(round.guild_id, row.ownerId, -loss, 'heist-goon-pvp-loss', round.round_id, null, now);
                    bossLossTotal += loss;
                }
            }
            story.push(`<@${victim.user_id}> wins the PvP defense. No target balance is taken.`);
            if (totalGoons) story.push(`🤕 Hired goons lost the fight; their bosses absorbed **25% of the goons' 100K entry exposure** (**${money(bossLossTotal)} Blood Money total**).`);
            return {
                eventType: 'pvp', variant: 'defended-robbery', success: false, chance,
                victimId: victim.user_id, stolenAmount: 0, defenseAmount: bossLossTotal,
                rewardPool: 0, payouts: new Map(), story,
            };
        }

        applyHeistStoreEffects(round, outcome, now = Date.now()) {
            const entries = round.entries || [];
            for (const entry of entries) {
                const uses = Number(super.heistItemQuantity(round.guild_id, entry.user_id, HOT_TIP_KEY) || 0);
                const payout = Number(outcome.payouts.get(entry.user_id) || 0);
                if (uses <= 0 || payout <= 0) continue;
                outcome.payouts.set(entry.user_id, Math.floor(payout * HOT_TIP_MULTIPLIER));
                this.adjustHeistItem(round.guild_id, entry.user_id, HOT_TIP_KEY, -1, now);
                outcome.story = [...(outcome.story || []), `🗺️ <@${entry.user_id}>'s **Hot Tip** boosted their payout by **25%**.`];
            }
            return outcome;
        }
    }

    economyModule.EconomyService = HeistGoonsEconomyService;

    const previousCreateIntegration = discordEconomy.createEconomyIntegration;
    discordEconomy.createEconomyIntegration = function createGoonsHeistIntegration(client, economy, options = {}) {
        const integration = previousCreateIntegration(client, economy, options);
        const previousHandleButton = integration.handleButton;
        const previousStop = integration.stop;
        let panelTimer = null;
        let storeTimer = null;

        function heistPanelPayload(state) {
            const round = state.round;
            const signup = state.phase === 'signup';
            const nextAt = signup ? round.signup_ends_at : state.nextAt;
            const participants = Number(round?.participantCount || round?.entries?.length || 0);
            const chance = successChance(participants);
            const joinRoundId = round?.round_id || 'next';
            return {
                embeds: [new Discord.EmbedBuilder()
                    .setColor(signup ? 0x9b1c31 : 0x6f42c1)
                    .setTitle(signup ? '🎭 Heist · Entry Open' : '🎭 Heist · Enter Anytime')
                    .setDescription(signup
                        ? `This heist closes <t:${Math.floor(nextAt / 1000)}:R>.`
                        : `The next heist begins <t:${Math.floor(nextAt / 1000)}:R>. You can reserve your spot now.`)
                    .addFields(
                        { name: 'Entry', value: `100,000 ${economy.config.currencyName}`, inline: true },
                        { name: 'Schedule', value: '3 AM · 9 AM · 3 PM · 9 PM ET', inline: true },
                        { name: 'Base Reward', value: '150,000 per participant · 1,000,000 max', inline: true },
                        { name: 'Success', value: `66% + 1.5% per participant`, inline: true },
                        { name: 'Encounter', value: 'Boss Battle or PvP Battle', inline: true },
                        { name: 'Join Anytime', value: signup ? 'Joins the current heist.' : 'Reserves the next heist and charges the 100K entry now.', inline: false },
                    )
                    .setFooter({ text: 'Heist role reminders: 9 AM and 9 PM Eastern' })
                    .setTimestamp()],
                components: [new Discord.ActionRowBuilder().addComponents(
                    new Discord.ButtonBuilder().setCustomId(`econ:heist:join:${joinRoundId}`).setLabel(signup ? 'Join Heist · 100K' : 'Enter Next Heist · 100K').setEmoji('🎭').setStyle(Discord.ButtonStyle.Danger),
                    new Discord.ButtonBuilder().setCustomId(`econ:heist:status:${joinRoundId}`).setLabel('My Entry').setStyle(Discord.ButtonStyle.Secondary),
                    new Discord.ButtonBuilder().setCustomId('econ:heist:notify').setLabel('Ping Me for Heists').setEmoji('🔔').setStyle(Discord.ButtonStyle.Secondary),
                )],
            };
        }

        async function refreshHeistPanel(guild) {
            const channelId = economy.config.heistChannelId;
            if (!channelId) return;
            const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
            if (!channel?.isTextBased()) return;
            const state = economy.heistState(guild.id);
            const storedId = economy.setting(guild.id, 'heist_panel_message');
            let message = storedId ? await channel.messages.fetch(storedId).catch(() => null) : null;
            if (!message) {
                message = await channel.send(heistPanelPayload(state));
                economy.setSetting(guild.id, 'heist_panel_message', message.id);
            } else {
                await message.edit(heistPanelPayload(state)).catch(() => {});
            }
        }

        function storePayload(guildId) {
            let globalLuck = 0;
            let boosts = 0;
            try {
                const rows = economy.db.prepare('SELECT luck_percent FROM global_luck_contributions WHERE guild_id=? AND expires_at>?').all(guildId, Date.now());
                globalLuck = rows.reduce((sum, row) => sum + Number(row.luck_percent || 0), 0);
                boosts = rows.length;
            } catch {}
            return {
                embeds: [new Discord.EmbedBuilder()
                    .setColor(0x2ea043)
                    .setTitle('🍀 The Commission · Luck & Heist Shop')
                    .setDescription(
                        '**Permanent Personal Luck**\n' +
                        '🍀 **Lucky Break** — +1% luck — **5,000 Blood Money**\n' +
                        '🎩 **Made Luck** — +5% luck — **30,000 Blood Money**\n' +
                        '👑 **Boss Luck** — +10% luck — **250,000 Blood Money**\n\n' +
                        '**Heist Items**\n' +
                        `🗺️ **Hot Tip** — +25% personal payout on your next **2 winning heists** — **${money(HOT_TIP_COST)} Blood Money**\n` +
                        `🤵 **Hired Goon** — **${money(GOON_COST)} Blood Money each** · active for **24 hours** · max **2 active**. ` +
                        'Each goon counts as another participant for success/reward scaling. You receive **50% of each goon\'s cut**. On a failed PvP battle, you absorb **25% of each goon\'s 100K loss exposure**.\n\n' +
                        '**Community Luck Pot**\nSpend **1,000 Blood Money** to add **+0.5% GLOBAL luck** for 24 hours.'
                    )
                    .addFields(
                        { name: '🌐 Current Global Modifier', value: `+${globalLuck}% LUCK`, inline: true },
                        { name: '🍀 Active Community Boosts', value: String(boosts), inline: true },
                    )
                    .setFooter({ text: 'Loaded Getaway Van and PvP Contract have been removed' })
                    .setTimestamp()],
                components: [
                    new Discord.ActionRowBuilder().addComponents(
                        new Discord.ButtonBuilder().setCustomId('econ:luckpanel:buy:luck-1').setLabel('+1% · 5,000').setEmoji('🍀').setStyle(Discord.ButtonStyle.Secondary),
                        new Discord.ButtonBuilder().setCustomId('econ:luckpanel:buy:luck-5').setLabel('+5% · 30,000').setEmoji('🎩').setStyle(Discord.ButtonStyle.Primary),
                        new Discord.ButtonBuilder().setCustomId('econ:luckpanel:buy:luck-10').setLabel('+10% · 250,000').setEmoji('👑').setStyle(Discord.ButtonStyle.Danger),
                    ),
                    new Discord.ActionRowBuilder().addComponents(
                        new Discord.ButtonBuilder().setCustomId('econ:luckpanel:heistbuy:hot-tip').setLabel('Hot Tip · 50K').setEmoji('🗺️').setStyle(Discord.ButtonStyle.Primary),
                        new Discord.ButtonBuilder().setCustomId('econ:luckpanel:heistbuy:hired-goon').setLabel('Hire Goon · 100K').setEmoji('🤵').setStyle(Discord.ButtonStyle.Danger),
                    ),
                    new Discord.ActionRowBuilder().addComponents(
                        new Discord.ButtonBuilder().setCustomId('econ:luckpanel:global').setLabel('Add +0.5% Global · 1,000').setEmoji('🌐').setStyle(Discord.ButtonStyle.Success),
                        new Discord.ButtonBuilder().setCustomId('econ:luckpanel:mine').setLabel('My Luck / Inventory').setEmoji('📊').setStyle(Discord.ButtonStyle.Secondary),
                        new Discord.ButtonBuilder().setCustomId('econ:luckpanel:refresh').setLabel('Refresh').setEmoji('🔄').setStyle(Discord.ButtonStyle.Secondary),
                    ),
                ],
            };
        }

        async function refreshStorePanel() {
            const guild = client.guilds.cache.get(LUCK_SHOP_GUILD_ID) || await client.guilds.fetch(LUCK_SHOP_GUILD_ID).catch(() => null);
            if (!guild) return;
            const channel = guild.channels.cache.get(LUCK_SHOP_CHANNEL_ID) || await guild.channels.fetch(LUCK_SHOP_CHANNEL_ID).catch(() => null);
            if (!channel?.isTextBased()) return;
            const storedId = economy.setting(guild.id, LUCK_PANEL_SETTING);
            let message = storedId ? await channel.messages.fetch(storedId).catch(() => null) : null;
            if (!message) {
                message = await channel.send(storePayload(guild.id));
                economy.setSetting(guild.id, LUCK_PANEL_SETTING, message.id);
            } else {
                await message.edit(storePayload(guild.id)).catch(() => {});
            }
        }

        integration.handleButton = async interaction => {
            if (!interaction.isButton?.()) return previousHandleButton(interaction);
            const id = interaction.customId;

            if (id === 'econ:luckpanel:heistbuy:hired-goon') {
                await interaction.reply({
                    ephemeral: true,
                    embeds: [new Discord.EmbedBuilder().setColor(0xd29922).setTitle('Confirm Hired Goon')
                        .setDescription(`Hire **1 goon for 24 hours** for **${money(GOON_COST)} ${economy.config.currencyName}**?\n\nMax 2 active goons. Each one earns you 50% of its heist cut, while you absorb 25% of its loss exposure on failed PvP battles.`)],
                    components: [new Discord.ActionRowBuilder().addComponents(
                        new Discord.ButtonBuilder().setCustomId('econ:luckpanel:heistconfirm:hired-goon').setLabel(`Confirm ${money(GOON_COST)}`).setEmoji('✅').setStyle(Discord.ButtonStyle.Success),
                        new Discord.ButtonBuilder().setCustomId('econ:luckpanel:cancel').setLabel('Cancel').setStyle(Discord.ButtonStyle.Secondary),
                    )],
                });
                return true;
            }

            if (id === 'econ:luckpanel:heistconfirm:hired-goon') {
                try {
                    const result = economy.buyHeistStoreItem(interaction.guild.id, interaction.user.id, GOON_KEY, interaction.id);
                    const nextExpiry = result.goons?.map(row => row.expires_at).sort((a, b) => a - b)[0] || 0;
                    await interaction.update({
                        embeds: [new Discord.EmbedBuilder().setColor(0x2ea043).setTitle('✅ Hired Goon Active')
                            .setDescription(`You now have **${result.goons.length}/2 active goons**.\nBalance: **${money(result.balance)} ${economy.config.currencyName}**.${nextExpiry ? `\nNext goon expires <t:${Math.floor(nextExpiry / 1000)}:R>.` : ''}`)],
                        components: [],
                    });
                    await refreshStorePanel();
                } catch (error) {
                    await interaction.update({ content: `❌ ${error.message}`, embeds: [], components: [] }).catch(() => {});
                }
                return true;
            }

            if (id === 'econ:luckpanel:heistbuy:loaded-van' || id === 'econ:luckpanel:heistbuy:pvp-contract'
                || id === 'econ:luckpanel:heistconfirm:loaded-van' || id === 'econ:luckpanel:heistconfirm:pvp-contract') {
                await interaction.reply({ content: '❌ That heist item has been removed from the shop.', ephemeral: true }).catch(() => {});
                return true;
            }

            if (id === 'econ:luckpanel:mine') {
                const status = economy.heistStoreStatus(interaction.guild.id, interaction.user.id);
                const hotTips = Number(status.inventory[HOT_TIP_KEY] || 0);
                const goons = status.goons || [];
                const goonLines = goons.length
                    ? goons.map((row, index) => `🤵 Goon ${index + 1}: expires <t:${Math.floor(row.expires_at / 1000)}:R>`).join('\n')
                    : 'No active hired goons.';
                await interaction.reply({
                    ephemeral: true,
                    embeds: [new Discord.EmbedBuilder().setColor(0x2ea043).setTitle('🎭 Your Heist Inventory')
                        .setDescription(`🗺️ Hot Tip uses: **${hotTips}**\n🤵 Active Goons: **${goons.length}/2**\n${goonLines}\n\nBalance: **${money(status.balance)} ${economy.config.currencyName}**.`)],
                });
                return true;
            }

            if (id === 'econ:luckpanel:refresh') {
                await refreshStorePanel();
                await interaction.reply({ content: '🔄 Shop refreshed.', ephemeral: true }).catch(() => {});
                return true;
            }

            const handled = await previousHandleButton(interaction);
            if (id === 'econ:luckpanel:heistconfirm:hot-tip' && handled) await refreshStorePanel();
            return handled;
        };

        const start = () => {
            const refreshHeists = () => {
                for (const guild of client.guilds.cache.values()) refreshHeistPanel(guild).catch(() => {});
            };
            refreshHeists();
            refreshStorePanel().catch(() => {});
            panelTimer = setInterval(refreshHeists, 10_000);
            storeTimer = setInterval(() => refreshStorePanel().catch(() => {}), 30_000);
            panelTimer.unref?.();
            storeTimer.unref?.();
        };
        if (client.isReady?.()) start(); else client.once('ready', start);

        integration.stop = async (...args) => {
            if (panelTimer) clearInterval(panelTimer);
            if (storeTimer) clearInterval(storeTimer);
            return previousStop?.(...args);
        };

        return integration;
    };
}

module.exports = {
    GOON_COST,
    GOON_DURATION_MS,
    GOON_MAX_ACTIVE,
    HEIST_STORE_ITEMS,
    HOT_TIP_COST,
    HOT_TIP_USES,
    installHeistGoonsPatch,
};
