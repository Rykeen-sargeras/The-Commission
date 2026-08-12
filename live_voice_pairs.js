'use strict';

const LIVE_RE = /^(.*\bLIVE\s+)(\d+)(\b.*)$/iu;
const WAITING_RE = /^(.*\bWaiting\s+)(\d+)(\b.*)$/iu;
const UNNUMBERED_WAITING_RE = /^(.*\bWaiting)(\b.*)$/iu;

function describeManagedChannel(channel, categoryId) {
    if (!channel || channel.parentId !== categoryId) return null;
    const liveMatch = String(channel.name || '').match(LIVE_RE);
    if (liveMatch) return { kind: 'live', number: Number(liveMatch[2]) };
    const waitingMatch = String(channel.name || '').match(WAITING_RE);
    if (waitingMatch) return { kind: 'waiting', number: Number(waitingMatch[2]) };
    if (UNNUMBERED_WAITING_RE.test(String(channel.name || ''))) return { kind: 'waiting', number: 1 };
    return null;
}

function numberedName(templateName, number, kind) {
    const pattern = kind === 'live' ? LIVE_RE : WAITING_RE;
    const name = String(templateName);
    if (pattern.test(name)) {
        return name.replace(pattern, (_, before, _oldNumber, after) => `${before}${number}${after}`);
    }
    if (kind === 'waiting') {
        return name.replace(UNNUMBERED_WAITING_RE, (_, before, after) => `${before} ${number}${after}`);
    }
    return name;
}

function memberCount(channel) {
    return Number(channel?.members?.size || 0);
}

function clonePermissionOverwrites(channel) {
    const cache = channel?.permissionOverwrites?.cache;
    if (!cache) return [];
    return Array.from(cache.values()).map(overwrite => ({
        id: overwrite.id,
        type: overwrite.type,
        allow: overwrite.allow?.bitfield ?? overwrite.allow,
        deny: overwrite.deny?.bitfield ?? overwrite.deny,
    }));
}

function cloneChannelOptions(template, name, categoryId) {
    const options = {
        name,
        type: template.type,
        parent: categoryId,
        permissionOverwrites: clonePermissionOverwrites(template),
        reason: 'Maintain dynamic LIVE/Waiting voice channel pairs',
    };
    for (const key of ['bitrate', 'userLimit', 'rtcRegion', 'videoQualityMode']) {
        if (template[key] !== undefined && template[key] !== null) options[key] = template[key];
    }
    return options;
}

class LiveVoicePairManager {
    constructor(client, { categoryId, delayMs = 350, cleanupDelayMs = 60_000, logger = console } = {}) {
        this.client = client;
        this.categoryId = String(categoryId || '');
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
            for (const guild of this.client.guilds.cache.values()) this.schedule(guild, 0, false);
        });

        this.client.on('voiceStateUpdate', (oldState, newState) => {
            if (oldState.channel?.parentId !== this.categoryId && newState.channel?.parentId !== this.categoryId) return;
            const guild = newState.guild || oldState.guild;
            const oldManaged = describeManagedChannel(oldState.channel, this.categoryId);
            const newManaged = describeManagedChannel(newState.channel, this.categoryId);

            if (newManaged) this.cancelCleanup(guild.id, newManaged.number);
            if (oldManaged && oldManaged.number > 1 && oldState.channelId !== newState.channelId) {
                this.scheduleCleanup(guild, oldManaged.number);
            }

            // Only joining a LIVE channel consumes an open LIVE slot. Waiting
            // channels are deliberately excluded from the availability check.
            const joinedLive = newManaged?.kind === 'live' && oldState.channelId !== newState.channelId;
            if (joinedLive) this.schedule(guild, this.delayMs, true);
        });

        return this;
    }

    schedule(guild, delayMs = this.delayMs, ensureOpen = true) {
        if (!guild) return;
        clearTimeout(this.timers.get(guild.id));
        this.timers.set(guild.id, setTimeout(() => {
            this.timers.delete(guild.id);
            const previous = this.guildQueues.get(guild.id) || Promise.resolve();
            const next = previous
                .catch(() => {})
                .then(() => this.reconcile(guild, ensureOpen))
                .catch(error => this.logger.error(`[voice-pairs] ${guild.id}:`, error));
            this.guildQueues.set(guild.id, next);
        }, delayMs));
    }

    cleanupKey(guildId, number) {
        return `${guildId}:${number}`;
    }

    cancelCleanup(guildId, number) {
        const key = this.cleanupKey(guildId, number);
        clearTimeout(this.cleanupTimers.get(key));
        this.cleanupTimers.delete(key);
    }

    scheduleCleanup(guild, number) {
        if (!guild || number <= 1) return;
        const key = this.cleanupKey(guild.id, number);
        clearTimeout(this.cleanupTimers.get(key));
        this.cleanupTimers.set(key, setTimeout(() => {
            this.cleanupTimers.delete(key);
            this.deletePairIfEmpty(guild, number).catch(error => {
                this.logger.error(`[voice-pairs] cleanup ${guild.id}:${number}:`, error);
            });
        }, this.cleanupDelayMs));
    }

    async collectPairs(guild) {
        await guild.channels.fetch();

        const pairs = new Map();
        for (const channel of guild.channels.cache.values()) {
            const managed = describeManagedChannel(channel, this.categoryId);
            if (!managed) continue;
            const pair = pairs.get(managed.number) || {};
            pair[managed.kind] = channel;
            pairs.set(managed.number, pair);
        }
        return pairs;
    }

    async reconcile(guild, ensureOpen = true) {
        const pairs = await this.collectPairs(guild);

        const templates = pairs.get(1);
        if (!templates?.live || !templates?.waiting) {
            this.logger.warn(`[voice-pairs] ${guild.name || guild.id}: keep both LIVE 1 and Waiting 1 in category ${this.categoryId}.`);
            return;
        }

        if (ensureOpen) {
            const occupiedLiveExists = Array.from(pairs.values()).some(pair => memberCount(pair.live) > 0);
            const openLiveExists = Array.from(pairs.values()).some(pair => pair.live && memberCount(pair.live) === 0);

            // Waiting channels do not count here. If every LIVE channel is in
            // use, create the lowest available numbered pair.
            if (occupiedLiveExists && !openLiveExists) {
                let nextNumber = 2;
                while (pairs.has(nextNumber)) nextNumber += 1;
                const nextPair = {};
                nextPair.live = await guild.channels.create(cloneChannelOptions(
                    templates.live,
                    numberedName(templates.live.name, nextNumber, 'live'),
                    this.categoryId,
                ));
                nextPair.waiting = await guild.channels.create(cloneChannelOptions(
                    templates.waiting,
                    numberedName(templates.waiting.name, nextNumber, 'waiting'),
                    this.categoryId,
                ));
                pairs.set(nextNumber, nextPair);
            }
        }
    }

    async deletePairIfEmpty(guild, number) {
        if (number <= 1) return false;
        const pair = (await this.collectPairs(guild)).get(number) || {};
        if (memberCount(pair.live) + memberCount(pair.waiting) > 0) return false;
        for (const channel of [pair.live, pair.waiting]) {
            if (channel) {
                await channel.delete('Remove LIVE/Waiting pair after one minute empty');
            }
        }
        return true;
    }
}

function installLiveVoicePairs(client, options) {
    return new LiveVoicePairManager(client, options).install();
}

module.exports = {
    LiveVoicePairManager,
    clonePermissionOverwrites,
    describeManagedChannel,
    installLiveVoicePairs,
    numberedName,
};

