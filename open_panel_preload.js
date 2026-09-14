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

function roleOverwrite(roleId, allow) {
    return {
        id: roleId,
        type: Discord.OverwriteType.Role,
        allow: allow ? OPEN_PERMISSIONS : [],
        deny: allow ? [] : OPEN_PERMISSIONS,
    };
}

function desiredOverwritesFromCache(guild) {
    const everyoneId = guild.roles.everyone?.id || guild.id;
    const overwrites = [roleOverwrite(everyoneId, false)];
    for (const role of guild.roles.cache?.values?.() || []) {
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
    const categoryChannels = Array.from(guild.channels.cache?.values?.() || [])
        .filter(item => String(item.parentId || '') === CATEGORY_ID && !item.deleted);
    const liveChannels = categoryChannels.filter(channel => Boolean(liveDescriptor(channel))).sort(pairSort(liveDescriptor));
    const apprenticeChannels = categoryChannels.filter(channel => Boolean(apprenticeDescriptor(channel))).sort(pairSort(apprenticeDescriptor));
    const ordered = [openPanel, ...liveChannels, ...apprenticeChannels]
        .filter((channel, index, all) => channel && all.indexOf(channel) === index);
    if (ordered.length < 2) return;

    const positions = categoryChannels
        .map(channel => Number(channel.rawPosition ?? channel.position))
        .filter(Number.isFinite);
    if (!positions.length) return;
    const start = Math.min(...positions);
    if (ordered.every((channel, index) => Number(channel.rawPosition ?? channel.position) === start + index)) return;

    await guild.channels.setPositions(ordered.map((channel, index) => ({ channel, position: start + index })));
}

async function ensureOpenPanel(guild) {
    if (!guild) return null;
    if (!guild.channels.cache?.size && guild.channels.fetch) await guild.channels.fetch().catch(() => null);

    let matches = Array.from(guild.channels.cache?.values?.() || []).filter(isOpenPanel);
    let channel = matches[0] || null;

    if (!channel) {
        channel = await guild.channels.create({
            name: OPEN_PANEL_NAME,
            type: Discord.ChannelType.GuildVoice,
            parent: CATEGORY_ID,
            permissionOverwrites: desiredOverwritesFromCache(guild),
            reason: 'Create permanent OPEN PANEL voice room',
        });
        matches = [channel];
    }

    if (channel.name !== OPEN_PANEL_NAME && channel.setName) {
        await channel.setName(OPEN_PANEL_NAME, 'Normalize OPEN PANEL channel name');
    }

    for (const extra of matches.slice(1)) {
        if (extra?.deletable !== false && extra?.delete) await extra.delete('Remove duplicate OPEN PANEL room');
    }

    // Existing permission overwrites are intentionally never synchronized here.
    // The server's current channel permissions are authoritative.
    await enforceCategoryOrder(guild, channel);
    return channel;
}

function installOpenPanel(client) {
    if (!client || client[MANAGED_KEY]) return client;
    client[MANAGED_KEY] = true;
    if (typeof client.on !== 'function') return client;

    const timers = new Map();
    const schedule = (guild, delay = 900) => {
        if (!guild) return;
        clearTimeout(timers.get(guild.id));
        const timer = setTimeout(() => {
            timers.delete(guild.id);
            ensureOpenPanel(guild).catch(error => console.error(`[open-panel] ${guild.id}:`, error));
        }, delay);
        timer.unref?.();
        timers.set(guild.id, timer);
    };

    client.on('ready', () => {
        for (const guild of client.guilds.cache.values()) schedule(guild, 1200);
    });
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
};
