const fs = require('fs');
const path = require('path');

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function parseDurationMs(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text || text.includes('permanent')) return null;
    const match = text.match(/(\d+(?:\.\d+)?)\s*(minute|min|hour|hr|day)s?/);
    if (!match) return null;
    const amount = Number(match[1]);
    const unit = match[2];
    if (unit === 'minute' || unit === 'min') return amount * 60_000;
    if (unit === 'hour' || unit === 'hr') return amount * 3_600_000;
    if (unit === 'day') return amount * 86_400_000;
    return null;
}

function recordKey(recordOrGuildId, userId) {
    if (typeof recordOrGuildId === 'object') {
        return `${recordOrGuildId.guildId}:${recordOrGuildId.userId}`;
    }
    return `${recordOrGuildId}:${userId}`;
}

function validRecord(record) {
    return Boolean(
        record
        && typeof record.guildId === 'string'
        && record.guildId
        && typeof record.userId === 'string'
        && record.userId
        && Number.isFinite(Number(record.releaseAt))
        && Number(record.releaseAt) > 0,
    );
}

class PersistentJailScheduler {
    constructor({
        filePath,
        onRelease,
        retryDelayMs = 60_000,
        now = () => Date.now(),
        setTimer = setTimeout,
        clearTimer = clearTimeout,
        logger = console,
    }) {
        if (!filePath) throw new Error('PersistentJailScheduler requires filePath.');
        if (typeof onRelease !== 'function') throw new Error('PersistentJailScheduler requires onRelease.');

        this.filePath = filePath;
        this.onRelease = onRelease;
        this.retryDelayMs = retryDelayMs;
        this.now = now;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.logger = logger;
        this.records = new Map();
        this.timers = new Map();
        this.inFlight = new Set();
        this.loaded = false;
    }

    load() {
        if (this.loaded) return this.list();
        this.loaded = true;
        if (!fs.existsSync(this.filePath)) return [];

        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            const records = Array.isArray(parsed) ? parsed : parsed?.activeJails;
            for (const record of Array.isArray(records) ? records : []) {
                if (!validRecord(record)) continue;
                const normalized = {
                    ...record,
                    releaseAt: Number(record.releaseAt),
                    jailedAt: Number(record.jailedAt) || null,
                };
                this.records.set(recordKey(normalized), normalized);
            }
        } catch (error) {
            this.logger.error(`[Jail scheduler] Could not load ${this.filePath}:`, error);
        }
        return this.list();
    }

    save() {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
        const payload = JSON.stringify({ version: 1, activeJails: this.list() }, null, 2);
        try {
            fs.writeFileSync(temporaryPath, payload, 'utf8');
            fs.renameSync(temporaryPath, this.filePath);
        } finally {
            if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
        }
    }

    list() {
        return [...this.records.values()].map(record => ({ ...record }));
    }

    has(guildId, userId) {
        this.load();
        return this.records.has(recordKey(guildId, userId));
    }

    schedule(record) {
        if (!validRecord(record)) throw new Error('Timed jail record is missing guildId, userId, or releaseAt.');
        this.load();
        const normalized = {
            ...record,
            releaseAt: Number(record.releaseAt),
            jailedAt: Number(record.jailedAt) || null,
        };
        const key = recordKey(normalized);
        this.records.set(key, normalized);
        this.save();
        this._arm(normalized);
        return { ...normalized };
    }

    remove(guildId, userId) {
        this.load();
        const key = recordKey(guildId, userId);
        const timer = this.timers.get(key);
        if (timer !== undefined) this.clearTimer(timer);
        this.timers.delete(key);
        const removed = this.records.delete(key);
        if (removed) this.save();
        return removed;
    }

    restore() {
        const records = this.load();
        for (const record of records) this._arm(record);
        return records.length;
    }

    stop() {
        for (const timer of this.timers.values()) this.clearTimer(timer);
        this.timers.clear();
    }

    _arm(record, overrideDelay = null) {
        const key = recordKey(record);
        const existingTimer = this.timers.get(key);
        if (existingTimer !== undefined) this.clearTimer(existingTimer);

        const remaining = Math.max(0, record.releaseAt - this.now());
        const delay = overrideDelay === null
            ? Math.min(remaining, MAX_TIMER_DELAY_MS)
            : Math.max(0, overrideDelay);
        const timer = this.setTimer(() => {
            this.timers.delete(key);
            this._release(key).catch(error => {
                this.logger.error('[Jail scheduler] Unexpected release failure:', error);
            });
        }, delay);
        timer?.unref?.();
        this.timers.set(key, timer);
    }

    async _release(key) {
        if (this.inFlight.has(key)) return;
        const record = this.records.get(key);
        if (!record) return;
        if (record.releaseAt > this.now()) {
            this._arm(record);
            return;
        }

        this.inFlight.add(key);
        try {
            const released = await this.onRelease({ ...record });
            if (released === false) throw new Error('Release handler reported an incomplete unjail.');
            this.records.delete(key);
            this.save();
        } catch (error) {
            this.logger.error(
                `[Jail scheduler] Auto-unjail failed for ${record.userId}; retrying in ${this.retryDelayMs}ms:`,
                error,
            );
            if (this.records.has(key)) this._arm(record, this.retryDelayMs);
        } finally {
            this.inFlight.delete(key);
        }
    }
}

module.exports = {
    MAX_TIMER_DELAY_MS,
    parseDurationMs,
    PersistentJailScheduler,
};
