'use strict';

const Discord = require('discord.js');

const STORE_CHANNEL_ID = '1532787416098672750';
const PATCH_FLAG = Symbol.for('commission.storeCanonicalApexGuard');

function isLuckShopPayload(payload) {
    const embeds = payload?.embeds || [];
    return embeds.some(embed => {
        const data = typeof embed?.toJSON === 'function' ? embed.toJSON() : (embed?.data || embed || {});
        return data.title === '🍀 The Commission · Luck & Heist Shop';
    });
}

function hasApexLuck(payload) {
    const embeds = payload?.embeds || [];
    return embeds.some(embed => {
        const data = typeof embed?.toJSON === 'function' ? embed.toJSON() : (embed?.data || embed || {});
        return String(data.description || '').includes('Apex Luck');
    });
}

function installStoreCanonicalGuard() {
    if (Discord.Message?.prototype?.[PATCH_FLAG]) return;
    const originalEdit = Discord.Message.prototype.edit;
    Object.defineProperty(Discord.Message.prototype, PATCH_FLAG, { value: true });

    Discord.Message.prototype.edit = async function canonicalLuckShopEdit(payload, ...rest) {
        const channelId = String(this.channelId || this.channel?.id || '');
        if (channelId === STORE_CHANNEL_ID && isLuckShopPayload(payload) && !hasApexLuck(payload)) {
            return this;
        }
        return originalEdit.call(this, payload, ...rest);
    };
}

module.exports = { installStoreCanonicalGuard };
