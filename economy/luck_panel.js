'use strict';

const Discord = require('discord.js');

const LUCK_SHOP_GUILD_ID = '1532503754350264571';
const LUCK_SHOP_CHANNEL_ID = '1532787416098672750';
const PANEL_SETTING_KEY = 'luck_shop_panel_message';

const PERSONAL_ITEMS = Object.freeze({
    'luck-1': Object.freeze({ key: 'luck-1', name: 'Lucky Break', percent: 1, cost: 5000 }),
    'luck-5': Object.freeze({ key: 'luck-5', name: 'Made Luck', percent: 5, cost: 30000 }),
    'luck-10': Object.freeze({ key: 'luck-10', name: 'Boss Luck', percent: 10, cost: 250000 }),
});
const HEIST_ITEMS = Object.freeze({
    'hot-tip': Object.freeze({ key: 'hot-tip', name: 'Hot Tip', cost: 50000, description: '+25% personal payout for your next 2 winning heists.' }),
    'hired-goon': Object.freeze({ key: 'hired-goon', name: 'Hired Goon', cost: 100000, description: 'Hire one goon for 24 hours. Up to 2 can be active. You receive 50% of each goon\'s cut and absorb 25% of its loss exposure on failed PvP battles.' }),
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
    const nextDrop = state.nextExpiry ? `<t:${Math.floor(state.nextExpiry / 1000)}:R>` : 'No active community boosts';
    const embed = new Discord.EmbedBuilder()
        .setColor(0x2ea043)
        .setTitle('🍀 The Commission · Luck & Heist Shop')
        .setDescription(
            '**Permanent Personal Luck**\n' +
            `🍀 **Lucky Break** — +1% luck — **${money(5000)} ${economy.config.currencyName}**\n` +
            `🎩 **Made Luck** — +5% luck — **${money(30000)} ${economy.config.currencyName}**\n` +
            `👑 **Boss Luck** — +10% luck — **${money(250000)} ${economy.config.currencyName}**\n\n` +
            '**Heist Items**\n' +
            `🗺️ **Hot Tip** — +25% personal payout on your next **2 winning heists** — **${money(50000)} ${economy.config.currencyName}**\n` +
            `🤵 **Hired Goon** — **${money(100000)} ${economy.config.currencyName} each** · lasts **24 hours** · max **2 active**. ` +
            'Each goon counts toward heist strength. You receive **50% of each goon\'s cut**; on a failed PvP battle you absorb **25% of its loss exposure**.\n\n' +
            'PvP robbery itself remains capped at **10% of the selected target balance**.\n\n' +
            '**Community Luck Pot**\n' +
            `Spend **${money(GLOBAL_COST)} ${economy.config.currencyName}** to add **+${GLOBAL_PERCENT}% GLOBAL luck** for 24 hours. ` +
            'Each member may contribute once per rolling 24 hours.'
        )
        .addFields(
            { name: '🌐 Current Global Modifier', value: `**+${fmtPercent(state.globalLuck)}% LUCK**`, inline: true },
            { name: '🍀 Active Community Boosts', value: String(state.activeContributions), inline: true },
            { name: '⏳ Next Modifier Drop', value: nextDrop, inline: true },
        )
        .setFooter({ text: 'Button-only shop · Hot Tip and Hired Goons are the active heist items' })
        .setTimestamp();

    const personalRow = new Discord.ActionRowBuilder().addComponents(
        new Discord.ButtonBuilder().setCustomId('econ:luckpanel:buy:luck-1').setLabel('+1% · 5,000').setEmoji('🍀').setStyle(Discord.ButtonStyle.Secondary),
        new Discord.ButtonBuilder().setCustomId('econ:luckpanel:buy:luck-5').setLabel('+5% · 30,000').setEmoji('🎩').setStyle(Discord.ButtonStyle.Primary),
        new Discord.ButtonBuilder().setCustomId('econ:luckpanel:buy:luck-10').setLabel('+10% · 250,000').setEmoji('👑').setStyle(Discord.ButtonStyle.Danger),
    );
    const heistRow = new Discord.ActionRowBuilder().addComponents(
        new Discord.ButtonBuilder().setCustomId('econ:luckpanel:heistbuy:hot-tip').setLabel('Hot Tip · 50K').setEmoji('🗺️').setStyle(Discord.ButtonStyle.Primary),
        new Discord.ButtonBuilder().setCustomId('econ:luckpanel:heistbuy:hired-goon').setLabel('Hire Goon · 100K').setEmoji('🤵').setStyle(Discord.ButtonStyle.Danger),
    );
    const communityRow = new Discord.ActionRowBuilder().addComponents(
        new Discord.ButtonBuilder().setCustomId('econ:luckpanel:global').setLabel('Add +0.5% Global · 1,000').setEmoji('🌐').setStyle(Discord.ButtonStyle.Success),
        new Discord.ButtonBuilder().setCustomId('econ:luckpanel:mine').setLabel('My Luck / Inventory').setEmoji('📊').setStyle(Discord.ButtonStyle.Secondary),
        new Discord.ButtonBuilder().setCustomId('econ:luckpanel:refresh').setLabel('Refresh').setEmoji('🔄').setStyle(Discord.ButtonStyle.Secondary),
    );
    return { embeds: [embed], components: [personalRow, heistRow, communityRow] };
}

function personalConfirmationPayload(economy, itemKey) {
    const item = PERSONAL_ITEMS[itemKey];
    return {
        ephemeral: true,
        embeds: [new Discord.EmbedBuilder().setColor(0xd29922).setTitle(`Confirm ${item.name}`)
            .setDescription(`Buy **+${item.percent}% permanent personal luck** for **${money(item.cost)} ${economy.config.currencyName}**?\n\nThis is a one-time purchase and cannot be bought twice.`)],
        components: [new Discord.ActionRowBuilder().addComponents(
            new Discord.ButtonBuilder().setCustomId(`econ:luckpanel:confirm:${item.key}`).setLabel(`Confirm ${money(item.cost)}`).setEmoji('✅').setStyle(Discord.ButtonStyle.Success),
            new Discord.ButtonBuilder().setCustomId('econ:luckpanel:cancel').setLabel('Cancel').setStyle(Discord.ButtonStyle.Secondary),
        )],
    };
}

function heistConfirmationPayload(economy, itemKey) {
    const item = HEIST_ITEMS[itemKey];
    return {
        ephemeral: true,
        embeds: [new Discord.EmbedBuilder().setColor(0xd29922).setTitle(`Confirm ${item.name}`)
            .setDescription(`${item.description}\n\nCost: **${money(item.cost)} ${economy.config.currencyName}**.`)],
        components: [new Discord.ActionRowBuilder().addComponents(
            new Discord.ButtonBuilder().setCustomId(`econ:luckpanel:heistconfirm:${item.key}`).setLabel(`Confirm ${money(item.cost)}`).setEmoji('✅').setStyle(Discord.ButtonStyle.Success),
            new Discord.ButtonBuilder().setCustomId('econ:luckpanel:cancel').setLabel('Cancel').setStyle(Discord.ButtonStyle.Secondary),
        )],
    };
}

function myLuckPayload(economy, guildId, userId) {
    const status = economy.luckShopStatus(guildId, userId);
    const owned = new Set(status.purchases.map(row => row.item_key));
    const lines = Object.values(PERSONAL_ITEMS).map(item => `${owned.has(item.key) ? '✅' : '❌'} ${item.name}: +${item.percent}%${owned.has(item.key) ? ' · owned' : ''}`);
    const community = status.canContributeGlobal
        ? `You can add **+${GLOBAL_PERCENT}% global luck** now for **${money(GLOBAL_COST)} ${economy.config.currencyName}**.`
        : `Your community boost is active. You may contribute again <t:${Math.floor(status.nextGlobalAt / 1000)}:R>.`;
    const heist = economy.heistStoreStatus?.(guildId, userId) || { inventory: {}, balance: status.balance, goons: [] };
    const goons = heist.goons || [];
    const goonLines = goons.length ? goons.map((row, index) => `🤵 Goon ${index + 1}: expires <t:${Math.floor(row.expires_at / 1000)}:R>`).join('\n') : '🤵 No active hired goons.';
    return {
        ephemeral: true,
        embeds: [new Discord.EmbedBuilder().setColor(0x2ea043).setTitle('🍀 Your Luck & Heist Inventory')
            .setDescription(lines.join('\n') + `\n\n${community}\n\n**Heist Inventory**\n🗺️ Hot Tip uses: **${Number(heist.inventory['hot-tip'] || 0)}**\n🤵 Active Goons: **${goons.length}/2**\n${goonLines}`)
            .addFields(
                { name: 'Personal', value: `+${fmtPercent(status.personalLuck)}%`, inline: true },
                { name: 'Global', value: `+${fmtPercent(status.globalLuck)}%`, inline: true },
                { name: 'Total', value: `+${fmtPercent(status.totalLuck)}%`, inline: true },
                { name: 'Balance', value: `${money(heist.balance)} ${economy.config.currencyName}`, inline: true },
            )],
    };
}

function installLuckPanel(discordEconomy) {
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
            if (!guild || !channel?.isTextBased() || !channel.permissionOverwrites?.edit) return;
            await channel.permissionOverwrites.edit(guild.roles.everyone, {
                SendMessages: false, AddReactions: false, CreatePublicThreads: false,
                CreatePrivateThreads: false, SendMessagesInThreads: false,
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

        integration.handleButton = async interaction => {
            if (!interaction.isButton() || !interaction.customId.startsWith('econ:luckpanel:')) return originalHandleButton(interaction);
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
                    await interaction.update({ embeds: [new Discord.EmbedBuilder().setColor(0x2ea043).setTitle('✅ Purchase Complete')
                        .setDescription(`You bought **${result.item.name}** for **${money(result.item.cost)} ${economy.config.currencyName}**.\nYour permanent personal luck is now **+${fmtPercent(result.personalLuck)}%**.\nBalance: **${money(result.balance)}**.`)], components: [] });
                    await refreshPanel();
                    return true;
                }
                if (action === 'heistbuy' && HEIST_ITEMS[itemKey]) {
                    await interaction.reply(heistConfirmationPayload(economy, itemKey));
                    return true;
                }
                if (action === 'heistconfirm' && HEIST_ITEMS[itemKey]) {
                    const result = economy.buyHeistStoreItem(interaction.guild.id, interaction.user.id, itemKey, interaction.id);
                    const extra = itemKey === 'hired-goon' && result.goons?.length
                        ? `\nActive goons: **${result.goons.length}/2**.` : '';
                    await interaction.update({ embeds: [new Discord.EmbedBuilder().setColor(0x2ea043).setTitle('✅ Heist Item Purchased')
                        .setDescription(`You bought **${result.item.name}** for **${money(result.item.cost)} ${economy.config.currencyName}**.\n${result.item.description}${extra}\nBalance: **${money(result.balance)}**.`)], components: [] });
                    await refreshPanel();
                    return true;
                }
                if (action === 'cancel') {
                    await interaction.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
                    return true;
                }
                if (action === 'global') {
                    const result = economy.contributeGlobalLuck(interaction.guild.id, interaction.user.id, interaction.id);
                    await interaction.reply({ ephemeral: true, content: `🌐 You added **+${GLOBAL_PERCENT}% global luck** for 24 hours. Current global modifier: **+${fmtPercent(result.globalLuck)}%**. Balance: **${money(result.balance)} ${economy.config.currencyName}**.` });
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
            if (message.guild?.id !== LUCK_SHOP_GUILD_ID || message.channelId !== LUCK_SHOP_CHANNEL_ID || message.author?.bot) return;
            await message.delete().catch(() => {});
        });

        const start = async () => {
            await lockChannel().catch(() => {});
            await refreshPanel().catch(error => console.error(`Luck Shop panel startup failed: ${error.message}`));
            refreshTimer = setInterval(() => refreshPanel().catch(error => console.error(`Luck Shop panel refresh failed: ${error.message}`)), 60 * 1000);
            refreshTimer.unref?.();
        };
        if (client.isReady?.()) start(); else client.once('ready', start);

        const previousStop = integration.stop;
        integration.stop = async (...args) => {
            if (refreshTimer) clearInterval(refreshTimer);
            return previousStop?.(...args);
        };
        integration.refreshLuckShopPanel = refreshPanel;
        return integration;
    };
}

module.exports = {
    LUCK_SHOP_GUILD_ID,
    LUCK_SHOP_CHANNEL_ID,
    PANEL_SETTING_KEY,
    panelPayload,
    publicLuckState,
    installLuckPanel,
};
