'use strict';

const Discord = require('discord.js');
const discordEconomy = require('./economy_discord');

const LUCK_SHOP_GUILD_ID = '1532503754350264571';
const LUCK_SHOP_CHANNEL_ID = '1532787416098672750';
const PANEL_SETTING_KEY = 'luck_shop_panel_message';

const PERSONAL_ITEMS = Object.freeze({
    'luck-1': Object.freeze({ key: 'luck-1', name: 'Lucky Break', percent: 1, cost: 5000 }),
    'luck-5': Object.freeze({ key: 'luck-5', name: 'Made Luck', percent: 5, cost: 30000 }),
    'luck-10': Object.freeze({ key: 'luck-10', name: 'Boss Luck', percent: 10, cost: 250000 }),
});
const GLOBAL_COST = 1000;
const GLOBAL_PERCENT = 0.5;

function money(value) {
    return Number(value || 0).toLocaleString('en-US');
}

function fmtPercent(value) {
    const n = Number(value || 0);
    return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

function publicLuckState(economy, guildId, now = Date.now()) {
    economy.cleanupExpiredLuck?.(now);
    const rows = economy.db.prepare(`SELECT user_id,luck_percent,created_at,expires_at
        FROM global_luck_contributions WHERE guild_id=? AND expires_at>? ORDER BY expires_at ASC`).all(guildId, now);
    const globalLuck = rows.reduce((sum, row) => sum + Number(row.luck_percent || 0), 0);
    const nextExpiry = rows.length ? rows[0].expires_at : 0;
    return { globalLuck, activeContributions: rows.length, nextExpiry };
}

function panelPayload(economy, guildId, now = Date.now()) {
    const state = publicLuckState(economy, guildId, now);
    const nextDrop = state.nextExpiry
        ? `<t:${Math.floor(state.nextExpiry / 1000)}:R>`
        : 'No active community boosts';

    const embed = new Discord.EmbedBuilder()
        .setColor(0x2ea043)
        .setTitle('🍀 The Commission · Luck Shop')
        .setDescription(
            '**Permanent Personal Luck**\n' +
            `🍀 **Lucky Break** — +1% luck — **${money(5000)} ${economy.config.currencyName}**\n` +
            `🎩 **Made Luck** — +5% luck — **${money(30000)} ${economy.config.currencyName}**\n` +
            `👑 **Boss Luck** — +10% luck — **${money(250000)} ${economy.config.currencyName}**\n\n` +
            '**Community Luck Pot**\n' +
            `Spend **${money(GLOBAL_COST)} ${economy.config.currencyName}** to add **+${GLOBAL_PERCENT}% GLOBAL luck** for 24 hours. ` +
            'Each member may contribute once per rolling 24 hours. Every contribution stacks and expires separately.'
        )
        .addFields(
            { name: '🌐 Current Global Modifier', value: `**+${fmtPercent(state.globalLuck)}% LUCK**`, inline: true },
            { name: '🍀 Active Community Boosts', value: String(state.activeContributions), inline: true },
            { name: '⏳ Next Modifier Drop', value: nextDrop, inline: true },
        )
        .setFooter({ text: 'Button-only shop · Personal purchases require confirmation · Community buy-in is instant' })
        .setTimestamp();

    const personalRow = new Discord.ActionRowBuilder().addComponents(
        new Discord.ButtonBuilder().setCustomId('econ:luckpanel:buy:luck-1').setLabel('+1% · 5,000').setEmoji('🍀').setStyle(Discord.ButtonStyle.Secondary),
        new Discord.ButtonBuilder().setCustomId('econ:luckpanel:buy:luck-5').setLabel('+5% · 30,000').setEmoji('🎩').setStyle(Discord.ButtonStyle.Primary),
        new Discord.ButtonBuilder().setCustomId('econ:luckpanel:buy:luck-10').setLabel('+10% · 250,000').setEmoji('👑').setStyle(Discord.ButtonStyle.Danger),
    );

    const communityRow = new Discord.ActionRowBuilder().addComponents(
        new Discord.ButtonBuilder().setCustomId('econ:luckpanel:global').setLabel('Add +0.5% Global · 1,000').setEmoji('🌐').setStyle(Discord.ButtonStyle.Success),
        new Discord.ButtonBuilder().setCustomId('econ:luckpanel:mine').setLabel('My Luck / Purchases').setEmoji('📊').setStyle(Discord.ButtonStyle.Secondary),
        new Discord.ButtonBuilder().setCustomId('econ:luckpanel:refresh').setLabel('Refresh Modifier').setEmoji('🔄').setStyle(Discord.ButtonStyle.Secondary),
    );

    return { embeds: [embed], components: [personalRow, communityRow] };
}

function personalConfirmationPayload(economy, itemKey) {
    const item = PERSONAL_ITEMS[itemKey];
    return {
        ephemeral: true,
        embeds: [new Discord.EmbedBuilder()
            .setColor(0xd29922)
            .setTitle(`Confirm ${item.name}`)
            .setDescription(`Buy **+${item.percent}% permanent personal luck** for **${money(item.cost)} ${economy.config.currencyName}**?\n\nThis is a one-time purchase and cannot be bought twice.`)],
        components: [new Discord.ActionRowBuilder().addComponents(
            new Discord.ButtonBuilder().setCustomId(`econ:luckpanel:confirm:${item.key}`).setLabel(`Confirm ${money(item.cost)}`).setEmoji('✅').setStyle(Discord.ButtonStyle.Success),
            new Discord.ButtonBuilder().setCustomId('econ:luckpanel:cancel').setLabel('Cancel').setStyle(Discord.ButtonStyle.Secondary),
        )],
    };
}

function myLuckPayload(economy, guildId, userId) {
    const status = economy.luckShopStatus(guildId, userId);
    const owned = new Set(status.purchases.map(row => row.item_key));
    const lines = Object.values(PERSONAL_ITEMS).map(item =>
        `${owned.has(item.key) ? '✅' : '❌'} ${item.name}: +${item.percent}%${owned.has(item.key) ? ' · owned' : ''}`);
    const community = status.canContributeGlobal
        ? `You can add **+${GLOBAL_PERCENT}% global luck** now for **${money(GLOBAL_COST)} ${economy.config.currencyName}**.`
        : `Your community boost is active. You may contribute again <t:${Math.floor(status.nextGlobalAt / 1000)}:R>.`;
    return {
        ephemeral: true,
        embeds: [new Discord.EmbedBuilder().setColor(0x2ea043).setTitle('🍀 Your Luck')
            .setDescription(lines.join('\n') + `\n\n${community}`)
            .addFields(
                { name: 'Personal', value: `+${fmtPercent(status.personalLuck)}%`, inline: true },
                { name: 'Global', value: `+${fmtPercent(status.globalLuck)}%`, inline: true },
                { name: 'Total', value: `+${fmtPercent(status.totalLuck)}%`, inline: true },
                { name: 'Balance', value: `${money(status.balance)} ${economy.config.currencyName}`, inline: true },
            )],
    };
}

const previousCreateIntegration = discordEconomy.createEconomyIntegration;
discordEconomy.createEconomyIntegration = function createPersistentLuckShopIntegration(client, economy, options = {}) {
    const integration = previousCreateIntegration(client, economy, options);
    const originalHandleButton = integration.handleButton;
    let refreshTimer = null;

    async function targetGuild() {
        return client.guilds.cache.get(LUCK_SHOP_GUILD_ID) || client.guilds.fetch(LUCK_SHOP_GUILD_ID).catch(() => null);
    }

    async function targetChannel() {
        const guild = await targetGuild();
        if (!guild) return null;
        return guild.channels.cache.get(LUCK_SHOP_CHANNEL_ID) || guild.channels.fetch(LUCK_SHOP_CHANNEL_ID).catch(() => null);
    }

    async function lockChannel() {
        const guild = await targetGuild();
        const channel = await targetChannel();
        if (!guild || !channel?.isTextBased()) return;
        if (!channel.permissionOverwrites?.edit) return;
        await channel.permissionOverwrites.edit(guild.roles.everyone, {
            SendMessages: false,
            AddReactions: false,
            CreatePublicThreads: false,
            CreatePrivateThreads: false,
            SendMessagesInThreads: false,
        }).catch(error => console.warn(`Luck Shop channel permission lock failed: ${error.message}`));
    }

    async function refreshPanel() {
        const guild = await targetGuild();
        const channel = await targetChannel();
        if (!guild || !channel?.isTextBased()) return null;
        const payload = panelPayload(economy, guild.id);
        const storedId = economy.setting(guild.id, PANEL_SETTING_KEY);
        let message = storedId ? await channel.messages.fetch(storedId).catch(() => null) : null;
        if (message) await message.edit(payload).catch(() => null);
        if (!message) {
            message = await channel.send(payload);
            economy.setSetting(guild.id, PANEL_SETTING_KEY, message.id);
        }
        return message;
    }

    async function removeOldHeistPanel() {
        const guild = await targetGuild();
        const channel = await targetChannel();
        if (!guild || !channel?.isTextBased()) return;
        const oldId = economy.setting(guild.id, 'heist_panel_message');
        if (oldId) {
            const old = await channel.messages.fetch(oldId).catch(() => null);
            if (old) await old.delete().catch(() => null);
            economy.db.prepare("DELETE FROM economy_settings WHERE guild_id=? AND setting_key IN ('heist_panel_message','heist_last_announced_round')").run(guild.id);
        }
    }

    integration.handleButton = async interaction => {
        if (!interaction.isButton() || !interaction.customId.startsWith('econ:luckpanel:')) {
            return originalHandleButton(interaction);
        }
        if (interaction.guildId !== LUCK_SHOP_GUILD_ID) return false;

        const parts = interaction.customId.split(':');
        const action = parts[2];
        const itemKey = parts[3];
        try {
            if (action === 'buy' && PERSONAL_ITEMS[itemKey]) {
                await interaction.reply(personalConfirmationPayload(economy, itemKey));
                return true;
            }
            if (action === 'confirm' && PERSONAL_ITEMS[itemKey]) {
                const result = economy.buyLuckItem(interaction.guild.id, interaction.user.id, itemKey, interaction.id);
                await interaction.update({
                    embeds: [new Discord.EmbedBuilder().setColor(0x2ea043).setTitle('✅ Purchase Complete')
                        .setDescription(`You bought **${result.item.name}** for **${money(result.item.cost)} ${economy.config.currencyName}**.\nYour permanent personal luck is now **+${fmtPercent(result.personalLuck)}%**.\nBalance: **${money(result.balance)}**.`)],
                    components: [],
                });
                await refreshPanel();
                return true;
            }
            if (action === 'cancel') {
                await interaction.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
                return true;
            }
            if (action === 'global') {
                const result = economy.contributeGlobalLuck(interaction.guild.id, interaction.user.id, interaction.id);
                await interaction.reply({
                    ephemeral: true,
                    content: `🌐 You instantly added **+${GLOBAL_PERCENT}% global luck** for 24 hours. Current global modifier: **+${fmtPercent(result.globalLuck)}%**. Balance: **${money(result.balance)} ${economy.config.currencyName}**.`,
                });
                await refreshPanel();
                return true;
            }
            if (action === 'mine') {
                await interaction.reply(myLuckPayload(economy, interaction.guild.id, interaction.user.id));
                return true;
            }
            if (action === 'refresh') {
                await interaction.deferUpdate();
                await refreshPanel();
                return true;
            }
        } catch (error) {
            const payload = { content: `❌ ${error.message}`, ephemeral: true };
            if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
            else await interaction.reply(payload).catch(() => {});
            return true;
        }
        return true;
    };

    client.on('messageCreate', async message => {
        if (message.guild?.id !== LUCK_SHOP_GUILD_ID || message.channelId !== LUCK_SHOP_CHANNEL_ID) return;
        if (message.author?.bot) return;
        await message.delete().catch(() => {});
    });

    client.once('ready', async () => {
        await removeOldHeistPanel().catch(() => {});
        await lockChannel().catch(() => {});
        await refreshPanel().catch(error => console.error(`Luck Shop panel startup failed: ${error.message}`));
        refreshTimer = setInterval(() => {
            refreshPanel().catch(error => console.error(`Luck Shop panel refresh failed: ${error.message}`));
        }, 60 * 1000);
        refreshTimer.unref?.();
    });

    const previousStop = integration.stop;
    integration.stop = async (...args) => {
        if (refreshTimer) clearInterval(refreshTimer);
        return previousStop?.(...args);
    };

    integration.refreshLuckShopPanel = refreshPanel;
    return integration;
};

module.exports = {
    LUCK_SHOP_GUILD_ID,
    LUCK_SHOP_CHANNEL_ID,
    PANEL_SETTING_KEY,
    panelPayload,
    publicLuckState,
};
