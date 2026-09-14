'use strict';

// Hard safety rail: The Commission may read channel permission overwrites, but it
// must not modify overwrites on channels that already exist. Permission overwrites
// supplied as part of guild.channels.create(...) are unaffected, so bot-created
// private/ticket/jail channels can still be created with the access they need.

const INSTALL_KEY = Symbol.for('the-commission.channel-permission-safety-installed');
const PROTECTED_MANAGERS = new WeakSet();

function channelLabel(channel) {
    const name = String(channel?.name || '').trim();
    return name ? `#${name} (${channel.id})` : String(channel?.id || 'unknown-channel');
}

function protectChannelPermissionOverwrites(channel, logger = console) {
    const manager = channel?.permissionOverwrites;
    if (!manager || PROTECTED_MANAGERS.has(manager)) return channel;

    PROTECTED_MANAGERS.add(manager);
    for (const methodName of ['set', 'edit', 'delete']) {
        if (typeof manager[methodName] !== 'function') continue;

        Object.defineProperty(manager, methodName, {
            configurable: false,
            enumerable: false,
            writable: false,
            value: async function blockedChannelPermissionMutation() {
                logger.warn?.(
                    `[channel-permission-safety] Blocked permissionOverwrites.${methodName} on ${channelLabel(channel)}.`,
                );
                return channel;
            },
        });
    }

    return channel;
}

function protectGuildChannels(guild, logger = console) {
    const channels = guild?.channels?.cache;
    if (!channels?.values) return guild;
    for (const channel of channels.values()) {
        protectChannelPermissionOverwrites(channel, logger);
    }
    return guild;
}

function installChannelPermissionSafety(client, options = {}) {
    if (!client || client[INSTALL_KEY]) return client;
    client[INSTALL_KEY] = true;
    const logger = options.logger || console;

    const protectAllGuilds = () => {
        const guilds = client.guilds?.cache;
        if (!guilds?.values) return;
        for (const guild of guilds.values()) protectGuildChannels(guild, logger);
    };

    // Patch anything already cached immediately, then patch again on ready.
    protectAllGuilds();

    if (typeof client.on !== 'function') return client;

    client.on('ready', protectAllGuilds);
    client.on('guildCreate', guild => protectGuildChannels(guild, logger));
    client.on('channelCreate', channel => protectChannelPermissionOverwrites(channel, logger));
    client.on('channelUpdate', (_oldChannel, newChannel) => {
        protectChannelPermissionOverwrites(newChannel, logger);
    });

    return client;
}

module.exports = {
    installChannelPermissionSafety,
    protectChannelPermissionOverwrites,
    protectGuildChannels,
};
