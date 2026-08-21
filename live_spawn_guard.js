'use strict';

const Discord = require('discord.js');

const CATEGORY_ID = String(process.env.LIVE_VOICE_CATEGORY_ID || '1532513765701189683');
const INSTALLED = Symbol.for('the-commission.live-spawn-guard-installed');
const LIVE_RE = /\bLIVE\s+(\d+)\b/iu;
const WAITING_RE = /\bWaiting(?:\s+(\d+))?\b/iu;

function describe(channel) {
    if (!channel || String(channel.parentId || '') !== CATEGORY_ID) return null;
    const name = String(channel.name || '');
    if (/\bApprentice\b/iu.test(name) || /OPEN\s+PANN?EL/iu.test(name)) return null;
    const live = name.match(LIVE_RE);
    if (live) return { kind: 'room', number: Number(live[1]) };
    const waiting = name.match(WAITING_RE);
    if (waiting) return { kind: 'waiting', number: Number(waiting[1] || 1) };
    return null;
}

function memberCount(channel) {
    return Number(channel?.members?.size || 0);
}

function cloneOverwrites(channel) {
    const cache = channel?.permissionOverwrites?.cache;
    if (!cache) return [];
    return Array.from(cache.values()).map(item => ({
        id: item.id,
        type: item.type,
        allow: item.allow?.bitfield ?? item.allow ?? 0n,
        deny: item.deny?.bitfield ?? item.deny ?? 0n,
    }));
}

function cloneVoiceOptions(template, name) {
    const options = {
        name,
        type: template?.type ?? Discord.ChannelType.GuildVoice,
        parent: CATEGORY_ID,
        permissionOverwrites: cloneOverwrites(template),
        reason: 'Self-heal required open LIVE/Waiting voice pair',
    };
    for (const key of ['bitrate', 'userLimit', 'rtcRegion', 'videoQualityMode']) {
        if (template?.[key] !== undefined && template[key] !== null) options[key] = template[key];
    }
    return options;
}

async function collect(guild) {
    await guild.channels.fetch();
    const pairs = new Map();
    for (const channel of guild.channels.cache.values()) {
        const managed = describe(channel);
        if (!managed) continue;
        const pair = pairs.get(managed.number) || {};
        pair[managed.kind] = channel;
        pairs.set(managed.number, pair);
    }
    return pairs;
}

async function ensureOpenLivePair(guild) {
    if (!guild) return false;
    const pairs = await collect(guild);
    const base = pairs.get(1) || {};
    if (!base.room || !base.waiting) return false;

    const values = Array.from(pairs.values());
    const occupiedExists = values.some(pair => memberCount(pair.room) + memberCount(pair.waiting) > 0);
    if (!occupiedExists) return false;

    const openExists = values.some(pair => (
        pair.room
        && pair.waiting
        && memberCount(pair.room) === 0
        && memberCount(pair.waiting) === 0
    ));
    if (openExists) return false;

    let nextNumber = 2;
    while (pairs.has(nextNumber)) nextNumber += 1;

    // Re-check immediately before creation so the normal manager and this guard
    // cannot both create the same spare pair during the same join event.
    const latest = await collect(guild);
    const latestOpen = Array.from(latest.values()).some(pair => (
        pair.room
        && pair.waiting
        && memberCount(pair.room) === 0
        && memberCount(pair.waiting) === 0
    ));
    if (latestOpen) return false;
    while (latest.has(nextNumber)) nextNumber += 1;

    const room = await guild.channels.create(cloneVoiceOptions(base.room, `🔴 LIVE ${nextNumber} 🔴`));
    try {
        await guild.channels.create(cloneVoiceOptions(base.waiting, `⬆️ Waiting ${nextNumber} ⬆️`));
    } catch (error) {
        await room.delete('Rollback incomplete LIVE pair').catch(() => {});
        throw error;
    }

    console.log(`[live-spawn-guard] Created LIVE ${nextNumber} / Waiting ${nextNumber}.`);
    return true;
}

function installLiveSpawnGuard(client) {
    if (!client || client[INSTALLED]) return client;
    client[INSTALLED] = true;

    const timers = new Map();
    const schedule = (guild, delay = 1100) => {
        if (!guild) return;
        clearTimeout(timers.get(guild.id));
        timers.set(guild.id, setTimeout(() => {
            timers.delete(guild.id);
            ensureOpenLivePair(guild).catch(error => {
                console.error(`[live-spawn-guard] ${guild.id}:`, error);
            });
        }, delay));
    };

    client.on('ready', () => {
        for (const guild of client.guilds.cache.values()) schedule(guild, 1500);
    });

    client.on('voiceStateUpdate', (oldState, newState) => {
        const oldManaged = describe(oldState.channel);
        const newManaged = describe(newState.channel);
        if (!oldManaged && !newManaged) return;
        schedule(newState.guild || oldState.guild, 900);
    });

    client.on('channelDelete', channel => {
        if (describe(channel)) schedule(channel.guild, 900);
    });

    // Periodic self-heal protects against cleanup races or missed Discord events.
    const interval = setInterval(() => {
        for (const guild of client.guilds.cache.values()) schedule(guild, 0);
    }, 15_000);
    interval.unref?.();

    return client;
}

function patchDiscordClient() {
    const proto = Discord.Client?.prototype;
    if (!proto || proto.__commissionLiveSpawnGuardPatched) return;
    proto.__commissionLiveSpawnGuardPatched = true;
    const originalLogin = proto.login;
    proto.login = function patchedLogin(...args) {
        installLiveSpawnGuard(this);
        return originalLogin.apply(this, args);
    };
}

patchDiscordClient();

module.exports = {
    describe,
    ensureOpenLivePair,
    installLiveSpawnGuard,
    patchDiscordClient,
};
