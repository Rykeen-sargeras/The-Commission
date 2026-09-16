'use strict';

const Discord = require('discord.js');
const discordEconomy = require('./economy_discord');

const PROTECTED_HEIST_PING_IDS = new Set();
const HEIST_PING_SETTING = 'special_heist_ping_message';
const PATCH_FLAG = Symbol.for('commission.heistPingDeleteProtection');

function isHeistPingMessage(message) {
    const content = String(message?.content || '');
    return content.includes('**A new heist has started.**')
        || content.includes('**Boss encounter started:');
}

function installDeleteProtection() {
    if (Discord.Message?.prototype?.[PATCH_FLAG]) return;
    const originalDelete = Discord.Message.prototype.delete;
    Object.defineProperty(Discord.Message.prototype, PATCH_FLAG, { value: true });
    Discord.Message.prototype.delete = async function protectedHeistPingDelete(...args) {
        if (PROTECTED_HEIST_PING_IDS.has(this.id)) return this;
        return originalDelete.apply(this, args);
    };
}

function standbyPanelPayload(economy, state) {
    const nextAt = Number(state?.nextAt || Date.now());
    const round = state?.round;
    const description = state?.phase === 'signup'
        ? `A mystery heist is currently open. Entry closes <t:${Math.floor(Number(round?.signup_ends_at || nextAt) / 1000)}:R>.`
        : `The last mystery job has ended. The next heist opens <t:${Math.floor(nextAt / 1000)}:R>.`;

    return {
        embeds: [new Discord.EmbedBuilder()
            .setColor(state?.phase === 'signup' ? 0x9b1c31 : 0x6f42c1)
            .setTitle(state?.phase === 'signup' ? '🎭 Mystery Heist · Entry Open' : '🎭 Mystery Heist · Stand By')
            .setDescription(description)
            .addFields(
                { name: 'Entry', value: `10,000 ${economy.config.currencyName}`, inline: true },
                { name: 'Schedule', value: 'Every 30 minutes', inline: true },
                { name: 'Alerts', value: 'Use **Ping Me for Heists** to toggle the `heist` role.', inline: false },
            )
            .setFooter({ text: 'Persistent heist panel · this message stays in the heist channel' })
            .setTimestamp()],
        components: [new Discord.ActionRowBuilder().addComponents(
            ...(state?.phase === 'signup' && round?.round_id ? [
                new Discord.ButtonBuilder().setCustomId(`econ:heist:join:${round.round_id}`).setLabel('Join Mystery Heist · 10K').setEmoji('🎭').setStyle(Discord.ButtonStyle.Danger),
                new Discord.ButtonBuilder().setCustomId(`econ:heist:status:${round.round_id}`).setLabel('My Entry').setStyle(Discord.ButtonStyle.Secondary),
            ] : []),
            new Discord.ButtonBuilder().setCustomId('econ:heist:notify').setLabel('Ping Me for Heists').setEmoji('🔔').setStyle(Discord.ButtonStyle.Secondary),
        )],
    };
}

function installHeistPersistencePatch() {
    installDeleteProtection();

    const previousCreateIntegration = discordEconomy.createEconomyIntegration;
    discordEconomy.createEconomyIntegration = function createPersistentHeistIntegration(client, economy, options = {}) {
        const integration = previousCreateIntegration(client, economy, options);
        const previousStop = integration.stop;
        let timer = null;

        async function heistChannel(guild) {
            const channelId = economy.config.heistChannelId;
            if (!channelId) return null;
            return guild.channels.cache.get(channelId) || guild.channels.fetch(channelId).catch(() => null);
        }

        async function protectStoredPing(guild) {
            const pingId = economy.setting(guild.id, HEIST_PING_SETTING);
            if (!pingId) return;
            const channel = await heistChannel(guild);
            if (!channel?.isTextBased()) return;
            const ping = await channel.messages.fetch(pingId).catch(() => null);
            if (ping) PROTECTED_HEIST_PING_IDS.add(ping.id);
            else {
                PROTECTED_HEIST_PING_IDS.delete(pingId);
                economy.setSetting(guild.id, HEIST_PING_SETTING, '');
            }
        }

        async function ensurePersistentPanel(guild) {
            const channel = await heistChannel(guild);
            if (!channel?.isTextBased()) return null;

            const storedId = economy.setting(guild.id, 'heist_panel_message');
            let panel = storedId ? await channel.messages.fetch(storedId).catch(() => null) : null;
            if (!panel) {
                const state = economy.heistState(guild.id);
                panel = await channel.send(standbyPanelPayload(economy, state));
                economy.setSetting(guild.id, 'heist_panel_message', panel.id);
                await integration.updateHeistPanel?.(guild).catch(() => {});
            }
            return panel;
        }

        async function registerNewPing(message) {
            if (!message?.guild || message.author?.id !== client.user?.id || !isHeistPingMessage(message)) return;
            if (message.channelId !== economy.config.heistChannelId) return;

            const guildId = message.guild.id;
            const previousId = economy.setting(guildId, HEIST_PING_SETTING);
            if (previousId && previousId !== message.id) {
                PROTECTED_HEIST_PING_IDS.delete(previousId);
                const previous = await message.channel.messages.fetch(previousId).catch(() => null);
                if (previous) await previous.delete().catch(() => {});
            }

            PROTECTED_HEIST_PING_IDS.add(message.id);
            economy.setSetting(guildId, HEIST_PING_SETTING, message.id);
        }

        client.on('messageCreate', registerNewPing);

        const start = () => {
            const refresh = () => {
                for (const guild of client.guilds.cache.values()) {
                    protectStoredPing(guild).catch(error => console.error(`Heist ping persistence error in ${guild.name}:`, error.message));
                    ensurePersistentPanel(guild).catch(error => console.error(`Heist panel persistence error in ${guild.name}:`, error.message));
                }
            };
            refresh();
            timer = setInterval(refresh, 5_000);
            timer.unref?.();
        };

        if (client.isReady?.()) start(); else client.once('ready', start);

        integration.stop = async (...args) => {
            if (timer) clearInterval(timer);
            client.off('messageCreate', registerNewPing);
            return previousStop?.(...args);
        };

        return integration;
    };
}

module.exports = {
    HEIST_PING_SETTING,
    PROTECTED_HEIST_PING_IDS,
    installHeistPersistencePatch,
    isHeistPingMessage,
    standbyPanelPayload,
};
