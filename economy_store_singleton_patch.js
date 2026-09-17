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
            if (!channel?.isTextBased()) return;

            const batch = await channel.messages.fetch({ limit: 100 }).catch(() => null);
            const botId = client.user?.id;
            const storeMessages = batch
                ? [...batch.values()].filter(message => message.author?.id === botId && isStorePanel(message))
                : [];

            const alreadyRebuilt = economy.setting(STORE_GUILD_ID, REBUILD_SETTING) === 'complete';
            const storedId = economy.setting(STORE_GUILD_ID, STORE_PANEL_SETTING) || '';
            const stored = storeMessages.find(message => message.id === storedId) || null;
            const hasOldButtons = stored?.components?.some(row => row.components?.some(component => {
                const id = String(component.customId || component.data?.custom_id || '');
                return id.includes('loaded-van') || id.includes('pvp-contract');
            }));

            if (!alreadyRebuilt || hasOldButtons || storeMessages.length > 1 || !stored) {
                for (const message of storeMessages) await message.delete().catch(() => {});
                economy.setSetting(STORE_GUILD_ID, STORE_PANEL_SETTING, '');
                const fresh = await integration.refreshLuckShopPanel?.().catch(() => null);
                if (fresh) economy.setSetting(STORE_GUILD_ID, STORE_PANEL_SETTING, fresh.id);
                economy.setSetting(STORE_GUILD_ID, REBUILD_SETTING, 'complete');
            }
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
