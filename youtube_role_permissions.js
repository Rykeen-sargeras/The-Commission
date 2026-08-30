'use strict';

const Discord = require('discord.js');

const TARGET_ROLE_IDS = Object.freeze([
    '1532514409904082979',
    '1532515201579094270',
    '1542007552710287443',
    '1541632068985950281',
    '1532514409904082978',
    '1532515201579094269',
    '1532514409904082977',
    '1532515201579094268',
    '1541632068985950280',
    '1542007552710287442',
    '1532514409904082976',
    '1532515201579094267',
    '1541632068985950279',
    '1542007552710287441',
]);

const CATEGORY_IDS = Object.freeze({
    announcement: '1532513761573863577',
    text: '1532513763918483497',
    liveOnAir: '1532513765701189683',
    voice: '1532513764660871180',
});

const INSTALL_KEY = Symbol.for('the-commission.youtube-permissions-installed');
const PATCH_KEY = Symbol.for('the-commission.youtube-permissions-client-patch');

const STANDARD_PERMISSION_NAMES = Object.freeze([
    'ViewChannel',
    'Connect',
    'SendMessages',
    'ReadMessageHistory',
    'AddReactions',
    'EmbedLinks',
    'AttachFiles',
    'UseExternalEmojis',
    'UseExternalStickers',
    'CreatePublicThreads',
    'CreatePrivateThreads',
    'SendMessagesInThreads',
    'Speak',
    'Stream',
    'UseVAD',
]);

const READ_ONLY_PERMISSION_NAMES = Object.freeze([
    'ViewChannel',
    'ReadMessageHistory',
    'AddReactions',
    'UseExternalEmojis',
]);

const LANDING_PAD_PERMISSION_NAMES = Object.freeze([
    ...STANDARD_PERMISSION_NAMES.filter(name => name !== 'Connect'),
    'MentionEveryone',
    'ManageMessages',
    'ManageThreads',
    'MuteMembers',
    'DeafenMembers',
]);

function bitfield(value) {
    return BigInt(value?.bitfield ?? value ?? 0n);
}

function permissionBits(names) {
    return names.reduce((permissions, name) => {
        const flag = Discord.PermissionFlagsBits?.[name];
        return flag === undefined ? permissions : permissions | bitfield(flag);
    }, 0n);
}

function allPermissionBits() {
    if (Discord.PermissionsBitField?.All !== undefined) {
        return bitfield(Discord.PermissionsBitField.All);
    }
    return Object.values(Discord.PermissionFlagsBits || {}).reduce(
        (permissions, flag) => permissions | bitfield(flag),
        0n,
    );
}

function normalizeChannelName(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function channelCategoryId(channel) {
    const id = String(channel?.id || '');
    if (Object.values(CATEGORY_IDS).includes(id)) return id;
    return String(channel?.parentId || channel?.parent?.id || '');
}

function permissionProfileForChannel(channel) {
    const categoryId = channelCategoryId(channel);
    const name = normalizeChannelName(channel?.name);

    if (categoryId === CATEGORY_IDS.announcement) {
        if (name === 'verify membership') {
            return permissionBits(['ViewChannel', 'ReadMessageHistory']);
        }
        if (name === 'landing pad') {
            return permissionBits(LANDING_PAD_PERMISSION_NAMES);
        }
        return permissionBits(READ_ONLY_PERMISSION_NAMES);
    }

    if (categoryId === CATEGORY_IDS.text || categoryId === CATEGORY_IDS.voice) {
        return permissionBits(STANDARD_PERMISSION_NAMES);
    }

    if (categoryId === CATEGORY_IDS.liveOnAir) {
        const namesWithoutConnect = new Set(['live 1', 'live 2']);
        const permissions = namesWithoutConnect.has(name)
            ? STANDARD_PERMISSION_NAMES.filter(permission => permission !== 'Connect')
            : STANDARD_PERMISSION_NAMES;
        return permissionBits(permissions);
    }

    return null;
}

function serializeOverwrite(overwrite) {
    return {
        id: overwrite.id,
        type: overwrite.type,
        allow: bitfield(overwrite.allow),
        deny: bitfield(overwrite.deny),
    };
}

function planRoleOverwrites(overwrites, targetRoleIds, desiredPermissions) {
    const current = [...overwrites.values()];
    const targetIds = new Set(targetRoleIds.map(String));
    const allow = bitfield(desiredPermissions);
    const deny = allPermissionBits() & ~allow;
    let changed = false;

    for (const targetId of targetIds) {
        const existing = current.find(overwrite => String(overwrite.id) === targetId);
        if (!existing || bitfield(existing.allow) !== allow || bitfield(existing.deny) !== deny) {
            changed = true;
        }
    }
    if (!changed) return { changed: false, overwrites: current.map(serializeOverwrite) };

    const output = current
        .filter(overwrite => !targetIds.has(String(overwrite.id)))
        .map(serializeOverwrite);
    for (const targetId of targetIds) {
        output.push({ id: targetId, type: Discord.OverwriteType.Role, allow, deny });
    }
    return { changed: true, overwrites: output };
}

async function syncConfiguredRolePermissions(guild, options = {}) {
    const logger = options.logger || console;
    const requestedRoleIds = options.targetRoleIds || TARGET_ROLE_IDS;
    await guild.roles.fetch().catch(() => null);
    await guild.channels.fetch().catch(() => null);
    for (const categoryId of Object.values(CATEGORY_IDS)) {
        await guild.channels.fetch(categoryId).catch(() => null);
    }

    const targetRoleIds = requestedRoleIds
        .map(String)
        .filter(roleId => guild.roles.cache.has(roleId));
    const missingRoleIds = requestedRoleIds.map(String).filter(roleId => !guild.roles.cache.has(roleId));
    if (!targetRoleIds.length) {
        return { ok: false, reason: 'configured-roles-not-found', missingRoleIds };
    }

    let changedChannels = 0;
    const failedChannels = [];
    for (const channel of guild.channels.cache.values()) {
        const desiredPermissions = permissionProfileForChannel(channel);
        if (desiredPermissions === null) continue;
        if (!channel.permissionOverwrites?.cache || typeof channel.permissionOverwrites.set !== 'function') continue;
        const plan = planRoleOverwrites(channel.permissionOverwrites.cache, targetRoleIds, desiredPermissions);
        if (!plan.changed) continue;
        try {
            await channel.permissionOverwrites.set(
                plan.overwrites,
                'Apply configured channel permissions to the specified roles',
            );
            changedChannels += 1;
        } catch (error) {
            failedChannels.push({ id: channel.id, name: channel.name, error: error.message });
            logger.warn?.(`[configured-role-sync] Could not synchronize #${channel.name}: ${error.message}`);
        }
    }

    const result = { ok: true, targetRoleIds, missingRoleIds, changedChannels, failedChannels };
    logger.log?.(`[configured-role-sync] Updated ${targetRoleIds.length} configured roles across ${changedChannels} channel(s).`);
    return result;
}

function installConfiguredRolePermissionSync(client, options = {}) {
    if (!client || client[INSTALL_KEY]) return client;
    client[INSTALL_KEY] = true;
    const timers = new Map();
    const queues = new Map();

    const schedule = (guild, delay = 2500) => {
        if (!guild) return;
        clearTimeout(timers.get(guild.id));
        timers.set(guild.id, setTimeout(() => {
            timers.delete(guild.id);
            const previous = queues.get(guild.id) || Promise.resolve();
            const next = previous
                .catch(() => null)
                .then(() => syncConfiguredRolePermissions(guild, options))
                .catch(error => (options.logger || console).error?.(`[configured-role-sync] ${guild.id}:`, error));
            queues.set(guild.id, next);
        }, delay));
    };

    client.on(Discord.Events.ClientReady || 'ready', () => {
        for (const guild of client.guilds.cache.values()) schedule(guild, 5000);
    });
    for (const event of ['roleCreate', 'roleUpdate', 'roleDelete', 'channelCreate', 'channelUpdate', 'channelDelete']) {
        client.on(event, (...args) => {
            const subject = args.at(-1) || args[0];
            schedule(subject?.guild || args[0]?.guild);
        });
    }
    return client;
}

function patchDiscordClient() {
    const proto = Discord.Client?.prototype;
    if (!proto || proto[PATCH_KEY]) return;
    Object.defineProperty(proto, PATCH_KEY, { value: true, configurable: false });
    const originalLogin = proto.login;
    proto.login = function patchedConfiguredPermissionLogin(...args) {
        installConfiguredRolePermissionSync(this);
        return originalLogin.apply(this, args);
    };
}

patchDiscordClient();

module.exports = {
    CATEGORY_IDS,
    LANDING_PAD_PERMISSION_NAMES,
    READ_ONLY_PERMISSION_NAMES,
    STANDARD_PERMISSION_NAMES,
    TARGET_ROLE_IDS,
    channelCategoryId,
    installConfiguredRolePermissionSync,
    normalizeChannelName,
    patchDiscordClient,
    permissionBits,
    permissionProfileForChannel,
    planRoleOverwrites,
    syncConfiguredRolePermissions,
};

