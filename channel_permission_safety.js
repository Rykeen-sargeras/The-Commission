'use strict';

// Hard safety rail: The Commission may read channel permission overwrites, but it
// must not modify overwrites on channels that already exist EXCEPT for the jail
// system changing permissions for the jailed member. Permission overwrites supplied
// as part of guild.channels.create(...) are unaffected.

const INSTALL_KEY = Symbol.for('the-commission.channel-permission-safety-installed');
const PROTECTED_MANAGERS = new WeakSet();
const JAIL_ROLE_ID = String(process.env.JAIL_ROLE_ID || '').trim();

function channelLabel(channel) {
    const name = String(channel?.name || '').trim();
    return name ? `#${name} (${channel.id})` : String(channel?.id || 'unknown-channel');
}

function targetId(target) {
    if (!target) return '';
    if (typeof target === 'string') return target;
    return String(target.id || target.user?.id || '').trim();
}

function targetMember(channel, target) {
    const id = targetId(target);
    if (!id) return null;
    if (target?.roles?.cache && target?.guild) return target;
    return channel?.guild?.members?.cache?.get?.(id) || null;
}

function memberHasJailRole(channel, target) {
    if (!JAIL_ROLE_ID) return false;
    const member = targetMember(channel, target);
    return Boolean(member?.roles?.cache?.has?.(JAIL_ROLE_ID));
}

function looksLikeJailDeny(edits) {
    if (!edits || typeof edits !== 'object' || Array.isArray(edits)) return false;
    return edits.ViewChannel === false
        && edits.SendMessages === false
        && edits.Connect === false;
}

function existingOverwriteLooksJailed(channel, target) {
    const id = targetId(target);
    if (!id) return false;
    const overwrite = channel?.permissionOverwrites?.cache?.get?.(id);
    if (!overwrite) return false;

    // Only treat a member overwrite as jail-shaped when it explicitly denies the
    // three permissions used by the Commission jail isolation flow.
    const deny = overwrite.deny;
    if (!deny?.has) return false;
    try {
        const Discord = require('discord.js');
        return deny.has(Discord.PermissionFlagsBits.ViewChannel)
            && deny.has(Discord.PermissionFlagsBits.SendMessages)
            && deny.has(Discord.PermissionFlagsBits.Connect);
    } catch (_error) {
        return false;
    }
}

function isAllowedJailMutation(channel, methodName, args) {
    if (methodName === 'set') return false;

    const target = args[0];
    const id = targetId(target);
    if (!id) return false;

    // Never use this exception for roles. Jail isolation is a per-member exception.
    const role = channel?.guild?.roles?.cache?.get?.(id);
    if (role) return false;

    if (memberHasJailRole(channel, target)) return true;

    if (methodName === 'edit') {
        // Covers the moment the jail system applies its restrictive member overwrite
        // before Discord's member-role cache has caught up.
        return looksLikeJailDeny(args[1]);
    }

    if (methodName === 'delete') {
        // Allows unjail cleanup after the Jail role has already been removed, but
        // only when the existing overwrite itself has the jail-deny signature.
        return existingOverwriteLooksJailed(channel, target)
            || String(args[1] || '').toLowerCase().includes('jail');
    }

    return false;
}

function protectChannelPermissionOverwrites(channel, logger = console) {
    const manager = channel?.permissionOverwrites;
    if (!manager || PROTECTED_MANAGERS.has(manager)) return channel;

    PROTECTED_MANAGERS.add(manager);
    for (const methodName of ['set', 'edit', 'delete']) {
        if (typeof manager[methodName] !== 'function') continue;
        const original = manager[methodName].bind(manager);

        Object.defineProperty(manager, methodName, {
            configurable: false,
            enumerable: false,
            writable: false,
            value: async function protectedChannelPermissionMutation(...args) {
                if (isAllowedJailMutation(channel, methodName, args)) {
                    logger.log?.(
                        `[channel-permission-safety] Allowed jail member permissionOverwrites.${methodName} on ${channelLabel(channel)} for ${targetId(args[0])}.`,
                    );
                    return original(...args);
                }

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
    isAllowedJailMutation,
    looksLikeJailDeny,
    protectChannelPermissionOverwrites,
    protectGuildChannels,
};
