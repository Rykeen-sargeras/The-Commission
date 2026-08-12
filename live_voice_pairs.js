'use strict';

const LIVE_RE = /^(.*\bLIVE\s+)(\d+)(\b.*)$/iu;
const WAITING_RE = /^(.*\bWaiting\s+)(\d+)(\b.*)$/iu;

function describeManagedChannel(channel, categoryId) {
    if (!channel || channel.parentId !== categoryId) return null;
    const liveMatch = String(channel.name || '').match(LIVE_RE);
    if (liveMatch) return { kind: 'live', number: Number(liveMatch[2]) };
    const waitingMatch = String(channel.name || '').match(WAITING_RE);
    if (waitingMatch) return { kind: 'waiting', number: Number(waitingMatch[2]) };
    return null;
}

function numberedName(templateName, number, kind) {
    const pattern = kind === 'live' ? LIVE_RE : WAITING_RE;
    return String(templateName).replace(pattern, (_, before, _oldNumber, after) => `${before}${number}${after}`);
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
    constructor(client, { categoryId, delayMs = 350, logger = console } = {}) {
        this.client = client;
        this.categoryId = String(categoryId || '');
        this.delayMs = delayMs;
        this.logger = logger;
        this.timers = new Map();
        this.guildQueues = new Map();
    }

    install() {
        if (!this.categoryId) {
            this.logger.warn('[voice-pairs] LIVE_VOICE_CATEGORY_ID is not configured; dynamic pairs are disabled.');
            return this;
        }

        this.client.on('ready', () => {
            for (const guild of this.client.guilds.cache.values()) this.schedule(guild, 0);
        });

        this.client.on('voiceStateUpdate', (oldState, newState) => {
            if (oldState.channel?.parentId !== this.categoryId && newState.channel?.parentId !== this.categoryId) return;
            this.schedule(newState.guild || oldState.guild);
        });

        return this;
    }

    schedule(guild, delayMs = this.delayMs) {
        if (!guild) return;
        clearTimeout(this.timers.get(guild.id));
        this.timers.set(guild.id, setTimeout(() => {
            this.timers.delete(guild.id);
            const previous = this.guildQueues.get(guild.id) || Promise.resolve();
            const next = previous
                .catch(() => {})
                .then(() => this.reconcile(guild))
                .catch(error => this.logger.error(`[voice-pairs] ${guild.id}:`, error));
            this.guildQueues.set(guild.id, next);
        }, delayMs));
    }

    async reconcile(guild) {
        await guild.channels.fetch();

        const pairs = new Map();
        for (const channel of guild.channels.cache.values()) {
            const managed = describeManagedChannel(channel, this.categoryId);
            if (!managed) continue;
            const pair = pairs.get(managed.number) || {};
            pair[managed.kind] = channel;
            pairs.set(managed.number, pair);
        }

        const templates = pairs.get(1);
        if (!templates?.live || !templates?.waiting) {
            this.logger.warn(`[voice-pairs] ${guild.name || guild.id}: keep both LIVE 1 and Waiting 1 in category ${this.categoryId}.`);
            return;
        }

        // Any occupied pair gets one empty successor pair.
        const occupiedNumbers = Array.from(pairs.entries())
            .filter(([, pair]) => memberCount(pair.live) + memberCount(pair.waiting) > 0)
            .map(([number]) => number)
            .sort((a, b) => a - b);

        for (const number of occupiedNumbers) {
            const nextNumber = number + 1;
            const nextPair = pairs.get(nextNumber) || {};
            if (!nextPair.live) {
                nextPair.live = await guild.channels.create(cloneChannelOptions(
                    templates.live,
                    numberedName(templates.live.name, nextNumber, 'live'),
                    this.categoryId,
                ));
            }
            if (!nextPair.waiting) {
                nextPair.waiting = await guild.channels.create(cloneChannelOptions(
                    templates.waiting,
                    numberedName(templates.waiting.name, nextNumber, 'waiting'),
                    this.categoryId,
                ));
            }
            pairs.set(nextNumber, nextPair);
        }

        // Pair 1 is permanent. Other empty pairs only remain while the pair
        // immediately before them is occupied and therefore needs a spare.
        const numbersDescending = Array.from(pairs.keys()).filter(number => number > 1).sort((a, b) => b - a);
        for (const number of numbersDescending) {
            const pair = pairs.get(number) || {};
            const previous = pairs.get(number - 1) || {};
            const pairOccupied = memberCount(pair.live) + memberCount(pair.waiting) > 0;
            const previousOccupied = memberCount(previous.live) + memberCount(previous.waiting) > 0;
            if (pairOccupied || previousOccupied) continue;
            for (const channel of [pair.live, pair.waiting]) {
                if (channel && memberCount(channel) === 0) {
                    await channel.delete('Remove idle dynamic LIVE/Waiting voice channel pair');
                }
            }
        }
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

