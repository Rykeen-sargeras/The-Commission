'use strict';

const LIVE_RE = /^(.*\bLIVE\s+)(\d+)(\b.*)$/iu;
const WAITING_RE = /^(.*\bWaiting\s+)(\d+)(\b.*)$/iu;
const UNNUMBERED_WAITING_RE = /^(.*\bWaiting)(\b.*)$/iu;
const APPRENTICE_RE = /^(.*\bApprentice\s+)(\d+)(\b.*)$/iu;
const APPRENTICE_WAITING_RE = /^(.*\bApprentice\s+Waiting\s+)(\d+)(\b.*)$/iu;
const UNNUMBERED_APPRENTICE_WAITING_RE = /^(.*\bApprentice\s+Waiting)(\b.*)$/iu;

const FAMILY_DEFINITIONS = {
    live: {
        roomName: '🔴 LIVE 1 🔴',
        waitingName: '⬆️ Waiting ⬆️',
    },
    apprentice: {
        roomName: '💛 Apprentice 1 💛',
        waitingName: '⬆️ Apprentice Waiting ⬆️',
    },
};

// Discord permission bitfields. Keeping these local lets this helper stay easy
// to unit test without constructing a Discord client.
const VIEW_CHANNEL = 1n << 10n;
const CONNECT = 1n << 20n;
const MOVE_MEMBERS = 1n << 24n;
const MANAGED_ROLE_BITS = VIEW_CHANNEL | CONNECT | MOVE_MEMBERS;

function describeManagedChannel(channel, categoryId) {
    if (!channel || channel.parentId !== categoryId) return null;
    const name = String(channel.name || '');

    const apprenticeWaitingMatch = name.match(APPRENTICE_WAITING_RE);
    if (apprenticeWaitingMatch) {
        return { family: 'apprentice', kind: 'waiting', number: Number(apprenticeWaitingMatch[2]) };
    }
    if (UNNUMBERED_APPRENTICE_WAITING_RE.test(name)) {
        return { family: 'apprentice', kind: 'waiting', number: 1 };
    }
    const apprenticeMatch = name.match(APPRENTICE_RE);
    if (apprenticeMatch) {
        return { family: 'apprentice', kind: 'room', number: Number(apprenticeMatch[2]) };
    }
    const liveMatch = name.match(LIVE_RE);
    if (liveMatch) return { family: 'live', kind: 'room', number: Number(liveMatch[2]) };
    const waitingMatch = name.match(WAITING_RE);
    if (waitingMatch) return { family: 'live', kind: 'waiting', number: Number(waitingMatch[2]) };
    if (UNNUMBERED_WAITING_RE.test(name)) return { family: 'live', kind: 'waiting', number: 1 };
    return null;
}

function numberedName(templateName, number, kind, family = 'live') {
    const patterns = family === 'apprentice'
        ? { room: APPRENTICE_RE, waiting: APPRENTICE_WAITING_RE }
        : { room: LIVE_RE, live: LIVE_RE, waiting: WAITING_RE };
    const pattern = patterns[kind];
    const name = String(templateName);
    if (pattern?.test(name)) {
        return name.replace(pattern, (_, before, _oldNumber, after) => `${before}${number}${after}`);
    }
    if (family === 'apprentice' && kind === 'waiting' && UNNUMBERED_APPRENTICE_WAITING_RE.test(name)) {
        return name.replace(UNNUMBERED_APPRENTICE_WAITING_RE, (_, before, after) => `${before} ${number}${after}`);
    }
    if (family === 'live' && kind === 'waiting' && UNNUMBERED_WAITING_RE.test(name)) {
        return name.replace(UNNUMBERED_WAITING_RE, (_, before, after) => `${before} ${number}${after}`);
    }
    return family === 'apprentice'
        ? `${kind === 'waiting' ? 'Apprentice Waiting' : 'Apprentice'} ${number}`
        : `${kind === 'waiting' ? 'Waiting' : 'LIVE'} ${number}`;
}

function canonicalName(family, kind, number) {
    const definition = FAMILY_DEFINITIONS[family];
    const templateName = kind === 'waiting' ? definition.waitingName : definition.roomName;
    if (number === 1) return templateName;
    return numberedName(templateName, number, kind, family);
}

function memberCount(channel) {
    return Number(channel?.members?.size || 0);
}

function pairMemberCount(pair) {
    return memberCount(pair?.room) + memberCount(pair?.waiting);
}

function clonePermissionOverwrites(channel) {
    const cache = channel?.permissionOverwrites?.cache;
    if (!cache) return [];
    return Array.from(cache.values()).map(overwrite => ({
        id: overwrite.id,
        type: overwrite.type,
        allow: overwrite.allow?.bitfield ?? overwrite.allow ?? 0n,
        deny: overwrite.deny?.bitfield ?? overwrite.deny ?? 0n,
    }));
}

function rolePermissionBits(family, kind) {
    if (family === 'apprentice') {
        return { allow: MANAGED_ROLE_BITS, deny: 0n };
    }
    if (kind === 'waiting') {
        return { allow: VIEW_CHANNEL | CONNECT, deny: MOVE_MEMBERS };
    }
    return { allow: VIEW_CHANNEL, deny: CONNECT | MOVE_MEMBERS };
}

function withRolePermissions(overwrites, roleId, family, kind) {
    if (!roleId) return overwrites;
    const output = overwrites.map(item => ({ ...item }));
    const existing = output.find(item => String(item.id) === roleId);
    const desired = rolePermissionBits(family, kind);
    const target = existing || { id: roleId, type: 0, allow: 0n, deny: 0n };
    const currentAllow = BigInt(target.allow?.bitfield ?? target.allow ?? 0n);
    const currentDeny = BigInt(target.deny?.bitfield ?? target.deny ?? 0n);
    target.allow = (currentAllow & ~MANAGED_ROLE_BITS) | desired.allow;
    target.deny = (currentDeny & ~MANAGED_ROLE_BITS) | desired.deny;
    if (!existing) output.push(target);
    return output;
}

function cloneChannelOptions(template, name, categoryId, { apprenticeRoleId = '', family = 'live', kind = 'room' } = {}) {
    const options = {
        name,
        type: template?.type ?? 2,
        parent: categoryId,
        permissionOverwrites: withRolePermissions(
            clonePermissionOverwrites(template),
            apprenticeRoleId,
            family,
            kind,
        ),
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
        logger = console,
    } = {}) {
        this.client = client;
        this.categoryId = String(categoryId || '');
        this.apprenticeRoleId = String(apprenticeRoleId || '');
        this.delayMs = delayMs;
        this.cleanupDelayMs = cleanupDelayMs;
        this.logger = logger;
        this.timers = new Map();
        this.guildQueues = new Map();
        this.cleanupTimers = new Map();
    }

    install() {
        if (!this.categoryId) {
            this.logger.warn('[voice-pairs] LIVE_VOICE_CATEGORY_ID is not configured; dynamic pairs are disabled.');
            return this;
        }

        this.client.on('ready', () => {
            for (const guild of this.client.guilds.cache.values()) this.schedule(guild, 0, null);
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

            // LIVE uses the whole pair as the available slot: occupying either the
            // on-air room or its waiting room causes a fresh LIVE/Waiting pair to exist.
            // Apprentice keeps its existing room-only behavior.
            const joinedManaged = newManaged && oldState.channelId !== newState.channelId;
            const consumesOpenSlot = joinedManaged && (
                newManaged.family === 'live'
                || newManaged.kind === 'room'
            );
            if (consumesOpenSlot) this.schedule(guild, this.delayMs, newManaged.family);
        });

        this.client.on('channelDelete', channel => {
            const managed = describeManagedChannel(channel, this.categoryId);
            if (!managed) return;
            if (managed.number === 1) this.schedule(channel.guild, 0, null);
            else this.scheduleCleanup(channel.guild, managed.family, managed.number);
        });

        return this;
    }

    schedule(guild, delayMs = this.delayMs, ensureFamily = null) {
        if (!guild) return;
        clearTimeout(this.timers.get(guild.id));
        this.timers.set(guild.id, setTimeout(() => {
            this.timers.delete(guild.id);
            const previous = this.guildQueues.get(guild.id) || Promise.resolve();
            const next = previous
                .catch(() => {})
                .then(() => this.reconcile(guild, ensureFamily))
                .catch(error => this.logger.error(`[voice-pairs] ${guild.id}:`, error));
            this.guildQueues.set(guild.id, next);
        }, delayMs));
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
        this.cleanupTimers.set(key, setTimeout(() => {
            this.cleanupTimers.delete(key);
            this.deletePairIfEmpty(guild, family, number).catch(error => {
                this.logger.error(`[voice-pairs] cleanup ${guild.id}:${family}:${number}:`, error);
            });
        }, this.cleanupDelayMs));
    }

    async collectPairs(guild) {
        await guild.channels.fetch();

        const pairs = { live: new Map(), apprentice: new Map() };
        for (const channel of guild.channels.cache.values()) {
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
        }, { reason: 'Enforce Apprentice voice channel access' });
    }

    async ensureCanonicalName(channel, family, kind, number) {
        if (!channel?.setName) return;
        const expected = canonicalName(family, kind, number);
        if (channel.name === expected) return;
        await channel.setName(expected, 'Normalize managed voice channel name');
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
        if (!pair.room) {
            pair.room = await this.createChannel(guild, pair.waiting, definition.roomName, family, 'room');
        }
        if (!pair.waiting) {
            pair.waiting = await this.createChannel(guild, pair.room, definition.waitingName, family, 'waiting');
        }
        await this.ensureRolePermissions(pair.room, family, 'room');
        await this.ensureRolePermissions(pair.waiting, family, 'waiting');
        await this.ensureCanonicalName(pair.room, family, 'room', 1);
        await this.ensureCanonicalName(pair.waiting, family, 'waiting', 1);
        pairs[family].set(1, pair);
        return pair;
    }

    async reconcile(guild, ensureFamily = null) {
        const pairs = await this.collectPairs(guild);
        await this.ensureBasePair(guild, pairs, 'live');
        await this.ensureBasePair(guild, pairs, 'apprentice');

        for (const family of Object.keys(FAMILY_DEFINITIONS)) {
            for (const [number, pair] of pairs[family]) {
                await this.ensureCanonicalName(pair.room, family, 'room', number);
                await this.ensureCanonicalName(pair.waiting, family, 'waiting', number);
                if (number > 1 && pairMemberCount(pair) === 0) {
                    this.scheduleCleanup(guild, family, number);
                }
            }
        }

        if (!ensureFamily) return;
        const familyPairs = pairs[ensureFamily];
        const templates = familyPairs.get(1);

        // A LIVE slot is the room + its waiting room. If either side is occupied,
        // that pair is busy and another completely empty pair must remain available.
        // Apprentice intentionally retains its existing room-only slot behavior.
        const occupiedSlotExists = Array.from(familyPairs.values()).some(pair => (
            ensureFamily === 'live'
                ? pairMemberCount(pair) > 0
                : memberCount(pair.room) > 0
        ));
        const openSlotExists = Array.from(familyPairs.values()).some(pair => (
            ensureFamily === 'live'
                ? pair.room && pair.waiting && pairMemberCount(pair) === 0
                : pair.room && memberCount(pair.room) === 0
        ));

        if (occupiedSlotExists && !openSlotExists) {
            let nextNumber = 2;
            while (familyPairs.has(nextNumber)) nextNumber += 1;
            const nextPair = {};
            nextPair.room = await this.createChannel(
                guild,
                templates.room,
                numberedName(templates.room.name, nextNumber, 'room', ensureFamily),
                ensureFamily,
                'room',
            );
            nextPair.waiting = await this.createChannel(
                guild,
                templates.waiting,
                numberedName(templates.waiting.name, nextNumber, 'waiting', ensureFamily),
                ensureFamily,
                'waiting',
            );
            familyPairs.set(nextNumber, nextPair);
        }
    }

    async deletePairIfEmpty(guild, family, number) {
        if (number <= 1) return false;
        const pair = (await this.collectPairs(guild))[family].get(number) || {};
        if (pairMemberCount(pair) > 0) return false;
        for (const channel of [pair.room, pair.waiting]) {
            if (channel) await channel.delete('Remove voice pair after ten seconds empty');
        }
        return true;
    }
}

function installLiveVoicePairs(client, options) {
    return new LiveVoicePairManager(client, options).install();
}

module.exports = {
    CONNECT,
    LiveVoicePairManager,
    MOVE_MEMBERS,
    VIEW_CHANNEL,
    canonicalName,
    clonePermissionOverwrites,
    describeManagedChannel,
    installLiveVoicePairs,
    numberedName,
    rolePermissionBits,
    withRolePermissions,
};
