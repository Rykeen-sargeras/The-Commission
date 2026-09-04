'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function nowIso() { return new Date().toISOString(); }
function asBool(value) { return value === true || value === 1 || value === '1' || value === 'true'; }
function cleanId(value) { return String(value || '').trim(); }

function encryptionKey(secret) {
    const raw = String(secret || '').trim();
    if (!raw) throw new Error('MEMBERSHIP_ENCRYPTION_KEY is not configured.');
    try {
        const decoded = Buffer.from(raw, 'base64');
        if (decoded.length === 32 && decoded.toString('base64').replace(/=+$/, '') === raw.replace(/=+$/, '')) return decoded;
    } catch {}
    return crypto.createHash('sha256').update(raw).digest();
}

function encryptJson(value, secret) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}

function decryptJson(value, secret) {
    const [version, iv, tag, encrypted] = String(value || '').split('.');
    if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('Stored YouTube credentials are invalid.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(secret), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8'));
}

function stateSecret(config = {}) {
    return String(config.MEMBERSHIP_STATE_SECRET || config.MEMBERSHIP_ENCRYPTION_KEY || '').trim();
}

function signState(payload, config = {}, ttlSeconds = 900) {
    const secret = stateSecret(config);
    if (!secret) throw new Error('MEMBERSHIP_STATE_SECRET is not configured.');
    const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
    const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${signature}`;
}

function verifyState(token, config = {}, expectedPurpose = '') {
    const secret = stateSecret(config);
    if (!secret) throw new Error('MEMBERSHIP_STATE_SECRET is not configured.');
    const [body, supplied] = String(token || '').split('.');
    if (!body || !supplied) throw new Error('This link is invalid or incomplete.');
    const expected = crypto.createHmac('sha256', secret).update(body).digest();
    const actual = Buffer.from(supplied, 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error('This link is invalid.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error('This link has expired. Ask for a new one.');
    if (expectedPurpose && payload.purpose !== expectedPurpose) throw new Error('This link cannot be used here.');
    return payload;
}

class MembershipStore {
    constructor(options = {}) {
        const dataDir = options.dataDir || process.env.DATA_DIR || process.cwd();
        fs.mkdirSync(dataDir, { recursive: true });
        this.dbPath = options.dbPath || path.join(dataDir, 'commission-memberships.sqlite');
        this.db = new DatabaseSync(this.dbPath);
        this.initialize();
    }

    initialize() {
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS membership_streamers (
                id TEXT PRIMARY KEY, display_name TEXT NOT NULL, expected_channel_id TEXT NOT NULL DEFAULT '',
                channel_id TEXT NOT NULL DEFAULT '', channel_title TEXT NOT NULL DEFAULT '', credentials TEXT NOT NULL DEFAULT '',
                token_expiry TEXT NOT NULL DEFAULT '', grace_days INTEGER NOT NULL DEFAULT 7,
                enabled INTEGER NOT NULL DEFAULT 1, last_sync_at TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS membership_tiers (
                streamer_id TEXT NOT NULL, youtube_level_id TEXT NOT NULL, display_name TEXT NOT NULL,
                discord_role_id TEXT NOT NULL DEFAULT '', PRIMARY KEY(streamer_id, youtube_level_id),
                FOREIGN KEY(streamer_id) REFERENCES membership_streamers(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS membership_links (
                discord_user_id TEXT PRIMARY KEY, youtube_channel_id TEXT NOT NULL, youtube_name TEXT NOT NULL DEFAULT '',
                linked_at TEXT NOT NULL, last_verified_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS membership_invites (
                token_hash TEXT PRIMARY KEY, streamer_id TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT NOT NULL DEFAULT '',
                FOREIGN KEY(streamer_id) REFERENCES membership_streamers(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS membership_status (
                streamer_id TEXT NOT NULL, discord_user_id TEXT NOT NULL, youtube_channel_id TEXT NOT NULL,
                youtube_level_id TEXT NOT NULL DEFAULT '', role_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
                last_active_at TEXT NOT NULL DEFAULT '', lapse_detected_at TEXT NOT NULL DEFAULT '', grace_expires_at TEXT NOT NULL DEFAULT '',
                last_checked_at TEXT NOT NULL, PRIMARY KEY(streamer_id, discord_user_id),
                FOREIGN KEY(streamer_id) REFERENCES membership_streamers(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS membership_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, event TEXT NOT NULL,
                streamer_id TEXT NOT NULL DEFAULT '', discord_user_id TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS membership_audit_at ON membership_audit(at DESC);
        `);
    }

    addStreamer(input = {}) {
        const id = crypto.randomUUID();
        const at = nowIso();
        const name = String(input.displayName || '').trim();
        if (!name) throw new Error('Enter a streamer name.');
        const graceDays = Math.max(0, Math.min(365, Number.parseInt(input.graceDays, 10) || 0));
        this.db.prepare(`INSERT INTO membership_streamers
            (id,display_name,expected_channel_id,grace_days,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
            .run(id, name, cleanId(input.expectedChannelId), graceDays, input.enabled === false ? 0 : 1, at, at);
        this.audit('streamer-added', id, '', name);
        return this.getStreamer(id);
    }

    updateStreamer(id, input = {}) {
        const current = this.getStreamer(id);
        if (!current) throw new Error('Streamer not found.');
        const name = input.displayName === undefined ? current.displayName : String(input.displayName).trim();
        if (!name) throw new Error('Enter a streamer name.');
        const graceDays = input.graceDays === undefined ? current.graceDays : Math.max(0, Math.min(365, Number.parseInt(input.graceDays, 10) || 0));
        const expected = input.expectedChannelId === undefined ? current.expectedChannelId : cleanId(input.expectedChannelId);
        const enabled = input.enabled === undefined ? current.enabled : Boolean(input.enabled);
        this.db.prepare('UPDATE membership_streamers SET display_name=?,expected_channel_id=?,grace_days=?,enabled=?,updated_at=? WHERE id=?')
            .run(name, expected, graceDays, enabled ? 1 : 0, nowIso(), id);
        this.audit('streamer-updated', id, '', name);
        return this.getStreamer(id);
    }

    deleteStreamer(id) { this.db.prepare('DELETE FROM membership_streamers WHERE id=?').run(id); this.audit('streamer-deleted', id); }
    getStreamer(id) { const row = this.db.prepare('SELECT * FROM membership_streamers WHERE id=?').get(id); return row ? this.mapStreamer(row) : null; }
    listStreamers() { return this.db.prepare('SELECT * FROM membership_streamers ORDER BY display_name COLLATE NOCASE').all().map(row => this.mapStreamer(row)); }
    mapStreamer(row) { return { id: row.id, displayName: row.display_name, expectedChannelId: row.expected_channel_id, channelId: row.channel_id, channelTitle: row.channel_title, connected: Boolean(row.credentials), tokenExpiry: row.token_expiry, graceDays: row.grace_days, enabled: asBool(row.enabled), lastSyncAt: row.last_sync_at, lastError: row.last_error, tiers: this.listTiers(row.id) }; }

    saveCreatorConnection(id, channel, tokens, secret) {
        const streamer = this.getStreamer(id);
        if (!streamer) throw new Error('Streamer not found.');
        if (streamer.expectedChannelId && streamer.expectedChannelId !== cleanId(channel.id)) throw new Error(`Connected channel ${channel.title || channel.id} does not match the channel ID configured by the owner.`);
        this.db.prepare('UPDATE membership_streamers SET channel_id=?,channel_title=?,credentials=?,token_expiry=?,last_error=?,updated_at=? WHERE id=?')
            .run(cleanId(channel.id), String(channel.title || ''), encryptJson(tokens, secret), String(tokens.expiry_date || ''), '', nowIso(), id);
        this.audit('creator-connected', id, '', `${channel.title || channel.id} (${channel.id})`);
    }

    credentials(id, secret) { const row = this.db.prepare('SELECT credentials FROM membership_streamers WHERE id=?').get(id); return row?.credentials ? decryptJson(row.credentials, secret) : null; }
    saveCredentials(id, tokens, secret) { this.db.prepare('UPDATE membership_streamers SET credentials=?,token_expiry=?,updated_at=? WHERE id=?').run(encryptJson(tokens, secret), String(tokens.expiry_date || ''), nowIso(), id); }
    disconnect(id) { this.db.prepare("UPDATE membership_streamers SET channel_id='',channel_title='',credentials='',token_expiry='',updated_at=? WHERE id=?").run(nowIso(), id); this.audit('creator-disconnected', id); }

    createInvite(streamerId, nonce, ttlSeconds = 7 * 86400) {
        const hash = crypto.createHash('sha256').update(String(nonce)).digest('hex');
        this.db.prepare('DELETE FROM membership_invites WHERE streamer_id=? OR expires_at<?').run(streamerId, nowIso());
        this.db.prepare('INSERT INTO membership_invites(token_hash,streamer_id,expires_at) VALUES(?,?,?)').run(hash, streamerId, new Date(Date.now() + ttlSeconds * 1000).toISOString());
    }
    consumeInvite(streamerId, nonce) {
        const hash = crypto.createHash('sha256').update(String(nonce)).digest('hex');
        const row = this.db.prepare("SELECT * FROM membership_invites WHERE token_hash=? AND streamer_id=? AND used_at='' AND expires_at>?").get(hash, streamerId, nowIso());
        if (!row) throw new Error('This creator link is expired or has already been used. Ask the owner for a new one.');
        this.db.prepare('UPDATE membership_invites SET used_at=? WHERE token_hash=?').run(nowIso(), hash);
    }

    replaceTiers(streamerId, tiers = []) {
        const old = new Map(this.listTiers(streamerId).map(t => [t.youtubeLevelId, t.discordRoleId]));
        this.db.exec('BEGIN IMMEDIATE');
        try {
            this.db.prepare('DELETE FROM membership_tiers WHERE streamer_id=?').run(streamerId);
            const stmt = this.db.prepare('INSERT INTO membership_tiers(streamer_id,youtube_level_id,display_name,discord_role_id) VALUES(?,?,?,?)');
            for (const tier of tiers) stmt.run(streamerId, cleanId(tier.youtubeLevelId || tier.id), String(tier.displayName || tier.title || 'Membership tier'), cleanId(tier.discordRoleId || old.get(cleanId(tier.youtubeLevelId || tier.id))));
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    listTiers(streamerId) { return this.db.prepare('SELECT * FROM membership_tiers WHERE streamer_id=? ORDER BY display_name COLLATE NOCASE').all(streamerId).map(r => ({ youtubeLevelId: r.youtube_level_id, displayName: r.display_name, discordRoleId: r.discord_role_id })); }
    mapTier(streamerId, levelId, roleId) { this.db.prepare('UPDATE membership_tiers SET discord_role_id=? WHERE streamer_id=? AND youtube_level_id=?').run(cleanId(roleId), streamerId, levelId); this.audit('tier-role-mapped', streamerId, '', `${levelId} -> ${cleanId(roleId)}`); }

    upsertLink(discordUserId, youtubeChannelId, youtubeName = '') {
        const at = nowIso();
        this.db.prepare(`INSERT INTO membership_links(discord_user_id,youtube_channel_id,youtube_name,linked_at,last_verified_at)
            VALUES(?,?,?,?,?) ON CONFLICT(discord_user_id) DO UPDATE SET youtube_channel_id=excluded.youtube_channel_id,youtube_name=excluded.youtube_name,last_verified_at=excluded.last_verified_at`)
            .run(cleanId(discordUserId), cleanId(youtubeChannelId), String(youtubeName || ''), at, at);
        this.audit('member-linked', '', cleanId(discordUserId), `${youtubeName || youtubeChannelId} (${youtubeChannelId})`);
    }
    listLinks() { return this.db.prepare('SELECT * FROM membership_links ORDER BY linked_at DESC').all().map(r => ({ discordUserId: r.discord_user_id, youtubeChannelId: r.youtube_channel_id, youtubeName: r.youtube_name, linkedAt: r.linked_at, lastVerifiedAt: r.last_verified_at })); }

    getStatus(streamerId, userId) { return this.db.prepare('SELECT * FROM membership_status WHERE streamer_id=? AND discord_user_id=?').get(streamerId, userId); }
    saveStatus(value) {
        this.db.prepare(`INSERT INTO membership_status(streamer_id,discord_user_id,youtube_channel_id,youtube_level_id,role_id,status,last_active_at,lapse_detected_at,grace_expires_at,last_checked_at)
            VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(streamer_id,discord_user_id) DO UPDATE SET youtube_channel_id=excluded.youtube_channel_id,youtube_level_id=excluded.youtube_level_id,role_id=excluded.role_id,status=excluded.status,last_active_at=excluded.last_active_at,lapse_detected_at=excluded.lapse_detected_at,grace_expires_at=excluded.grace_expires_at,last_checked_at=excluded.last_checked_at`)
            .run(value.streamerId, value.discordUserId, value.youtubeChannelId, value.youtubeLevelId || '', value.roleId || '', value.status, value.lastActiveAt || '', value.lapseDetectedAt || '', value.graceExpiresAt || '', value.lastCheckedAt || nowIso());
    }
    listStatuses(limit = 200) { return this.db.prepare('SELECT * FROM membership_status ORDER BY last_checked_at DESC LIMIT ?').all(Math.max(1, Math.min(1000, limit))); }
    setSyncResult(id, error = '') {
        const at = nowIso();
        if (error) this.db.prepare('UPDATE membership_streamers SET last_error=?,updated_at=? WHERE id=?').run(String(error), at, id);
        else this.db.prepare('UPDATE membership_streamers SET last_sync_at=?,last_error=?,updated_at=? WHERE id=?').run(at, '', at, id);
    }
    audit(event, streamerId = '', discordUserId = '', details = '') { this.db.prepare('INSERT INTO membership_audit(at,event,streamer_id,discord_user_id,details) VALUES(?,?,?,?,?)').run(nowIso(), event, streamerId, discordUserId, String(details || '')); }
    auditRows(limit = 100) { return this.db.prepare('SELECT * FROM membership_audit ORDER BY id DESC LIMIT ?').all(Math.max(1, Math.min(500, limit))); }
    close() { this.db.close(); }
}

function graceDecision(previous, graceDays, now = Date.now()) {
    const detected = previous?.lapse_detected_at || previous?.lapseDetectedAt || new Date(now).toISOString();
    const expiresAt = previous?.grace_expires_at || previous?.graceExpiresAt || new Date(new Date(detected).getTime() + Math.max(0, graceDays) * 86400000).toISOString();
    return { lapseDetectedAt: detected, graceExpiresAt: expiresAt, expired: now >= new Date(expiresAt).getTime() };
}

module.exports = { MembershipStore, encryptJson, decryptJson, signState, verifyState, graceDecision };
