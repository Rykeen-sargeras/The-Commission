'use strict';

const discordEconomy = require('./economy_discord');

const BALANCE_CHANNEL_SETTING = 'balance_check_channel_id';
const LEADERBOARD_SETTING = 'leaderboard_panel_message';
const REP_SETTING = 'rep_panel_message';
const CLEAN_INTERVAL_MS = 30 * 1000;

function normalizedChannelName(channel) {
    return String(channel?.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function isBalanceCheckName(channel) {
    const name = normalizedChannelName(channel);
    return name === 'balance-check'
        || name === 'balance-checks'
        || name === 'check-balance'
        || (name.includes('balance') && name.includes('check'));
}

function isLeaderboardPanel(message) {
    return message.embeds?.some(embed => (embed.data?.title || embed.title) === '🩸 Blood Money Leaderboards');
}

function isRepPanel(message) {
    return message.embeds?.some(embed => (embed.data?.title || embed.title) === '⭐ Monthly REP Leaderboard');
}

function installLeaderboardGuard() {
    const previousCreateIntegration = discordEconomy.createEconomyIntegration;

    discordEconomy.createEconomyIntegration = function createGuardedEconomyIntegration(client, economy, options = {}) {
        const integration = previousCreateIntegration(client, economy, options);
        const previousHandleCommand = integration.handleCommand;
        const previousHandleButton = integration.handleButton;
        const previousStop = integration.stop;
        let cleanupTimer = null;

        async function resolveBalanceCheckChannel(guild) {
            const stored = economy.setting(guild.id, BALANCE_CHANNEL_SETTING);
            if (stored) {
                const channel = guild.channels.cache.get(stored) || await guild.channels.fetch(stored).catch(() => null);
                if (channel?.isTextBased()) return channel;
            }

            const channels = guild.channels.cache.size
                ? guild.channels.cache
                : await guild.channels.fetch().catch(() => guild.channels.cache);
            const match = [...channels.values()].find(channel => channel?.isTextBased?.() && isBalanceCheckName(channel));
            if (match) economy.setSetting(guild.id, BALANCE_CHANNEL_SETTING, match.id);
            return match || null;
        }

        async function cleanLeaderboardChannel(guild) {
            const channelId = economy.config.leaderboardChannelId;
            if (!channelId) return;
            const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
            if (!channel?.isTextBased()) return;

            const messages = [];
            let before;
            for (let page = 0; page < 5; page += 1) {
                const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
                if (!batch?.size) break;
                const rows = [...batch.values()];
                messages.push(...rows);
                before = rows.at(-1)?.id;
                if (batch.size < 100 || !before) break;
            }

            const botId = client.user?.id;
            if (!botId) return;

            let leaderboardId = economy.setting(guild.id, LEADERBOARD_SETTING);
            let repId = economy.setting(guild.id, REP_SETTING);

            const leaderboardCandidates = messages
                .filter(message => message.author?.id === botId && isLeaderboardPanel(message))
                .sort((a, b) => Number(b.createdTimestamp || 0) - Number(a.createdTimestamp || 0));
            const repCandidates = messages
                .filter(message => message.author?.id === botId && isRepPanel(message))
                .sort((a, b) => Number(b.createdTimestamp || 0) - Number(a.createdTimestamp || 0));

            if (!leaderboardId || !messages.some(message => message.id === leaderboardId)) {
                leaderboardId = leaderboardCandidates[0]?.id || '';
                if (leaderboardId) economy.setSetting(guild.id, LEADERBOARD_SETTING, leaderboardId);
            }
            if (!repId || !messages.some(message => message.id === repId)) {
                repId = repCandidates[0]?.id || '';
                if (repId) economy.setSetting(guild.id, REP_SETTING, repId);
            }

            const keep = new Set([leaderboardId, repId].filter(Boolean));
            for (const message of messages) {
                if (message.author?.id !== botId) {
                    await message.delete().catch(() => {});
                    continue;
                }
                if ((isLeaderboardPanel(message) || isRepPanel(message)) && !keep.has(message.id)) {
                    await message.delete().catch(() => {});
                }
            }
        }

        integration.handleCommand = async interaction => {
            if (interaction.isChatInputCommand?.() && interaction.commandName === 'balance') {
                const channel = await resolveBalanceCheckChannel(interaction.guild);
                if (!channel) {
                    await interaction.reply({
                        content: '❌ I could not find the **balance-check** channel. Ask an admin to create or rename that channel.',
                        ephemeral: true,
                    }).catch(() => {});
                    return true;
                }
                if (interaction.channelId !== channel.id) {
                    await interaction.reply({
                        content: `🩸 Balance checks are restricted to <#${channel.id}>.`,
                        ephemeral: true,
                    }).catch(() => {});
                    return true;
                }
            }
            return previousHandleCommand(interaction);
        };

        integration.handleButton = async interaction => {
            if (interaction.isButton?.() && interaction.customId === 'econ:leaderboard:balance') {
                const channel = await resolveBalanceCheckChannel(interaction.guild);
                if (!channel || interaction.channelId !== channel.id) {
                    const content = channel
                        ? `🩸 Balance checks are restricted to <#${channel.id}>. Use **/balance** there.`
                        : '❌ I could not find the **balance-check** channel.';
                    await interaction.reply({ content, ephemeral: true }).catch(() => {});
                    return true;
                }
            }
            return previousHandleButton(interaction);
        };

        client.on('messageCreate', async message => {
            if (!message.guild || !economy.config.leaderboardChannelId) return;
            if (message.channelId !== economy.config.leaderboardChannelId) return;
            if (message.author?.id === client.user?.id) return;
            await message.delete().catch(() => {});
        });

        const start = () => {
            const run = () => {
                for (const guild of client.guilds.cache.values()) {
                    cleanLeaderboardChannel(guild).catch(error => console.error(`Leaderboard cleanup failed in ${guild.name}:`, error.message));
                    resolveBalanceCheckChannel(guild).catch(() => null);
                }
            };
            setTimeout(run, 5_000).unref?.();
            cleanupTimer = setInterval(run, CLEAN_INTERVAL_MS);
            cleanupTimer.unref?.();
        };
        if (client.isReady?.()) start(); else client.once('ready', start);

        integration.stop = async (...args) => {
            if (cleanupTimer) clearInterval(cleanupTimer);
            return previousStop?.(...args);
        };

        integration.cleanLeaderboardChannel = cleanLeaderboardChannel;
        return integration;
    };
}

module.exports = {
    BALANCE_CHANNEL_SETTING,
    installLeaderboardGuard,
};
