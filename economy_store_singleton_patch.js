'use strict';

const Discord = require('discord.js');
const discordEconomy = require('./economy_discord');

const STORE_GUILD_ID = '1532503754350264571';
const STORE_CHANNEL_ID = '1532787416098672750';
const STORE_PANEL_SETTING = 'luck_shop_panel_message';
const REBUILD_SETTING = 'luck_shop_singleton_rebuilt_hot_tip_goon_v1';
const PATCH_FLAG = Symbol.for('commission.storeSingletonLowChurn');

function jsonValue(value) {
    if (!value) return value;
    if (typeof value.toJSON === 'function') return value.toJSON();
    if (value.data) return value.data;
    return value;
}

function stripVolatile(value) {
    if (Array.isArray(value)) return value.map(stripVolatile);
    if (!value || typeof value !== 'object') return value;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
        if (key === 'timestamp') continue;
        output[key] = stripVolatile(child);
    }
    return output;
}

function stablePayload(payload) {
    return JSON.stringify(stripVolatile({
        content: payload?.content ?? '',
        embeds: (payload?.embeds || []).map(jsonValue),
        components: (payload?.components || []).map(jsonValue),
    }));
}

function stableMessage(message) {
    return JSON.stringify(stripVolatile({
        content: message?.content ?? '',
        embeds: (message?.embeds || []).map(embed => embed?.data || embed),
        components: (message?.components || []).map(component => component?.toJSON?.() || component),
    }));
}

function isStorePanel(message) {
    if (!message) return false;
    if (message.embeds?.some(embed => (embed.data?.title || embed.title) === '🍀 The Commission · Luck & Heist Shop')) return true;
    return message.components?.some(row => row.components?.some(component =>
        String(component.customId || component.data?.custom_id || '').startsWith('econ:luckpanel:')));
}

function installDiscordLowChurnGuards() {
    if (Discord.Message?.prototype?.[PATCH_FLAG]) return;
    Object.defineProperty(Discord.Message.prototype, PATCH_FLAG, { value: true });

    const originalEdit = Discord.Message.prototype.edit;
    Discord.Message.prototype.edit = async function lowChurnStoreEdit(payload, ...rest) {
        if (String(this.channelId || this.channel?.id || '') === STORE_CHANNEL_ID) {
            try {
                if (stablePayload(payload) === stableMessage(this)) return this;
            } catch {}
        }
        return originalEdit.call(this, payload, ...rest);
    };

    const managerPrototype = Discord.MessageManager?.prototype;
    if (managerPrototype?.fetch && !managerPrototype[PATCH_FLAG]) {
        Object.defineProperty(managerPrototype, PATCH_FLAG, { value: true });
        const originalFetch = managerPrototype.fetch;
        managerPrototype.fetch = function cachedStoreFetch(options, ...rest) {
            const channelId = String(this.channel?.id || '');
            const messageId = typeof options === 'string' ? options : options?.message;
            if (channelId === STORE_CHANNEL_ID && messageId && this.cache?.has(messageId)) {
                return Promise.resolve(this.cache.get(messageId));
            }
            return originalFetch.call(this, options, ...rest);
        };
    }
}

function installStoreSingletonPatch() {
    installDiscordLowChurnGuards();
    const previousCreateIntegration = discordEconomy.createEconomyIntegration;

    discordEconomy.createEconomyIntegration = function createStoreSingletonIntegration(client, economy, options = {}) {
        const integration = previousCreateIntegration(client, economy, options);

        async function getStoreChannel() {
            const guild = client.guilds.cache.get(STORE_GUILD_ID) || await client.guilds.fetch(STORE_GUILD_ID).catch(() => null);
            if (!guild) return null;
            return guild.channels.cache.get(STORE_CHANNEL_ID) || await guild.channels.fetch(STORE_CHANNEL_ID).catch(() => null);
        }

        async function rebuildStorePanelOnce() {
            const channel = await getStoreChannel();
            if (!channel?.isTextBased()) return null;

            const storedId = economy.setting(STORE_GUILD_ID, STORE_PANEL_SETTING) || '';
            if (storedId) {
                try {
                    const stored = channel.messages.cache.get(storedId)
                        || await channel.messages.fetch(storedId);
                    if (stored) {
                        economy.setSetting(STORE_GUILD_ID, REBUILD_SETTING, 'complete');
                        return stored;
                    }
                } catch (error) {
                    // Only recreate when Discord explicitly says the saved message was deleted.
                    // Transient API/rate-limit/network errors must never create duplicate store cards.
                    if (Number(error?.code) !== 10008) {
                        console.warn(`Store singleton verification failed without recreating panel: ${error.message}`);
                        return null;
                    }
                }
            }

            const fresh = await integration.refreshLuckShopPanel?.().catch(error => {
                console.error(`Store singleton recreation failed: ${error.message}`);
                return null;
            });
            if (fresh) {
                economy.setSetting(STORE_GUILD_ID, STORE_PANEL_SETTING, fresh.id);
                economy.setSetting(STORE_GUILD_ID, REBUILD_SETTING, 'complete');
            }
            return fresh || null;
        }

        const start = () => setTimeout(() => {
            rebuildStorePanelOnce().catch(error => console.error(`Store singleton rebuild failed: ${error.message}`));
        }, 3_000).unref?.();

        if (client.isReady?.()) start(); else client.once('ready', start);
        integration.rebuildStorePanelOnce = rebuildStorePanelOnce;
        return integration;
    };
}

module.exports = {
    STORE_CHANNEL_ID,
    installStoreSingletonPatch,
};
