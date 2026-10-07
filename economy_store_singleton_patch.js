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

function isCanonicalStorePanel(message) {
    return isStorePanel(message) && message.embeds?.some(embed =>
        String(embed.data?.description || embed.description || '').includes('Apex Luck'));
}

async function findRecentStorePanel(channel) {
    const messages = await channel.messages.fetch({ limit: 50 });
    const candidates = [...messages.values()].filter(isStorePanel);
    candidates.sort((a, b) => Number(b.createdTimestamp || 0) - Number(a.createdTimestamp || 0));
    return candidates[0] || null;
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
        const previousStop = integration.stop;
        let healthTimer = null;
        let startupTimer = null;

        async function getStoreChannel() {
            const guild = client.guilds.cache.get(STORE_GUILD_ID) || await client.guilds.fetch(STORE_GUILD_ID).catch(() => null);
            if (!guild) return null;
            return guild.channels.cache.get(STORE_CHANNEL_ID) || await guild.channels.fetch(STORE_CHANNEL_ID).catch(() => null);
        }

        async function rebuildStorePanelOnce() {
            const channel = await getStoreChannel();
            if (!channel?.isTextBased()) {
                console.error(`Store singleton cannot access text channel ${STORE_CHANNEL_ID} in guild ${STORE_GUILD_ID}.`);
                return null;
            }

            const storedId = economy.setting(STORE_GUILD_ID, STORE_PANEL_SETTING) || '';
            let stored = null;
            if (storedId) {
                try {
                    stored = channel.messages.cache.get(storedId)
                        || await channel.messages.fetch(storedId);
                } catch (error) {
                    console.warn(`Store singleton saved-message lookup failed; checking channel history: ${error.message}`);
                }
            }

            if (!stored) {
                try {
                    stored = await findRecentStorePanel(channel);
                } catch (error) {
                    // If history cannot be verified, do not risk adding a duplicate card.
                    console.warn(`Store singleton history verification failed without recreating panel: ${error.message}`);
                    return null;
                }
                if (stored) economy.setSetting(STORE_GUILD_ID, STORE_PANEL_SETTING, stored.id);
                else economy.setSetting(STORE_GUILD_ID, STORE_PANEL_SETTING, '');
            }

            if (isCanonicalStorePanel(stored)) {
                economy.setSetting(STORE_GUILD_ID, REBUILD_SETTING, 'complete');
                return stored;
            }

            const fresh = await integration.refreshLuckShopPanel?.().catch(error => {
                console.error(`Store singleton recreation failed: ${error.message}`);
                return null;
            });
            const panel = fresh || stored;
            if (panel) {
                economy.setSetting(STORE_GUILD_ID, STORE_PANEL_SETTING, panel.id);
                economy.setSetting(STORE_GUILD_ID, REBUILD_SETTING, 'complete');
            } else {
                console.error(`Store singleton did not create a panel in channel ${STORE_CHANNEL_ID}.`);
            }
            return panel || null;
        }

        const start = () => {
            startupTimer = setTimeout(() => {
                startupTimer = null;
                rebuildStorePanelOnce().catch(error => console.error(`Store singleton rebuild failed: ${error.message}`));
                healthTimer = setInterval(() => {
                    rebuildStorePanelOnce().catch(error => console.error(`Store singleton health check failed: ${error.message}`));
                }, 5 * 60 * 1000);
                healthTimer.unref?.();
            }, 3_000);
            startupTimer.unref?.();
        };

        if (client.isReady?.()) start(); else client.once('ready', start);
        integration.rebuildStorePanelOnce = rebuildStorePanelOnce;
        integration.stop = async (...args) => {
            if (startupTimer) clearTimeout(startupTimer);
            if (healthTimer) clearInterval(healthTimer);
            return previousStop?.(...args);
        };
        return integration;
    };
}

module.exports = {
    STORE_CHANNEL_ID,
    findRecentStorePanel,
    isCanonicalStorePanel,
    isStorePanel,
    installStoreSingletonPatch,
};
