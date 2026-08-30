'use strict';

const Discord = require('discord.js');

const SOURCE_ROLE_NAME = 'Scooter VIP';
const INSTALL_KEY = Symbol.for('the-commission.youtube-permissions-installed');
const PATCH_KEY = Symbol.for('the-commission.youtube-permissions-client-patch');

function normalizeRoleName(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function integrationId(role) {
    return String(role?.tags?.integrationId || role?.tags?.integration_id || '').trim();
}

async function fetchYouTubeIntegrationIds(guild, logger = console) {
    let integrations = null;
    try {
        if (typeof guild.fetchIntegrations === 'function') integrations = await guild.fetchIntegrations();
        else if (typeof guild.integrations?.fetch === 'function') integrations = await guild.integrations.fetch();
    } catch (error) {
        logger.warn?.(`[youtube-role-sync] Could not list guild integrations: ${error.message}`);
    }
    if (!integrations) return new Set();
    return new Set(
        [...integrations.values()]
            .filter(integration => String(integration?.type || '').toLowerCase() === 'youtube')
            .map(integration => String(integration.id || '').trim())
            .filter(Boolean),
    );
}

function youtubeRoleSet(guild, sourceName = SOURCE_ROLE_NAME, youtubeIntegrationIds = new Set()) {
    const roles = [...guild.roles.cache.values()];
    const source = roles.find(role => normalizeRoleName(role.name) === normalizeRoleName(sourceName)) || null;
    if (!source) return { source: null, targets: [], integrationIds: [] };
    const sourceIntegrationId = integrationId(source);
    const allowedIds = new Set([...youtubeIntegrationIds].map(String).filter(Boolean));
    // If Discord will not expose the integration list, retain the safe legacy
    // fallback and synchronize roles belonging to Scooter VIP's integration.
    if (!allowedIds.size && sourceIntegrationId) allowedIds.add(sourceIntegrationId);
    const targets = roles.filter(role => (
        role.id !== source.id
        && allowedIds.has(integrationId(role))
    ));
    return { source, targets, integrationIds: [...allowedIds] };
}

function bitfield(value) {
    return BigInt(value?.bitfield ?? value ?? 0n);
}

function serializeOverwrite(overwrite) {
    return {
        id: overwrite.id,
        type: overwrite.type,
        allow: bitfield(overwrite.allow),
        deny: bitfield(overwrite.deny),
    };
}

function planChannelOverwrites(overwrites, sourceRoleId, targetRoleIds) {
    const current = [...overwrites.values()];
    const source = current.find(overwrite => String(overwrite.id) === String(sourceRoleId)) || null;
    const targetIds = new Set(targetRoleIds.map(String));
    let changed = false;

    for (const overwrite of current) {
        if (!targetIds.has(String(overwrite.id))) continue;
        if (!source || bitfield(overwrite.allow) !== bitfield(source.allow) || bitfield(overwrite.deny) !== bitfield(source.deny)) {
            changed = true;
        }
    }
    if (source) {
        for (const targetId of targetIds) {
            if (!current.some(overwrite => String(overwrite.id) === targetId)) changed = true;
        }
    }
    if (!changed) return { changed: false, overwrites: current.map(serializeOverwrite) };

    const output = current
        .filter(overwrite => !targetIds.has(String(overwrite.id)))
        .map(serializeOverwrite);
    if (source) {
        for (const targetId of targetIds) {
            output.push({
                id: targetId,
                type: Discord.OverwriteType.Role,
                allow: bitfield(source.allow),
                deny: bitfield(source.deny),
            });
        }
    }
    return { changed: true, overwrites: output };
}

async function syncGuildYouTubeRolePermissions(guild, options = {}) {
    const logger = options.logger || console;
    await guild.roles.fetch().catch(() => null);
    await guild.channels.fetch().catch(() => null);

    const youtubeIntegrationIds = await fetchYouTubeIntegrationIds(guild, logger);
    const { source, targets, integrationIds } = youtubeRoleSet(
        guild,
        options.sourceRoleName || SOURCE_ROLE_NAME,
        youtubeIntegrationIds,
    );
    if (!source) {
        return { ok: false, reason: 'source-role-missing', sourceRoleName: options.sourceRoleName || SOURCE_ROLE_NAME };
    }
    if (!integrationIds.length) {
        return { ok: false, reason: 'youtube-integrations-not-found', sourceRoleName: source.name };
    }
    if (!targets.length) {
        return { ok: true, sourceRoleName: source.name, targetRoleNames: [], changedRoles: 0, changedChannels: 0 };
    }

    let changedRoles = 0;
    let changedChannels = 0;
    const sourcePermissions = bitfield(source.permissions);
    for (const role of targets) {
        if (bitfield(role.permissions) === sourcePermissions) continue;
        if (role.editable === false || typeof role.setPermissions !== 'function') {
            logger.warn?.(`[youtube-role-sync] Discord manages ${role.name}; base permissions cannot be edited directly. Channel overrides will still be synchronized.`);
            continue;
        }
        try {
            await role.setPermissions(source.permissions, `Match YouTube integration role permissions to ${source.name}`);
            changedRoles += 1;
        } catch (error) {
            logger.warn?.(`[youtube-role-sync] Could not copy base permissions to ${role.name}: ${error.message}`);
        }
    }

    const targetIds = targets.map(role => role.id);
    for (const channel of guild.channels.cache.values()) {
        if (!channel.permissionOverwrites?.cache || typeof channel.permissionOverwrites.set !== 'function') continue;
        const plan = planChannelOverwrites(channel.permissionOverwrites.cache, source.id, targetIds);
        if (!plan.changed) continue;
        try {
            await channel.permissionOverwrites.set(
                plan.overwrites,
                `Match YouTube integration roles to ${source.name}`,
            );
            changedChannels += 1;
        } catch (error) {
            logger.warn?.(`[youtube-role-sync] Could not synchronize #${channel.name}: ${error.message}`);
        }
    }

    const result = {
        ok: true,
        sourceRoleName: source.name,
        youtubeIntegrationIds: integrationIds,
        targetRoleNames: targets.map(role => role.name),
        changedRoles,
        changedChannels,
    };
    logger.log?.(`[youtube-role-sync] ${source.name} -> ${result.targetRoleNames.join(', ') || 'no sibling roles'}; ${changedRoles} role permission set(s), ${changedChannels} channel override set(s) changed.`);
    return result;
}

function installYouTubeRolePermissionSync(client, options = {}) {
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
                .then(() => syncGuildYouTubeRolePermissions(guild, options))
                .catch(error => (options.logger || console).error?.(`[youtube-role-sync] ${guild.id}:`, error));
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
    proto.login = function patchedYouTubePermissionLogin(...args) {
        installYouTubeRolePermissionSync(this);
        return originalLogin.apply(this, args);
    };
}

patchDiscordClient();

module.exports = {
    SOURCE_ROLE_NAME,
    fetchYouTubeIntegrationIds,
    integrationId,
    installYouTubeRolePermissionSync,
    normalizeRoleName,
    patchDiscordClient,
    planChannelOverwrites,
    syncGuildYouTubeRolePermissions,
    youtubeRoleSet,
};

