'use strict';

function createPanelUpserter(economy, { now = Date.now, verifyIntervalMs = 60 * 60 * 1000 } = {}) {
    const cache = new Map();

    return async function upsertPanel(guild, channelId, settingKey, payload, force = false) {
        if (!channelId) return null;
        const storedId = economy.setting(guild.id, settingKey);
        const cacheKey = `${guild.id}:${channelId}:${settingKey}`;
        // Panel timestamps are decorative; changing only the timestamp should not edit Discord.
        const fingerprint = JSON.stringify(payload, (key, value) => key === 'timestamp' ? undefined : value);
        const previous = cache.get(cacheKey);
        if (!force && storedId && previous?.messageId === storedId && previous.fingerprint === fingerprint
            && now() - previous.checkedAt < verifyIntervalMs) return { id: storedId };

        const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased()) return null;
        const verify = force || (previous?.messageId === storedId && now() - previous.checkedAt >= verifyIntervalMs);
        let message = storedId ? (verify
            ? await channel.messages.fetch({ message: storedId, force: true }).catch(() => null)
            : channel.messages.cache.get(storedId) || await channel.messages.fetch(storedId).catch(() => null)) : null;
        if (!force && message && previous?.messageId === storedId && previous.fingerprint === fingerprint) {
            cache.set(cacheKey, { messageId: storedId, fingerprint, checkedAt: now() });
            return message;
        }
        if (message) message = await message.edit(payload);
        else {
            message = await channel.send(payload);
            economy.setSetting(guild.id, settingKey, message.id);
        }
        cache.set(cacheKey, { messageId: message.id, fingerprint, checkedAt: now() });
        return message;
    };
}

module.exports = { createPanelUpserter };
