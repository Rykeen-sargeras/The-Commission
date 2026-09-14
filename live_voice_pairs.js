'use strict';

const LIVE_RE = /^(.*\bLIVE\s+)(\d+)(\b.*)$/iu;
const WAITING_RE = /^(.*\bWaiting\s+)(\d+)(\b.*)$/iu;
const UNNUMBERED_WAITING_RE = /^(.*\bWaiting)(\b.*)$/iu;
const APPRENTICE_RE = /^(.*\bApprentice\s+)(\d+)(\b.*)$/iu;
const APPRENTICE_WAITING_RE = /^(.*\bApprentice\s+Waiting\s+)(\d+)(\b.*)$/iu;
const UNNUMBERED_APPRENTICE_WAITING_RE = /^(.*\bApprentice\s+Waiting)(\b.*)$/iu;

const FAMILY_DEFINITIONS = Object.freeze({
    live: { roomName: '🔴 LIVE 1 🔴', waitingName: '⬆️ Waiting ⬆️' },
    apprentice: { roomName: '🟡 Apprentice 1 🟡', waitingName: '🟡 Apprentice Waiting 🟡' },
});

const VIEW_CHANNEL = 1n << 10n;
const CONNECT = 1n << 20n;
const MOVE_MEMBERS = 1n << 24n;
const MANAGED_ROLE_BITS = VIEW_CHANNEL | CONNECT | MOVE_MEMBERS;

function describeManagedChannel(channel, categoryId) {
    if (!channel || String(channel.parentId || '') !== String(categoryId || '')) return null;
    const name = String(channel.name || '');
    let match = name.match(APPRENTICE_WAITING_RE);
    if (match) return { family: 'apprentice', kind: 'waiting', number: Number(match[2]) };
    if (UNNUMBERED_APPRENTICE_WAITING_RE.test(name)) return { family: 'apprentice', kind: 'waiting', number: 1 };
    match = name.match(APPRENTICE_RE);
    if (match) return { family: 'apprentice', kind: 'room', number: Number(match[2]) };
    match = name.match(LIVE_RE);
    if (match) return { family: 'live', kind: 'room', number: Number(match[2]) };
    match = name.match(WAITING_RE);
    if (match) return { family: 'live', kind: 'waiting', number: Number(match[2]) };
    if (UNNUMBERED_WAITING_RE.test(name)) return { family: 'live', kind: 'waiting', number: 1 };
    return null;
}

function numberedName(templateName, number, kind, family = 'live') {
    const name = String(templateName || '');
    const pattern = family === 'apprentice'
        ? (kind === 'waiting' ? APPRENTICE_WAITING_RE : APPRENTICE_RE)
        : (kind === 'waiting' ? WAITING_RE : LIVE_RE);
    if (pattern.test(name)) return name.replace(pattern, (_m, before, _old, after) => `${before}${number}${after}`);
    if (family === 'apprentice' && kind === 'waiting' && UNNUMBERED_APPRENTICE_WAITING_RE.test(name)) {
        return name.replace(UNNUMBERED_APPRENTICE_WAITING_RE, (_m, before, after) => `${before} ${number}${after}`);
    }
    if (family === 'live' && kind === 'waiting' && UNNUMBERED_WAITING_RE.test(name)) {
        return name.replace(UNNUMBERED_WAITING_RE, (_m, before, after) => `${before} ${number}${after}`);
    }
    return family === 'apprentice'
        ? `${kind === 'waiting' ? 'Apprentice Waiting' : 'Apprentice'} ${number}`
        : `${kind === 'waiting' ? 'Waiting' : 'LIVE'} ${number}`;
}

function canonicalName(family, kind, number) {
    const template = kind === 'waiting' ? FAMILY_DEFINITIONS[family].waitingName : FAMILY_DEFINITIONS[family].roomName;
    return number === 1 ? template : numberedName(template, number, kind, family);
}

function memberCount(channel) {
    return Number(channel?.members?.size || 0);
}

function pairMemberCount(pair) {
    return memberCount(pair?.room) + memberCount(pair?.waiting);
}

function isCompleteEmptyPair(pair) {
    return Boolean(pair?.room && pair?.waiting && pairMemberCount(pair) === 0);
}

function clonePermissionOverwrites(channel) {
    const cache = channel?.permissionOverwrites?.cache;
    if (!cache?.values) return [];
    return Array.from(cache.values()).map(overwrite => ({
        id: overwrite.id,
        type: overwrite.type,
        allow: overwrite.allow?.bitfield ?? overwrite.allow ?? 0n,
        deny: overwrite.deny?.bitfield ?? overwrite.deny ?? 0n,
    }));
}

function rolePermissionBits(family, kind) {
    if (family === 'apprentice') return { allow: MANAGED_ROLE_BITS, deny: 0n };
    if (kind === 'waiting') return { allow: VIEW_CHANNEL | CONNECT, deny: MOVE_MEMBERS };
    return { allow: VIEW_CHANNEL, deny: CONNECT | MOVE_MEMBERS };
}

function withRolePermissions(overwrites, roleId, family, kind) {
    if (!roleId) return overwrites;
    const output = overwrites.map(item => ({ ...item }));
    const desired = rolePermissionBits(family, kind);
    const existing = output.find(item => String(item.id) === String(roleId));
    const target = existing || { id: roleId, type: 0, allow: 0n, deny: 0n };
    const allow = BigInt(target.allow?.bitfield ?? target.allow ?? 0n);
    const deny = BigInt(target.deny?.bitfield ?? target.deny ?? 0n);
    target.allow = (allow & ~MANAGED_ROLE_BITS) | desired.allow;
    target.deny = (deny & ~MANAGED_ROLE_BITS) | desired.deny;
    if (!existing) output.push(target);
    return output;
}

function cloneChannelOptions(template, name, categoryId, { apprenticeRoleId = '', family = 'live', kind = 'room' } = {}) {
    const options = {
        name,
        type: template?.type ?? 2,
        parent: categoryId,
        permissionOverwrites: withRolePermissions(clonePermissionOverwrites(template), apprenticeRoleId, family, kind),
        reason: 'Maintain dynamic LIVE/Waiting and Apprentice voice channel pairs',
    };
    for (const key of ['bitrate', 'userLimit', 'rtcRegion', 'videoQualityMode']) {
        if (template?.[key] !== undefined && template[key] !== null) options[key] = template[key];
    }
    return options;
}

class LiveVoicePairManager {
    constructor(client, {
        categoryId,
        apprenticeRoleId = process.env.APPRENTICE_VOICE_ROLE_ID || '1538688329451573300',
        delayMs = 350,
        cleanupDelayMs = 10_000,
        healthIntervalMs = 60_000,
        logger = console,
    } = {}) {
        this.client = client;
        this.categoryId = String(categoryId || '');
        this.apprenticeRoleId = String(apprenticeRoleId || '');
        this.delayMs = delayMs;
        this.cleanupDelayMs = cleanupDelayMs;
        this.healthIntervalMs = Math.max(30_000, Number(healthIntervalMs) || 60_000);
        this.logger = logger;
        this.timers = new Map();
        this.guildQueues = new Map();
        this.cleanupTimers = new Map();
        this.healthInterval = null;
    }

    install() {
        if (!this.categoryId) {
            this.logger.warn('[voice-pairs] LIVE_VOICE_CATEGORY_ID is not configured; dynamic pairs are disabled.');
            return this;
        }
        if (!this.client?.on) return this;

        this.client.on('ready', () => {
            for (const guild of this.client.guilds.cache.values()) this.schedule(guild, 0);
            if (!this.healthInterval) {
                // Events do the real work. This is only a slow recovery check, not a
                // five-second full-channel poll.
                this.healthInterval = setInterval(() => {
                    for (const guild of this.client.guilds.cache.values()) this.schedule(guild, 0);
                }, this.healthIntervalMs);
                this.healthInterval.unref?.();
            }
        });

        this.client.on('voiceStateUpdate', (oldState, newState) => {
            if (oldState.channel?.parentId !== this.categoryId && newState.channel?.parentId !== this.categoryId) return;
            const guild = newState.guild || oldState.guild;
            const oldManaged = describeManagedChannel(oldState.channel, this.categoryId);
            const newManaged = describeManagedChannel(newState.channel, this.categoryId);
            if (newManaged) this.cancelCleanup(guild.id, newManaged.family, newManaged.number);
            if (oldManaged && oldManaged.number > 1 && oldState.channelId !== newState.channelId) {
                this.scheduleCleanup(guild, oldManaged.family, oldManaged.number);
            }
            if (oldState.channelId !== newState.channelId) this.schedule(guild, this.delayMs, newManaged?.family || oldManaged?.family || null);
        });

        this.client.on('channelCreate', channel => {
            if (String(channel.parentId || '') === this.categoryId) this.schedule(channel.guild, this.delayMs);
        });
        this.client.on('channelDelete', channel => {
            const managed = describeManagedChannel(channel, this.categoryId);
            if (!managed) return;
            if (managed.number > 1) this.scheduleCleanup(channel.guild, managed.family, managed.number);
            this.schedule(channel.guild, this.delayMs, managed.family);
        });
        return this;
    }

    schedule(guild, delayMs = this.delayMs, ensureFamily = null) {
        if (!guild) return;
        clearTimeout(this.timers.get(guild.id));
        const timer = setTimeout(() => {
            this.timers.delete(guild.id);
            const previous = this.guildQueues.get(guild.id) || Promise.resolve();
            const next = previous
                .catch(() => null)
                .then(() => this.reconcile(guild, ensureFamily))
                .catch(error => this.logger.error?.(`[voice-pairs] ${guild.id}:`, error))
                .finally(() => {
                    if (this.guildQueues.get(guild.id) === next) this.guildQueues.delete(guild.id);
                });
            this.guildQueues.set(guild.id, next);
        }, Math.max(0, delayMs));
        timer.unref?.();
        this.timers.set(guild.id, timer);
    }

    cleanupKey(guildId, family, number) {
        return `${guildId}:${family}:${number}`;
    }

    cancelCleanup(guildId, family, number) {
        const key = this.cleanupKey(guildId, family, number);
        clearTimeout(this.cleanupTimers.get(key));
        this.cleanupTimers.delete(key);
    }

    scheduleCleanup(guild, family, number) {
        if (!guild || number <= 1) return;
        const key = this.cleanupKey(guild.id, family, number);
        clearTimeout(this.cleanupTimers.get(key));
        const timer = setTimeout(() => {
            this.cleanupTimers.delete(key);
            this.deletePairIfEmpty(guild, family, number).catch(error => this.logger.error?.(`[voice-pairs] cleanup ${key}:`, error));
        }, this.cleanupDelayMs);
        timer.unref?.();
        this.cleanupTimers.set(key, timer);
    }

    async collectPairs(guild) {
        // Discord.js already keeps GuildChannels cached through gateway events.
        // Only REST-fetch when the cache is genuinely empty (normally startup edge cases).
        if (!guild.channels.cache?.size && guild.channels.fetch) await guild.channels.fetch().catch(() => null);
        const pairs = { live: new Map(), apprentice: new Map() };
        for (const channel of guild.channels.cache.values()) {
            if (channel.deleted) continue;
            const managed = describeManagedChannel(channel, this.categoryId);
            if (!managed) continue;
            const pair = pairs[managed.family].get(managed.number) || {};
            pair[managed.kind] = channel;
            pairs[managed.family].set(managed.number, pair);
        }
        return pairs;
    }

    async ensureRolePermissions(channel, family, kind) {
        if (!channel || !this.apprenticeRoleId || !channel.permissionOverwrites?.edit) return;
        const desired = rolePermissionBits(family, kind);
        const existing = channel.permissionOverwrites.cache?.get(this.apprenticeRoleId);
        const allow = BigInt(existing?.allow?.bitfield ?? existing?.allow ?? 0n);
        const deny = BigInt(existing?.deny?.bitfield ?? existing?.deny ?? 0n);
        const nextAllow = (allow & ~MANAGED_ROLE_BITS) | desired.allow;
        const nextDeny = (deny & ~MANAGED_ROLE_BITS) | desired.deny;
        if (allow === nextAllow && deny === nextDeny) return;
        await channel.permissionOverwrites.edit(this.apprenticeRoleId, {
            ViewChannel: Boolean(nextAllow & VIEW_CHANNEL),
            Connect: Boolean(nextAllow & CONNECT),
            MoveMembers: Boolean(nextAllow & MOVE_MEMBERS),
        }, { reason: 'Enforce managed voice channel access' });
    }

    async ensureCanonicalName(channel, family, kind, number) {
        const expected = canonicalName(family, kind, number);
        if (channel?.setName && channel.name !== expected) await channel.setName(expected, 'Normalize managed voice channel name');
    }

    async ensureChannelOrder(guild, pairs) {
        if (!guild.channels?.setPositions) return;
        const ordered = [];
        for (const family of ['live', 'apprentice']) {
            for (const number of Array.from(pairs[family].keys()).sort((a, b) => a - b)) {
                const pair = pairs[family].get(number) || {};
                if (pair.room) ordered.push(pair.room);
                if (pair.waiting) ordered.push(pair.waiting);
            }
        }
        if (ordered.length < 2) return;
        const currentPositions = ordered.map(channel => Number(channel.rawPosition ?? channel.position));
        if (!currentPositions.every(Number.isFinite)) return;
        const start = Math.min(...currentPositions);
        if (ordered.every((channel, index) => Number(channel.rawPosition ?? channel.position) === start + index)) return;
        await guild.channels.setPositions(ordered.map((channel, index) => ({ channel, position: start + index })));
    }

    async createChannel(guild, template, name, family, kind) {
        return guild.channels.create(cloneChannelOptions(template, name, this.categoryId, {
            apprenticeRoleId: this.apprenticeRoleId,
            family,
            kind,
        }));
    }

    async ensureBasePair(guild, pairs, family) {
        const definition = FAMILY_DEFINITIONS[family];
        const pair = pairs[family].get(1) || {};
        if (!pair.room) pair.room = await this.createChannel(guild, pair.waiting, definition.roomName, family, 'room');
        if (!pair.waiting) pair.waiting = await this.createChannel(guild, pair.room, definition.waitingName, family, 'waiting');
        await this.ensureRolePermissions(pair.room, family, 'room');
        await this.ensureRolePermissions(pair.waiting, family, 'waiting');
        await this.ensureCanonicalName(pair.room, family, 'room', 1);
        await this.ensureCanonicalName(pair.waiting, family, 'waiting', 1);
        pairs[family].set(1, pair);
        return pair;
    }

    async ensureSparePair(guild, pairs, family) {
        const familyPairs = pairs[family];
        const base = familyPairs.get(1);
        if (!base?.room || !base?.waiting) return false;
        const values = Array.from(familyPairs.values());
        const occupied = values.some(pair => family === 'live' ? pairMemberCount(pair) > 0 : memberCount(pair.room) > 0);
        if (!occupied) return false;
        const openSlot = values.some(pair => family === 'live' ? isCompleteEmptyPair(pair) : Boolean(pair.room && memberCount(pair.room) === 0));
        if (openSlot) return false;

        let number = 2;
        while (familyPairs.has(number)) number += 1;
        const pair = {
            room: await this.createChannel(guild, base.room, canonicalName(family, 'room', number), family, 'room'),
            waiting: null,
        };
        pair.waiting = await this.createChannel(guild, base.waiting, canonicalName(family, 'waiting', number), family, 'waiting');
        familyPairs.set(number, pair);
        return true;
    }

    async reconcile(guild, ensureFamily = null) {
        const pairs = await this.collectPairs(guild);
        await this.ensureBasePair(guild, pairs, 'live');
        await this.ensureBasePair(guild, pairs, 'apprentice');

        for (const family of ['live', 'apprentice']) {
            for (const [number, pair] of pairs[family]) {
                if (pair.room) {
                    await this.ensureCanonicalName(pair.room, family, 'room', number);
                    await this.ensureRolePermissions(pair.room, family, 'room');
                }
                if (pair.waiting) {
                    await this.ensureCanonicalName(pair.waiting, family, 'waiting', number);
                    await this.ensureRolePermissions(pair.waiting, family, 'waiting');
                }
            }
        }

        if (ensureFamily === 'live' || ensureFamily === 'apprentice') await this.ensureSparePair(guild, pairs, ensureFamily);
        else {
            await this.ensureSparePair(guild, pairs, 'live');
            await this.ensureSparePair(guild, pairs, 'apprentice');
        }
        await this.ensureChannelOrder(guild, pairs);
        return pairs;
    }

    async deletePairIfEmpty(guild, family, number) {
        if (number <= 1) return false;
        const pairs = await this.collectPairs(guild);
        const pair = pairs[family].get(number);
        if (!pair || pairMemberCount(pair) > 0) return false;
        const targets = [pair.room, pair.waiting].filter(Boolean);
        const results = await Promise.allSettled(targets.map(channel => channel.delete?.('Remove unused dynamic voice pair')));
        const deleted = results.some(result => result.status === 'fulfilled');
        if (deleted) this.schedule(guild, this.delayMs);
        return deleted;
    }
}

function installLiveVoicePairs(client, options) {
    return new LiveVoicePairManager(client, options).install();
}

module.exports = {
    CONNECT,
    FAMILY_DEFINITIONS,
    LiveVoicePairManager,
    MANAGED_ROLE_BITS,
    MOVE_MEMBERS,
    VIEW_CHANNEL,
    canonicalName,
    cloneChannelOptions,
    describeManagedChannel,
    installLiveVoicePairs,
    numberedName,
    rolePermissionBits,
};
