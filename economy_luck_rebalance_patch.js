'use strict';

const Discord = require('discord.js');
const crypto = require('node:crypto');
const economyModule = require('./economy');
const discordEconomy = require('./economy_discord');

const STORE_GUILD_ID = '1532503754350264571';
const STORE_CHANNEL_ID = '1532787416098672750';
const STORE_PANEL_SETTING = 'luck_shop_panel_message';

const LUCK_ITEMS = Object.freeze({
    'luck-1': Object.freeze({ key: 'luck-1', name: 'Lucky Break', percent: 1, cost: 50_000 }),
    'luck-5': Object.freeze({ key: 'luck-5', name: 'Made Luck', percent: 5, cost: 300_000 }),
    'luck-10': Object.freeze({ key: 'luck-10', name: 'Boss Luck', percent: 10, cost: 2_500_000 }),
    'luck-25': Object.freeze({ key: 'luck-25', name: 'Apex Luck', percent: 25, cost: 3_000_000 }),
});
const APEX_REQUIREMENTS = Object.freeze(['luck-1', 'luck-5', 'luck-10']);

const DAILY_COMMON_MIN = 1_000;
const DAILY_COMMON_MAX = 50_000;
const DAILY_RARE_MIN = 50_001;
const DAILY_RARE_MAX = 250_000;
const DAILY_COMMON_CHANCE = 0.80;

function money(value) {
    return Number(value || 0).toLocaleString('en-US');
}

function randomIntInclusive(min, max, random = Math.random) {
    return min + Math.floor(Math.min(0.999999999, Math.max(0, random())) * (max - min + 1));
}

function dailyRoll(random = Math.random) {
    if (random() < DAILY_COMMON_CHANCE) return randomIntInclusive(DAILY_COMMON_MIN, DAILY_COMMON_MAX, random);
    return randomIntInclusive(DAILY_RARE_MIN, DAILY_RARE_MAX, random);
}

function dailyRoleplay(amount) {
    if (amount === 250_000) return '🎰 **JACKPOT!** The Commission cracked the vault wide open. Somehow every machine lit up at once.';
    if (amount >= 200_000) return '💎 **The score of the week.** A forgotten lockbox just became your retirement plan.';
    if (amount >= 150_000) return '🚚 **Armored truck mix-up.** Somebody parked the wrong bag in the right getaway car.';
    if (amount >= 100_000) return '📋 **Insurance scam successful.** The paperwork looked suspicious, but apparently nobody reads the fine print.';
    if (amount >= 75_000) return '🧾 **Creative accounting paid off.** The books balance if nobody asks too many questions.';
    if (amount >= 50_001) return '💼 **A very productive side hustle.** Nobody needs to know why the briefcase was humming.';
    if (amount >= 25_000) return '🕶️ **A decent day in the business.** A few favors got called in and the envelope was heavier than expected.';
    if (amount >= 10_000) return '☕ **Not bad for a Tuesday.** You shook a few trees and some Blood Money fell out.';
    if (amount === 1_000) return '🗄️ **Another boring day at the office.** You filed three forms, stared at the clock, and found 1,000 Blood Money in petty cash.';
    return '📎 **Another boring day at the office.** Nothing exploded, nobody got chased, and payroll somehow cleared.';
}

function storePayload(economy, guildId) {
    let globalLuck = 0;
    let boosts = 0;
    let nextExpiry = 0;
    try {
        const rows = economy.db.prepare('SELECT luck_percent,expires_at FROM global_luck_contributions WHERE guild_id=? AND expires_at>? ORDER BY expires_at ASC')
            .all(guildId, Date.now());
        globalLuck = rows.reduce((sum, row) => sum + Number(row.luck_percent || 0), 0);
        boosts = rows.length;
        nextExpiry = rows[0]?.expires_at || 0;
    } catch {}

    const embed = new Discord.EmbedBuilder()
        .setColor(0x2ea043)
        .setTitle('🍀 The Commission · Luck & Heist Shop')
        .setDescription(
            '**Permanent Personal Luck**\n' +
            `🍀 **Lucky Break** — +1% luck — **${money(LUCK_ITEMS['luck-1'].cost)} ${economy.config.currencyName}**\n` +
            `🎩 **Made Luck** — +5% luck — **${money(LUCK_ITEMS['luck-5'].cost)} ${economy.config.currencyName}**\n` +
            `👑 **Boss Luck** — +10% luck — **${money(LUCK_ITEMS['luck-10'].cost)} ${economy.config.currencyName}**\n` +
            `💠 **Apex Luck** — +25% luck — **${money(LUCK_ITEMS['luck-25'].cost)} ${economy.config.currencyName}**\n` +
            'Requires you to own **1% + 5% + 10%** first. Buying Apex Luck **trades those three upgrades in** and replaces them with one permanent **25% modifier**.\n\n' +
            '**Heist Items**\n' +
            '🗺️ **Hot Tip** — +25% personal payout on your next **2 winning heists** — **50,000 Blood Money**\n' +
            '🤵 **Hired Goon** — **100,000 Blood Money each** · lasts **24 hours** · max **2 active**.\n\n' +
            '**Daily Claim**\n' +
            'Daily payouts are fully random from **1,000 to 250,000 Blood Money**. The lower 1K–50K band is drawn 80% of the time; the 50,001–250K band is drawn 20% of the time. Every amount inside its selected band is randomly rolled.\n\n' +
            '**Community Luck Pot**\nSpend **1,000 Blood Money** to add **+0.5% GLOBAL luck** for 24 hours.'
        )
        .addFields(
            { name: '🌐 Current Global Modifier', value: `**+${globalLuck}% LUCK**`, inline: true },
            { name: '🍀 Active Community Boosts', value: String(boosts), inline: true },
            { name: '⏳ Next Modifier Drop', value: nextExpiry ? `<t:${Math.floor(nextExpiry / 1000)}:R>` : 'No active community boosts', inline: true },
        )
        .setFooter({ text: 'Apex Luck consumes the 1%, 5%, and 10% upgrades when purchased' });

    return {
        embeds: [embed],
        components: [
            new Discord.ActionRowBuilder().addComponents(
                new Discord.ButtonBuilder().setCustomId('econ:luckpanel:buy:luck-1').setLabel('+1% · 50K').setEmoji('🍀').setStyle(Discord.ButtonStyle.Secondary),
                new Discord.ButtonBuilder().setCustomId('econ:luckpanel:buy:luck-5').setLabel('+5% · 300K').setEmoji('🎩').setStyle(Discord.ButtonStyle.Primary),
                new Discord.ButtonBuilder().setCustomId('econ:luckpanel:buy:luck-10').setLabel('+10% · 2.5M').setEmoji('👑').setStyle(Discord.ButtonStyle.Danger),
                new Discord.ButtonBuilder().setCustomId('econ:luckpanel:buy:luck-25').setLabel('+25% · 3M').setEmoji('💠').setStyle(Discord.ButtonStyle.Success),
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

function installLuckRebalancePatch() {
    const PreviousEconomyService = economyModule.EconomyService;

    class LuckRebalanceEconomyService extends PreviousEconomyService {
        buyLuckItem(guildId, userId, itemKey, interactionId, now = Date.now()) {
            const item = LUCK_ITEMS[itemKey];
            if (!item) return super.buyLuckItem(guildId, userId, itemKey, interactionId, now);

            return this.transaction(() => {
                const member = this.ensureMember(guildId, userId, now);
                this.assertUsable(member);
                const existing = this.db.prepare('SELECT item_key FROM luck_purchases WHERE guild_id=? AND user_id=?')
                    .all(guildId, userId);
                const owned = new Set(existing.map(row => row.item_key));
                if (owned.has(itemKey)) throw new Error(`${item.name} is a one-time purchase and you already own it.`);
                if (itemKey === 'luck-25') {
                    const missing = APEX_REQUIREMENTS.filter(key => !owned.has(key));
                    if (missing.length) throw new Error('Apex Luck requires you to own the 1%, 5%, and 10% luck upgrades first.');
                }
                if (member.balance < item.cost) throw new Error(`You need ${money(item.cost)} ${this.config.currencyName} for ${item.name}.`);

                const balance = this.applyDelta(guildId, userId, -item.cost, 'luck-shop-purchase', item.key, interactionId, now);
                if (itemKey === 'luck-25') {
                    this.db.prepare(`DELETE FROM luck_purchases WHERE guild_id=? AND user_id=? AND item_key IN ('luck-1','luck-5','luck-10')`)
                        .run(guildId, userId);
                }
                this.db.prepare('INSERT INTO luck_purchases(guild_id,user_id,item_key,luck_percent,cost,purchased_at) VALUES(?,?,?,?,?,?)')
                    .run(guildId, userId, item.key, item.percent, item.cost, now);
                return { item, balance, tradedIn: itemKey === 'luck-25' ? [...APEX_REQUIREMENTS] : [], ...this.luckShopStatus(guildId, userId, now) };
            });
        }

        claimDaily(guildId, userId, interactionId, now = Date.now()) {
            return this.transaction(() => {
                const row = this.ensureMember(guildId, userId, now);
                this.assertUsable(row);
                if (this.hasInteraction(guildId, interactionId)) return { duplicate: true, balance: row.balance };
                const elapsed = now - row.last_daily_claim;
                if (row.last_daily_claim && elapsed < 24 * 60 * 60 * 1000) {
                    return { cooldown: (24 * 60 * 60 * 1000) - elapsed };
                }

                const streak = row.last_daily_claim && elapsed < 48 * 60 * 60 * 1000 ? row.daily_streak + 1 : 1;
                const cappedStreak = Math.min(streak, 7);
                const firstRoll = dailyRoll(this.random);
                let rngReward = firstRoll;
                let luckyReroll = false;
                let secondRoll = null;
                if (this.luckProc?.(guildId, userId, now)) {
                    secondRoll = dailyRoll(this.random);
                    rngReward = Math.max(firstRoll, secondRoll);
                    luckyReroll = true;
                }

                const reward = Math.max(DAILY_COMMON_MIN, Math.min(DAILY_RARE_MAX, rngReward));
                const roleplay = dailyRoleplay(reward);
                const balance = this.applyDelta(guildId, userId, reward, 'daily', `rng:${reward};band:${reward <= DAILY_COMMON_MAX ? 'common' : 'rare'}`, interactionId, now);
                this.db.prepare('UPDATE economy_members SET last_daily_claim=?,daily_streak=? WHERE guild_id=? AND user_id=?')
                    .run(now, streak, guildId, userId);
                return {
                    reward, rngReward: reward, streak, cappedStreak, streakBonus: 0,
                    luckyReroll, firstRoll, secondRoll, balance,
                    luck: this.totalLuckPercent?.(guildId, userId, now) || 0,
                    roleplay,
                };
            });
        }
    }

    economyModule.EconomyService = LuckRebalanceEconomyService;

    const previousCreateIntegration = discordEconomy.createEconomyIntegration;
    discordEconomy.createEconomyIntegration = function createLuckRebalanceIntegration(client, economy, options = {}) {
        const integration = previousCreateIntegration(client, economy, options);
        const previousHandleButton = integration.handleButton;
        const previousHandleCommand = integration.handleCommand;

        async function refreshStorePanel() {
            const guild = client.guilds.cache.get(STORE_GUILD_ID) || await client.guilds.fetch(STORE_GUILD_ID).catch(() => null);
            if (!guild) return null;
            const channel = guild.channels.cache.get(STORE_CHANNEL_ID) || await guild.channels.fetch(STORE_CHANNEL_ID).catch(() => null);
            if (!channel?.isTextBased()) return null;
            const payload = storePayload(economy, guild.id);
            const storedId = economy.setting(guild.id, STORE_PANEL_SETTING);
            let message = storedId ? (channel.messages.cache.get(storedId) || await channel.messages.fetch(storedId).catch(() => null)) : null;
            if (!message) {
                message = await channel.send(payload);
                economy.setSetting(guild.id, STORE_PANEL_SETTING, message.id);
            } else {
                await message.edit(payload).catch(() => {});
            }
            return message;
        }

        integration.refreshLuckShopPanel = refreshStorePanel;

        integration.handleButton = async interaction => {
            if (!interaction.isButton?.()) return previousHandleButton(interaction);
            const id = interaction.customId;
            const match = /^econ:luckpanel:(buy|confirm):(luck-(?:1|5|10|25))$/.exec(id);
            if (!match) return previousHandleButton(interaction);
            const [, action, itemKey] = match;
            const item = LUCK_ITEMS[itemKey];

            if (action === 'buy') {
                const requirement = itemKey === 'luck-25'
                    ? '\n\n**Requirement:** You must already own +1%, +5%, and +10%. Those three upgrades are permanently traded in when Apex Luck is purchased.'
                    : '';
                await interaction.reply({
                    ephemeral: true,
                    embeds: [new Discord.EmbedBuilder().setColor(0xd29922).setTitle(`Confirm ${item.name}`)
                        .setDescription(`Buy **+${item.percent}% permanent personal luck** for **${money(item.cost)} ${economy.config.currencyName}**?${requirement}`)],
                    components: [new Discord.ActionRowBuilder().addComponents(
                        new Discord.ButtonBuilder().setCustomId(`econ:luckpanel:confirm:${itemKey}`).setLabel(`Confirm ${money(item.cost)}`).setEmoji('✅').setStyle(Discord.ButtonStyle.Success),
                        new Discord.ButtonBuilder().setCustomId('econ:luckpanel:cancel').setLabel('Cancel').setStyle(Discord.ButtonStyle.Secondary),
                    )],
                });
                return true;
            }

            try {
                const result = economy.buyLuckItem(interaction.guild.id, interaction.user.id, itemKey, interaction.id);
                const tradeText = itemKey === 'luck-25'
                    ? '\n🍀 Your +1%, +5%, and +10% upgrades were traded in and replaced by **Apex Luck +25%**.'
                    : '';
                await interaction.update({
                    embeds: [new Discord.EmbedBuilder().setColor(0x2ea043).setTitle('✅ Luck Upgrade Purchased')
                        .setDescription(`You bought **${result.item.name}** for **${money(result.item.cost)} ${economy.config.currencyName}**.${tradeText}\nYour personal luck is now **+${result.personalLuck}%**.\nBalance: **${money(result.balance)}**.`)],
                    components: [],
                });
                await refreshStorePanel();
            } catch (error) {
                await interaction.update({ content: `❌ ${error.message}`, embeds: [], components: [] }).catch(() => {});
            }
            return true;
        };

        integration.handleCommand = async interaction => {
            if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'daily') return previousHandleCommand(interaction);
            const result = economy.claimDaily(interaction.guild.id, interaction.user.id, interaction.id);
            if (result.cooldown) {
                const hours = Math.floor(result.cooldown / 3_600_000);
                const minutes = Math.ceil((result.cooldown % 3_600_000) / 60_000);
                await interaction.reply({ content: `Your next daily collection is available in ${hours}h ${minutes}m.`, ephemeral: true });
                return true;
            }
            await interaction.reply({
                content: `${result.roleplay}\n\n🩸 You collected **${money(result.reward)} ${economy.config.currencyName}**.${result.luckyReroll ? ' 🍀 Luck gave you a second roll and kept the better payout.' : ''}\nStreak: **${result.streak}** · Balance: **${money(result.balance)}**.`,
            });
            return true;
        };

        return integration;
    };
}

module.exports = {
    DAILY_COMMON_CHANCE,
    DAILY_COMMON_MAX,
    DAILY_COMMON_MIN,
    DAILY_RARE_MAX,
    DAILY_RARE_MIN,
    LUCK_ITEMS,
    installLuckRebalancePatch,
};
