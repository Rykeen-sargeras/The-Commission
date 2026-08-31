'use strict';

const Discord = require('discord.js');

const CATEGORY_ID = String(process.env.LIVE_VOICE_CATEGORY_ID || '1532513765701189683');
const OPEN_PANEL_NAME = '🟢 OPEN PANEL 🟢';
const OPEN_PANEL_RE = /OPEN\s+PANN?EL/iu;
const MANAGED_KEY = Symbol.for('the-commission.open-panel-installed');

const OPEN_PERMISSIONS = [
    Discord.PermissionFlagsBits.ViewChannel,
    Discord.PermissionFlagsBits.Connect,
    Discord.PermissionFlagsBits.Speak,
    Discord.PermissionFlagsBits.Stream,
    Discord.PermissionFlagsBits.UseVAD,
];

function isOpenPanel(channel) {
    return Boolean(
        channel
        && String(channel.parentId || '') === CATEGORY_ID
        && OPEN_PANEL_RE.test(String(channel.name || ''))
    );
}

function liveDescriptor(channel) {
    if (!channel || String(channel.parentId || '') !== CATEGORY_ID) return null;
    const name = String(channel.name || '');
    if (/\bApprentice\b/iu.test(name)) return null;

    const room = name.match(/\bLIVE\s+(\d+)\b/iu);
    if (room) return { number: Number(room[1]), kind: 'room' };

    const waiting = name.match(/\bWaiting(?:\s+(\d+))?\b/iu);
    if (waiting) return { number: Number(waiting[1] || 1), kind: 'waiting' };
    return null;
}

function apprenticeDescriptor(channel) {
    if (!channel || String(channel.parentId || '') !== CATEGORY_ID) return null;
    const name = String(channel.name || '');

    const waiting = name.match(/\bApprentice\s+Waiting(?:\s+(\d+))?\b/iu);
    if (waiting) return { number: Number(waiting[1] || 1), kind: 'waiting' };

    const room = name.match(/\bApprentice\s+(\d+)\b/iu);
    if (room) return { number: Number(room[1]), kind: 'room' };
    return null;
}

function isLiveChannel(channel) {
    return Boolean(liveDescriptor(channel));
}

function isApprenticeChannel(channel) {
    return Boolean(apprenticeDescriptor(channel));
}

function roleOverwrite(roleId, allow) {
    return {
        id: roleId,
        type: Discord.OverwriteType.Role,
        allow: allow ? OPEN_PERMISSIONS : [],
        deny: allow ? [] : OPEN_PERMISSIONS,
    };
}

function overwriteBits(value) {
    if (value?.bitfield !== undefined) return BigInt(value.bitfield);
    return BigInt(new Discord.PermissionsBitField(value || []).bitfield);
}

function overwritesMatch(currentCache, desired) {
    if (!currentCache) return false;
    const current = Array.from(currentCache.values());
    if (current.length !== desired.length) return false;

    return desired.every(target => {
        const existing = current.find(item =>
            String(item.id) === String(target.id)
            && Number(item.type) === Number(target.type)
        );
        if (!existing) return false;
        return overwriteBits(existing.allow) === overwriteBits(target.allow)
            && overwriteBits(existing.deny) === overwriteBits(target.deny);
    });
}

async function desiredOverwrites(guild) {
    await guild.roles.fetch().catch(() => null);
    const everyoneId = guild.roles.everyone?.id || guild.id;
    const overwrites = [roleOverwrite(everyoneId, false)];

    for (const role of guild.roles.cache.values()) {
        if (String(role.id) === String(everyoneId)) continue;
        overwrites.push(roleOverwrite(role.id, true));
    }
    return overwrites;
}

function pairSort(describe) {
    return (a, b) => {
        const left = describe(a);
        const right = describe(b);
        if (!left && !right) return 0;
        if (!left) return 1;
        if (!right) return -1;
        if (left.number !== right.number) return left.number - right.number;
        if (left.kind === right.kind) return 0;
        return left.kind === 'room' ? -1 : 1;
    };
}

async function enforceCategoryOrder(guild, openPanel) {
    if (!guild?.channels?.setPositions || !openPanel) return;
    await guild.channels.fetch().catch(() => null);

    const categoryChannels = Array.from(guild.channels.cache.values())
        .filter(item => String(item.parentId || '') === CATEGORY_ID);

    const liveChannels = categoryChannels.filter(isLiveChannel).sort(pairSort(liveDescriptor));
    const apprenticeChannels = categoryChannels.filter(isApprenticeChannel).sort(pairSort(apprenticeDescriptor));

    // OPEN PANEL is permanently first. Every LIVE room is immediately followed by
    // its own Waiting room. All Apprentice rooms are always grouped at the bottom.
    const ordered = [openPanel, ...liveChannels, ...apprenticeChannels];
    if (ordered.length < 2) return;

    const knownPositions = categoryChannels
        .map(channel => Number(channel.rawPosition ?? channel.position))
        .filter(Number.isFinite);
    if (!knownPositions.length) return;
    const startPosition = Math.min(...knownPositions);

    const alreadyOrdered = ordered.every((channel, index) => {
        const current = Number(channel.rawPosition ?? channel.position);
        return Number.isFinite(current) && current === startPosition + index;
    });
    if (alreadyOrdered) return;

    await guild.channels.setPositions(
        ordered.map((channel, index) => ({
            channel,
            position: startPosition + index,
        })),
    );
}

async function ensureOpenPanel(guild) {
    if (!guild) return null;
    await guild.channels.fetch();

    let matches = Array.from(guild.channels.cache.values()).filter(isOpenPanel);
    let channel = matches[0] || null;

    if (!channel) {
        channel = await guild.channels.create({
            name: OPEN_PANEL_NAME,
            type: Discord.ChannelType.GuildVoice,
            parent: CATEGORY_ID,
            permissionOverwrites: await desiredOverwrites(guild),
            reason: 'Create permanent OPEN PANEL voice room',
        });
        matches = [channel];
    }

    if (channel.name !== OPEN_PANEL_NAME && channel.setName) {
        await channel.setName(OPEN_PANEL_NAME, 'Normalize OPEN PANEL channel name');
    }

    // Keep exactly one managed OPEN PANEL room.
    for (const extra of matches.slice(1)) {
        if (extra?.deletable !== false && extra?.delete) {
            await extra.delete('Remove duplicate OPEN PANEL room');
        }
    }

    if (channel.permissionOverwrites?.set) {
        const desired = await desiredOverwrites(guild);
        if (!overwritesMatch(channel.permissionOverwrites.cache, desired)) {
            await channel.permissionOverwrites.set(
                desired,
                'OPEN PANEL is available to every assigned role but not @everyone',
            );
        }
    }

    await enforceCategoryOrder(guild, channel);
    return channel;
}

function installOpenPanel(client) {
    if (!client || client[MANAGED_KEY]) return client;
    client[MANAGED_KEY] = true;

    const timers = new Map();
    const schedule = (guild, delay = 700) => {
        if (!guild) return;
        clearTimeout(timers.get(guild.id));
        timers.set(guild.id, setTimeout(() => {
            timers.delete(guild.id);
            ensureOpenPanel(guild).catch(error => console.error(`[open-panel] ${guild.id}:`, error));
        }, delay));
    };

    client.on('ready', () => {
        for (const guild of client.guilds.cache.values()) schedule(guild, 1200);
    });

    // Run after the LIVE pair manager has finished creating both halves of a pair,
    // making this the final ordering pass for the category.
    client.on('channelCreate', channel => {
        if (String(channel.parentId || '') === CATEGORY_ID) schedule(channel.guild, 1400);
    });

    client.on('channelDelete', channel => {
        if (isOpenPanel(channel) || String(channel.parentId || '') === CATEGORY_ID) schedule(channel.guild, 1400);
    });

    client.on('channelUpdate', (oldChannel, newChannel) => {
        if (String(oldChannel?.parentId || '') === CATEGORY_ID || String(newChannel?.parentId || '') === CATEGORY_ID) {
            schedule(newChannel?.guild || oldChannel?.guild, 1400);
        }
    });

    client.on('roleCreate', role => schedule(role.guild, 500));
    client.on('roleDelete', role => schedule(role.guild, 500));

    return client;
}

module.exports = {
    OPEN_PANEL_NAME,
    apprenticeDescriptor,
    enforceCategoryOrder,
    ensureOpenPanel,
    installOpenPanel,
    isOpenPanel,
    liveDescriptor,
    overwritesMatch,
};
