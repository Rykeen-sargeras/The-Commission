'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { STATUS, ROLE_MODE } = require('./constants');
const { sha256 } = require('./crypto');

function now() { return new Date().toISOString(); }
function asJson(value, fallback = []) {
    try { return JSON.parse(value || ''); } catch { return fallback; }
}

class MemberBridgeStore {
    constructor({ dataDir, secretBox }) {
        fs.mkdirSync(dataDir, { recursive: true });
        this.dataDir = dataDir;
        this.secretBox = secretBox;
        this.dbPath = path.join(dataDir, 'memberbridge.db');
        this.db = new DatabaseSync(this.dbPath);
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
        this.migrate();
    }

    migrate() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS mb_schema_migrations(version INTEGER PRIMARY KEY, applied_utc TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS mb_creator_sources(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                guild_id TEXT NOT NULL,
                youtube_channel_id TEXT NOT NULL DEFAULT '',
                display_name TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 0,
                connection_status TEXT NOT NULL DEFAULT 'NotConnected',
                role_mode TEXT NOT NULL DEFAULT 'highest',
                general_role_id TEXT NOT NULL DEFAULT '',
                fallback_role_id TEXT NOT NULL DEFAULT '',
                missing_checks_before_grace INTEGER NOT NULL DEFAULT 2,
                grace_period_hours INTEGER NOT NULL DEFAULT 168,
                downgrade_checks_required INTEGER NOT NULL DEFAULT 2,
                verification_interval_minutes INTEGER NOT NULL DEFAULT 360,
                mass_absence_percent REAL NOT NULL DEFAULT 20,
                safe_mode INTEGER NOT NULL DEFAULT 0,
                safe_mode_reason TEXT NOT NULL DEFAULT '',
                last_successful_check_utc TEXT,
                last_attempt_utc TEXT,
                last_level_sync_utc TEXT,
                member_cache_refreshed_utc TEXT,
                last_error_code TEXT,
                last_error_message TEXT,
                created_utc TEXT NOT NULL,
                updated_utc TEXT NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS ux_mb_creator_channel ON mb_creator_sources(guild_id, youtube_channel_id) WHERE youtube_channel_id<>'';
            CREATE TABLE IF NOT EXISTS mb_creator_credentials(
                creator_source_id INTEGER PRIMARY KEY REFERENCES mb_creator_sources(id) ON DELETE CASCADE,
                encrypted_refresh_token TEXT NOT NULL,
                scopes TEXT NOT NULL DEFAULT '',
                token_version INTEGER NOT NULL DEFAULT 1,
                updated_utc TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS mb_membership_levels(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                creator_source_id INTEGER NOT NULL REFERENCES mb_creator_sources(id) ON DELETE CASCADE,
                youtube_level_id TEXT NOT NULL,
                display_name TEXT NOT NULL,
                display_order INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                currently_reported INTEGER NOT NULL DEFAULT 1,
                mapped_role_id TEXT NOT NULL DEFAULT '',
                last_seen_utc TEXT,
                created_utc TEXT NOT NULL,
                updated_utc TEXT NOT NULL,
                UNIQUE(creator_source_id, youtube_level_id)
            );
            CREATE TABLE IF NOT EXISTS mb_account_links(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                guild_id TEXT NOT NULL,
                discord_user_id TEXT NOT NULL,
                discord_username TEXT NOT NULL DEFAULT '',
                youtube_channel_id TEXT NOT NULL,
                youtube_display_name TEXT NOT NULL DEFAULT '',
                youtube_profile_image TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'Active',
                linked_utc TEXT NOT NULL,
                unlinked_utc TEXT,
                updated_utc TEXT NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS ux_mb_active_discord_link ON mb_account_links(guild_id, discord_user_id) WHERE status='Active';
            CREATE UNIQUE INDEX IF NOT EXISTS ux_mb_active_youtube_link ON mb_account_links(guild_id, youtube_channel_id) WHERE status='Active';
            CREATE TABLE IF NOT EXISTS mb_membership_records(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                guild_id TEXT NOT NULL,
                creator_source_id INTEGER NOT NULL REFERENCES mb_creator_sources(id) ON DELETE CASCADE,
                account_link_id INTEGER NOT NULL REFERENCES mb_account_links(id) ON DELETE CASCADE,
                status TEXT NOT NULL DEFAULT 'Unverified',
                previous_status TEXT,
                current_highest_level_id TEXT,
                current_level_name TEXT,
                previous_highest_level_id TEXT,
                accessible_level_ids_json TEXT NOT NULL DEFAULT '[]',
                managed_role_ids_json TEXT NOT NULL DEFAULT '[]',
                consecutive_missing_checks INTEGER NOT NULL DEFAULT 0,
                pending_downgrade_level_id TEXT,
                consecutive_downgrade_checks INTEGER NOT NULL DEFAULT 0,
                first_missing_utc TEXT,
                grace_started_utc TEXT,
                grace_expires_utc TEXT,
                last_attempt_utc TEXT,
                last_successful_utc TEXT,
                last_active_utc TEXT,
                next_verification_utc TEXT,
                last_error_code TEXT,
                last_error_message TEXT,
                created_utc TEXT NOT NULL,
                updated_utc TEXT NOT NULL,
                UNIQUE(guild_id, creator_source_id, account_link_id)
            );
            CREATE TABLE IF NOT EXISTS mb_verification_attempts(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                membership_record_id INTEGER REFERENCES mb_membership_records(id) ON DELETE SET NULL,
                creator_source_id INTEGER NOT NULL,
                attempt_utc TEXT NOT NULL,
                completed_utc TEXT,
                result TEXT NOT NULL,
                returned_member INTEGER NOT NULL DEFAULT 0,
                reported_level_id TEXT,
                http_status INTEGER,
                error_code TEXT,
                error_summary TEXT,
                correlation_id TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS mb_role_operations(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                guild_id TEXT NOT NULL,
                discord_user_id TEXT NOT NULL,
                discord_role_id TEXT NOT NULL,
                creator_source_id INTEGER NOT NULL,
                membership_record_id INTEGER,
                operation_type TEXT NOT NULL,
                status TEXT NOT NULL,
                attempt_count INTEGER NOT NULL DEFAULT 1,
                requested_utc TEXT NOT NULL,
                completed_utc TEXT,
                next_retry_utc TEXT,
                last_error TEXT,
                correlation_id TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS mb_manual_overrides(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                membership_record_id INTEGER NOT NULL REFERENCES mb_membership_records(id) ON DELETE CASCADE,
                override_type TEXT NOT NULL,
                forced_level_id TEXT,
                forced_role_id TEXT,
                reason TEXT NOT NULL,
                administrator_user_id TEXT NOT NULL,
                starts_utc TEXT NOT NULL,
                expires_utc TEXT,
                active INTEGER NOT NULL DEFAULT 1,
                created_utc TEXT NOT NULL,
                updated_utc TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS mb_link_sessions(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token_hash TEXT NOT NULL UNIQUE,
                state_hash TEXT,
                google_state_hash TEXT,
                discord_guild_id TEXT NOT NULL,
                discord_user_id TEXT NOT NULL,
                discord_username TEXT NOT NULL DEFAULT '',
                pkce_verifier TEXT,
                discord_confirmed INTEGER NOT NULL DEFAULT 0,
                channel_choices_json TEXT,
                expires_utc TEXT NOT NULL,
                used_utc TEXT,
                created_utc TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_mb_link_sessions_user ON mb_link_sessions(discord_guild_id, discord_user_id, expires_utc);
            CREATE TABLE IF NOT EXISTS mb_creator_oauth_sessions(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                creator_source_id INTEGER NOT NULL REFERENCES mb_creator_sources(id) ON DELETE CASCADE,
                state_hash TEXT NOT NULL,
                pkce_verifier TEXT NOT NULL,
                purpose TEXT NOT NULL DEFAULT 'connect',
                expires_utc TEXT NOT NULL,
                used_utc TEXT,
                created_utc TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS mb_creator_invites(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                creator_source_id INTEGER NOT NULL REFERENCES mb_creator_sources(id) ON DELETE CASCADE,
                token_hash TEXT NOT NULL UNIQUE,
                expires_utc TEXT NOT NULL,
                used_utc TEXT,
                created_utc TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS mb_creator_portal_sessions(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                creator_source_id INTEGER NOT NULL REFERENCES mb_creator_sources(id) ON DELETE CASCADE,
                token_hash TEXT NOT NULL UNIQUE,
                csrf_hash TEXT NOT NULL,
                expires_utc TEXT NOT NULL,
                last_seen_utc TEXT NOT NULL,
                created_utc TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_mb_creator_portal_session_expiry ON mb_creator_portal_sessions(expires_utc);
            CREATE TABLE IF NOT EXISTS mb_owner_portal_sessions(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token_hash TEXT NOT NULL UNIQUE,
                csrf_hash TEXT NOT NULL,
                expires_utc TEXT NOT NULL,
                last_seen_utc TEXT NOT NULL,
                created_utc TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_mb_owner_portal_session_expiry ON mb_owner_portal_sessions(expires_utc);
            CREATE TABLE IF NOT EXISTS mb_creator_member_cache(
                creator_source_id INTEGER NOT NULL REFERENCES mb_creator_sources(id) ON DELETE CASCADE,
                youtube_channel_id TEXT NOT NULL,
                display_name TEXT NOT NULL DEFAULT '',
                profile_image_url TEXT NOT NULL DEFAULT '',
                highest_level_id TEXT NOT NULL DEFAULT '',
                highest_level_name TEXT NOT NULL DEFAULT '',
                member_since_utc TEXT,
                total_duration_months INTEGER NOT NULL DEFAULT 0,
                fetched_utc TEXT NOT NULL,
                PRIMARY KEY(creator_source_id, youtube_channel_id)
            );
            CREATE TABLE IF NOT EXISTS mb_audit_events(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT NOT NULL,
                severity TEXT NOT NULL,
                guild_id TEXT,
                creator_source_id INTEGER,
                membership_record_id INTEGER,
                discord_user_id TEXT,
                administrator_user_id TEXT,
                message TEXT NOT NULL,
                data_json TEXT NOT NULL DEFAULT '{}',
                correlation_id TEXT NOT NULL,
                created_utc TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS mb_simulator_members(
                creator_source_id INTEGER NOT NULL REFERENCES mb_creator_sources(id) ON DELETE CASCADE,
                youtube_channel_id TEXT NOT NULL,
                display_name TEXT NOT NULL DEFAULT '',
                highest_level_id TEXT,
                accessible_levels_json TEXT NOT NULL DEFAULT '[]',
                is_active INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY(creator_source_id, youtube_channel_id)
            );
            CREATE TABLE IF NOT EXISTS mb_simulator_state(
                creator_source_id INTEGER PRIMARY KEY REFERENCES mb_creator_sources(id) ON DELETE CASCADE,
                failure_mode TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS mb_verify_panels(
                guild_id TEXT PRIMARY KEY,
                category_id TEXT NOT NULL DEFAULT '',
                channel_id TEXT NOT NULL DEFAULT '',
                message_id TEXT NOT NULL DEFAULT '',
                updated_utc TEXT NOT NULL
            );
            INSERT OR IGNORE INTO mb_schema_migrations(version, applied_utc) VALUES(1, datetime('now'));
            INSERT OR IGNORE INTO mb_schema_migrations(version, applied_utc) VALUES(2, datetime('now'));
            INSERT OR IGNORE INTO mb_schema_migrations(version, applied_utc) VALUES(3, datetime('now'));
        `);
        const creatorOauthColumns = new Set(this.db.prepare('PRAGMA table_info(mb_creator_oauth_sessions)').all().map(column => column.name));
        if (!creatorOauthColumns.has('purpose')) this.db.exec("ALTER TABLE mb_creator_oauth_sessions ADD COLUMN purpose TEXT NOT NULL DEFAULT 'connect'");
        const creatorColumns = new Set(this.db.prepare('PRAGMA table_info(mb_creator_sources)').all().map(column => column.name));
        if (!creatorColumns.has('member_cache_refreshed_utc')) this.db.exec('ALTER TABLE mb_creator_sources ADD COLUMN member_cache_refreshed_utc TEXT');
    }

    integrityCheck() {
        return this.db.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok';
    }

    audit(eventType, message, options = {}) {
        const correlationId = options.correlationId || require('crypto').randomUUID();
        this.db.prepare(`INSERT INTO mb_audit_events(event_type,severity,guild_id,creator_source_id,membership_record_id,discord_user_id,administrator_user_id,message,data_json,correlation_id,created_utc)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(eventType, options.severity || 'info', options.guildId || null, options.creatorSourceId || null,
            options.membershipRecordId || null, options.discordUserId || null, options.administratorUserId || null,
            String(message).substring(0, 2000), JSON.stringify(options.data || {}), correlationId, now());
        return correlationId;
    }

    listAudit(limit = 100) {
        return this.db.prepare('SELECT * FROM mb_audit_events ORDER BY id DESC LIMIT ?').all(Math.min(500, Math.max(1, limit)));
    }

    getVerifyPanel(guildId) {
        return this.db.prepare('SELECT * FROM mb_verify_panels WHERE guild_id=?').get(String(guildId));
    }

    saveVerifyPanel(guildId, panel = {}) {
        const stamp = now();
        this.db.prepare(`INSERT INTO mb_verify_panels(guild_id,category_id,channel_id,message_id,updated_utc)
            VALUES(?,?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET category_id=excluded.category_id,channel_id=excluded.channel_id,message_id=excluded.message_id,updated_utc=excluded.updated_utc`)
            .run(String(guildId), String(panel.categoryId || ''), String(panel.channelId || ''), String(panel.messageId || ''), stamp);
        return this.getVerifyPanel(guildId);
    }

    clearVerifyPanel(guildId) {
        return this.db.prepare('DELETE FROM mb_verify_panels WHERE guild_id=?').run(String(guildId)).changes > 0;
    }

    createCreator(input) {
        const stamp = now();
        const result = this.db.prepare(`INSERT INTO mb_creator_sources(guild_id,display_name,role_mode,missing_checks_before_grace,grace_period_hours,downgrade_checks_required,verification_interval_minutes,mass_absence_percent,created_utc,updated_utc)
            VALUES(?,?,?,?,?,?,?,?,?,?)`).run(input.guildId, input.displayName, input.roleMode || ROLE_MODE.HIGHEST,
            input.missingChecksBeforeGrace || 2, input.gracePeriodHours ?? 168, input.downgradeChecksRequired || 2,
            input.verificationIntervalMinutes || 360, input.massAbsencePercent ?? 20, stamp, stamp);
        const id = Number(result.lastInsertRowid);
        this.audit('Creator source created', `Created creator source ${input.displayName}.`, { guildId: input.guildId, creatorSourceId: id, administratorUserId: input.administratorUserId });
        return this.getCreator(id);
    }

    getCreator(id) { return this.db.prepare('SELECT * FROM mb_creator_sources WHERE id=?').get(Number(id)); }
    listCreators(guildId) { return this.db.prepare('SELECT * FROM mb_creator_sources WHERE guild_id=? ORDER BY display_name').all(guildId); }
    listAllCreators() { return this.db.prepare('SELECT * FROM mb_creator_sources ORDER BY display_name,id').all(); }
    enabledCreators(guildId) { return this.db.prepare('SELECT * FROM mb_creator_sources WHERE guild_id=? AND enabled=1 ORDER BY id').all(guildId); }

    updateCreator(id, patch) {
        const allowed = new Set(['display_name','enabled','role_mode','general_role_id','fallback_role_id','missing_checks_before_grace','grace_period_hours','downgrade_checks_required','verification_interval_minutes','mass_absence_percent','safe_mode','safe_mode_reason','connection_status']);
        const fields = Object.keys(patch).filter(key => allowed.has(key));
        if (!fields.length) return this.getCreator(id);
        const values = fields.map(key => patch[key]);
        this.db.prepare(`UPDATE mb_creator_sources SET ${fields.map(key => `${key}=?`).join(',')},updated_utc=? WHERE id=?`).run(...values, now(), Number(id));
        return this.getCreator(id);
    }

    saveCreatorAuthorization(id, channel, refreshToken, scopes) {
        const stamp = now();
        this.db.prepare(`UPDATE mb_creator_sources SET youtube_channel_id=?,display_name=?,connection_status='Operational',enabled=1,last_error_code=NULL,last_error_message=NULL,updated_utc=? WHERE id=?`)
            .run(channel.id, channel.snippet?.title || channel.title || `Creator ${id}`, stamp, Number(id));
        this.db.prepare(`INSERT INTO mb_creator_credentials(creator_source_id,encrypted_refresh_token,scopes,updated_utc) VALUES(?,?,?,?)
            ON CONFLICT(creator_source_id) DO UPDATE SET encrypted_refresh_token=excluded.encrypted_refresh_token,scopes=excluded.scopes,updated_utc=excluded.updated_utc`)
            .run(Number(id), this.secretBox.encrypt(refreshToken), scopes || '', stamp);
    }

    getCreatorRefreshToken(id) {
        const row = this.db.prepare('SELECT encrypted_refresh_token FROM mb_creator_credentials WHERE creator_source_id=?').get(Number(id));
        return row ? this.secretBox.decrypt(row.encrypted_refresh_token) : '';
    }

    markCreatorError(id, code, message) {
        this.db.prepare(`UPDATE mb_creator_sources SET connection_status='Error',last_error_code=?,last_error_message=?,last_attempt_utc=?,updated_utc=? WHERE id=?`)
            .run(String(code || 'error'), String(message || '').substring(0, 1000), now(), now(), Number(id));
    }

    markCreatorOperational(id) {
        const stamp = now();
        this.db.prepare(`UPDATE mb_creator_sources SET connection_status='Operational',enabled=1,last_successful_check_utc=?,last_attempt_utc=?,last_error_code=NULL,last_error_message=NULL,updated_utc=? WHERE id=?`)
            .run(stamp, stamp, stamp, Number(id));
        return this.getCreator(id);
    }

    saveLevels(creatorId, levels) {
        const stamp = now();
        const seen = new Set();
        const upsert = this.db.prepare(`INSERT INTO mb_membership_levels(creator_source_id,youtube_level_id,display_name,display_order,last_seen_utc,created_utc,updated_utc)
            VALUES(?,?,?,?,?,?,?) ON CONFLICT(creator_source_id,youtube_level_id) DO UPDATE SET display_name=excluded.display_name,display_order=excluded.display_order,currently_reported=1,last_seen_utc=excluded.last_seen_utc,updated_utc=excluded.updated_utc`);
        this.db.exec('BEGIN IMMEDIATE');
        try {
            levels.forEach((level, index) => {
                seen.add(level.id);
                upsert.run(Number(creatorId), level.id, level.snippet?.levelDetails?.displayName || level.snippet?.displayName || level.displayName || level.id, index, stamp, stamp, stamp);
            });
            if (seen.size) {
                const placeholders = [...seen].map(() => '?').join(',');
                this.db.prepare(`UPDATE mb_membership_levels SET currently_reported=0,updated_utc=? WHERE creator_source_id=? AND youtube_level_id NOT IN (${placeholders})`).run(stamp, Number(creatorId), ...seen);
            } else {
                this.db.prepare('UPDATE mb_membership_levels SET currently_reported=0,updated_utc=? WHERE creator_source_id=?').run(stamp, Number(creatorId));
            }
            this.db.prepare('UPDATE mb_creator_sources SET last_level_sync_utc=?,updated_utc=? WHERE id=?').run(stamp, stamp, Number(creatorId));
            this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
        return this.listLevels(creatorId);
    }

    listLevels(creatorId) { return this.db.prepare('SELECT * FROM mb_membership_levels WHERE creator_source_id=? ORDER BY display_order,id').all(Number(creatorId)); }
    setRoleMapping(creatorId, youtubeLevelId, roleId, enabled = true) {
        this.db.prepare('UPDATE mb_membership_levels SET mapped_role_id=?,enabled=?,updated_utc=? WHERE creator_source_id=? AND youtube_level_id=?')
            .run(String(roleId || ''), enabled ? 1 : 0, now(), Number(creatorId), youtubeLevelId);
        return this.db.prepare('SELECT * FROM mb_membership_levels WHERE creator_source_id=? AND youtube_level_id=?').get(Number(creatorId), youtubeLevelId);
    }

    activeLinks(guildId) { return this.db.prepare("SELECT * FROM mb_account_links WHERE guild_id=? AND status='Active' ORDER BY id").all(guildId); }
    findLink(guildId, discordUserId) { return this.db.prepare("SELECT * FROM mb_account_links WHERE guild_id=? AND discord_user_id=? AND status='Active'").get(guildId, discordUserId); }
    linkAccount(input) {
        const stamp = now();
        this.db.exec('BEGIN IMMEDIATE');
        try {
            this.db.prepare("UPDATE mb_account_links SET status='Unlinked',unlinked_utc=?,updated_utc=? WHERE guild_id=? AND (discord_user_id=? OR youtube_channel_id=?) AND status='Active'")
                .run(stamp, stamp, input.guildId, input.discordUserId, input.youtubeChannelId);
            const result = this.db.prepare(`INSERT INTO mb_account_links(guild_id,discord_user_id,discord_username,youtube_channel_id,youtube_display_name,youtube_profile_image,status,linked_utc,updated_utc)
                VALUES(?,?,?,?,?,?,'Active',?,?)`).run(input.guildId, input.discordUserId, input.discordUsername || '', input.youtubeChannelId, input.youtubeDisplayName || '', input.youtubeProfileImage || '', stamp, stamp);
            const linkId = Number(result.lastInsertRowid);
            for (const creator of this.enabledCreators(input.guildId)) this.ensureRecord(creator, linkId);
            this.db.exec('COMMIT');
            return this.db.prepare('SELECT * FROM mb_account_links WHERE id=?').get(linkId);
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }

    unlinkAccount(guildId, discordUserId) {
        const stamp = now();
        const link = this.findLink(guildId, discordUserId);
        if (!link) return false;
        this.db.prepare("UPDATE mb_account_links SET status='Unlinked',unlinked_utc=?,updated_utc=? WHERE id=?").run(stamp, stamp, link.id);
        this.db.prepare(`UPDATE mb_membership_records SET status=?,previous_status=status,updated_utc=? WHERE account_link_id=?`).run(STATUS.UNLINKED, stamp, link.id);
        return true;
    }

    ensureRecord(creator, linkId) {
        const stamp = now();
        this.db.prepare(`INSERT OR IGNORE INTO mb_membership_records(guild_id,creator_source_id,account_link_id,status,next_verification_utc,created_utc,updated_utc)
            VALUES(?,?,?,?,?,?,?)`).run(creator.guild_id, creator.id, Number(linkId), STATUS.UNVERIFIED, stamp, stamp, stamp);
        return this.db.prepare('SELECT * FROM mb_membership_records WHERE creator_source_id=? AND account_link_id=?').get(creator.id, Number(linkId));
    }

    creatorRecords(creatorId) {
        const creator = this.getCreator(creatorId);
        if (!creator) return [];
        const links = this.activeLinks(creator.guild_id);
        links.forEach(link => this.ensureRecord(creator, link.id));
        return this.db.prepare(`SELECT r.*,l.discord_user_id,l.discord_username,l.youtube_channel_id,l.youtube_display_name
            FROM mb_membership_records r JOIN mb_account_links l ON l.id=r.account_link_id
            WHERE r.creator_source_id=? AND l.status='Active' ORDER BY r.id`).all(Number(creatorId));
    }

    userRecords(guildId, discordUserId) {
        return this.db.prepare(`SELECT r.*,c.display_name creator_name,c.youtube_channel_id creator_channel_id,l.youtube_display_name,l.youtube_channel_id
            FROM mb_membership_records r JOIN mb_creator_sources c ON c.id=r.creator_source_id JOIN mb_account_links l ON l.id=r.account_link_id
            WHERE r.guild_id=? AND l.discord_user_id=? ORDER BY c.display_name`).all(guildId, discordUserId).map(row => ({...row, accessibleLevels: asJson(row.accessible_level_ids_json), managedRoleIds: asJson(row.managed_role_ids_json)}));
    }

    updateRecord(id, patch) {
        const allowed = new Set(['status','previous_status','current_highest_level_id','current_level_name','previous_highest_level_id','accessible_level_ids_json','managed_role_ids_json','consecutive_missing_checks','pending_downgrade_level_id','consecutive_downgrade_checks','first_missing_utc','grace_started_utc','grace_expires_utc','last_attempt_utc','last_successful_utc','last_active_utc','next_verification_utc','last_error_code','last_error_message']);
        const fields = Object.keys(patch).filter(key => allowed.has(key));
        if (!fields.length) return this.getRecord(id);
        this.db.prepare(`UPDATE mb_membership_records SET ${fields.map(key => `${key}=?`).join(',')},updated_utc=? WHERE id=?`).run(...fields.map(key => patch[key]), now(), Number(id));
        return this.getRecord(id);
    }
    getRecord(id) { return this.db.prepare('SELECT * FROM mb_membership_records WHERE id=?').get(Number(id)); }

    addVerification(input) {
        this.db.prepare(`INSERT INTO mb_verification_attempts(membership_record_id,creator_source_id,attempt_utc,completed_utc,result,returned_member,reported_level_id,http_status,error_code,error_summary,correlation_id)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(input.recordId || null, input.creatorId, input.attemptUtc || now(), now(), input.result,
            input.returnedMember ? 1 : 0, input.levelId || null, input.httpStatus || null, input.errorCode || null, String(input.errorSummary || '').substring(0, 1000), input.correlationId);
    }

    addRoleOperation(input) {
        this.db.prepare(`INSERT INTO mb_role_operations(guild_id,discord_user_id,discord_role_id,creator_source_id,membership_record_id,operation_type,status,attempt_count,requested_utc,completed_utc,next_retry_utc,last_error,correlation_id)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.guildId,input.discordUserId,input.roleId,input.creatorId,input.recordId,input.operationType,input.status,input.attemptCount || 1,input.requestedUtc || now(),input.completedUtc || null,input.nextRetryUtc || null,input.error || null,input.correlationId);
    }

    createOverride(input) {
        const stamp = now();
        this.db.prepare('UPDATE mb_manual_overrides SET active=0,updated_utc=? WHERE membership_record_id=? AND active=1').run(stamp, Number(input.recordId));
        const result = this.db.prepare(`INSERT INTO mb_manual_overrides(membership_record_id,override_type,forced_level_id,forced_role_id,reason,administrator_user_id,starts_utc,expires_utc,active,created_utc,updated_utc)
            VALUES(?,?,?,?,?,?,?,?,1,?,?)`).run(Number(input.recordId), input.overrideType, input.forcedLevelId || null, input.forcedRoleId || null, String(input.reason || '').substring(0,500), String(input.administratorUserId || 'desktop-owner'), stamp, input.expiresUtc || null, stamp, stamp);
        this.audit('Manual override created', `${input.overrideType}: ${input.reason}`, { membershipRecordId: Number(input.recordId), administratorUserId: input.administratorUserId });
        return this.db.prepare('SELECT * FROM mb_manual_overrides WHERE id=?').get(Number(result.lastInsertRowid));
    }

    activeOverride(recordId) {
        const stamp = now();
        const expired = this.db.prepare('SELECT * FROM mb_manual_overrides WHERE membership_record_id=? AND active=1 AND expires_utc IS NOT NULL AND expires_utc<=?').get(Number(recordId), stamp);
        if (expired) {
            this.db.prepare('UPDATE mb_manual_overrides SET active=0,updated_utc=? WHERE id=?').run(stamp, expired.id);
            this.audit('Manual override expired', `Override ${expired.id} expired; automatic verification resumed.`, { membershipRecordId: Number(recordId) });
        }
        return this.db.prepare('SELECT * FROM mb_manual_overrides WHERE membership_record_id=? AND active=1 AND (expires_utc IS NULL OR expires_utc>?) ORDER BY id DESC LIMIT 1').get(Number(recordId), stamp);
    }

    removeOverride(recordId, administratorUserId = 'desktop-owner') {
        const changed = this.db.prepare('UPDATE mb_manual_overrides SET active=0,updated_utc=? WHERE membership_record_id=? AND active=1').run(now(), Number(recordId)).changes;
        if (changed) this.audit('Manual override removed', `Automatic verification resumed for membership record ${recordId}.`, { membershipRecordId: Number(recordId), administratorUserId });
        return Boolean(changed);
    }

    backupDirectory() {
        const target = path.join(this.dataDir, 'memberbridge-backups');
        fs.mkdirSync(target, { recursive: true });
        return target;
    }

    createBackup() {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `memberbridge-${stamp}.db`;
        const target = path.join(this.backupDirectory(), fileName);
        this.db.exec('PRAGMA wal_checkpoint(FULL)');
        this.db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
        const sha256 = require('crypto').createHash('sha256').update(fs.readFileSync(target)).digest('hex');
        fs.writeFileSync(`${target}.json`, JSON.stringify({ fileName, createdUtc: now(), sha256, application: 'The Commission MemberBridge', schemaVersion: 1 }, null, 2));
        const backups = this.listBackups();
        for (const old of backups.slice(14)) {
            fs.unlinkSync(path.join(this.backupDirectory(), old.fileName));
            if (fs.existsSync(path.join(this.backupDirectory(), `${old.fileName}.json`))) fs.unlinkSync(path.join(this.backupDirectory(), `${old.fileName}.json`));
        }
        this.audit('Backup created', `Created verified MemberBridge backup ${fileName}.`, { severity: 'success', data: { fileName, sha256 } });
        return { fileName, sha256, valid: this.verifyBackup(fileName).valid };
    }

    listBackups() {
        return fs.readdirSync(this.backupDirectory(), { withFileTypes: true }).filter(entry => entry.isFile() && /^memberbridge-[\w.-]+\.db$/.test(entry.name)).map(entry => {
            const stats = fs.statSync(path.join(this.backupDirectory(), entry.name));
            return { fileName: entry.name, size: stats.size, createdUtc: stats.mtime.toISOString() };
        }).sort((a,b) => b.createdUtc.localeCompare(a.createdUtc));
    }

    verifyBackup(fileName) {
        if (!/^memberbridge-[\w.-]+\.db$/.test(String(fileName))) throw new Error('Invalid backup file name.');
        const target = path.join(this.backupDirectory(), fileName);
        if (!fs.existsSync(target)) throw new Error('Backup file not found.');
        const actual = require('crypto').createHash('sha256').update(fs.readFileSync(target)).digest('hex');
        let manifest = {};
        try { manifest = JSON.parse(fs.readFileSync(`${target}.json`, 'utf8')); } catch { return { fileName, valid: false, reason: 'Manifest is missing or invalid.', sha256: actual }; }
        const check = new DatabaseSync(target, { readOnly: true });
        let integrity = false;
        try { integrity = check.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok'; } finally { check.close(); }
        return { fileName, valid: integrity && manifest.sha256 === actual, integrity, sha256: actual, expectedSha256: manifest.sha256 };
    }

    createLinkSession(input) {
        const stamp = now();
        this.db.prepare('DELETE FROM mb_link_sessions WHERE expires_utc<=? OR used_utc IS NOT NULL').run(stamp);
        const active = this.db.prepare('SELECT id FROM mb_link_sessions WHERE discord_guild_id=? AND discord_user_id=? AND expires_utc>? AND used_utc IS NULL').get(input.guildId,input.discordUserId,stamp);
        if (active) this.db.prepare('UPDATE mb_link_sessions SET used_utc=? WHERE id=?').run(stamp, active.id);
        this.db.prepare(`INSERT INTO mb_link_sessions(token_hash,discord_guild_id,discord_user_id,discord_username,expires_utc,created_utc) VALUES(?,?,?,?,?,?)`)
            .run(sha256(input.token), input.guildId, input.discordUserId, input.discordUsername || '', input.expiresUtc, stamp);
        return this.findLinkSession(input.token);
    }
    findLinkSession(token) { return this.db.prepare('SELECT * FROM mb_link_sessions WHERE token_hash=?').get(sha256(token)); }
    updateLinkSession(id, patch) {
        const allowed = new Set(['state_hash','google_state_hash','pkce_verifier','discord_confirmed','channel_choices_json','used_utc']);
        const fields = Object.keys(patch).filter(key => allowed.has(key));
        if (fields.length) this.db.prepare(`UPDATE mb_link_sessions SET ${fields.map(key => `${key}=?`).join(',')} WHERE id=?`).run(...fields.map(key => patch[key]), Number(id));
        return this.db.prepare('SELECT * FROM mb_link_sessions WHERE id=?').get(Number(id));
    }
    findLinkSessionByState(state, kind = 'discord') {
        const column = kind === 'google' ? 'google_state_hash' : 'state_hash';
        return this.db.prepare(`SELECT * FROM mb_link_sessions WHERE ${column}=?`).get(sha256(state));
    }

    createCreatorOAuthSession(creatorId, state, verifier, expiresUtc, purpose = 'connect') {
        this.db.prepare('INSERT INTO mb_creator_oauth_sessions(creator_source_id,state_hash,pkce_verifier,purpose,expires_utc,created_utc) VALUES(?,?,?,?,?,?)')
            .run(Number(creatorId), sha256(state), verifier, String(purpose || 'connect'), expiresUtc, now());
    }
    consumeCreatorOAuthSession(state) {
        const row = this.db.prepare('SELECT * FROM mb_creator_oauth_sessions WHERE state_hash=?').get(sha256(state));
        if (!row || row.used_utc || row.expires_utc <= now()) return null;
        this.db.prepare('UPDATE mb_creator_oauth_sessions SET used_utc=? WHERE id=?').run(now(), row.id);
        return row;
    }

    createCreatorInvite(creatorId, token, expiresUtc) {
        const stamp = now();
        this.db.prepare('DELETE FROM mb_creator_invites WHERE creator_source_id=? OR expires_utc<=? OR used_utc IS NOT NULL').run(Number(creatorId), stamp);
        this.db.prepare('INSERT INTO mb_creator_invites(creator_source_id,token_hash,expires_utc,created_utc) VALUES(?,?,?,?)')
            .run(Number(creatorId), sha256(token), expiresUtc, stamp);
        return { creatorSourceId: Number(creatorId), expiresUtc };
    }

    findCreatorInvite(token) {
        return this.db.prepare('SELECT * FROM mb_creator_invites WHERE token_hash=?').get(sha256(token));
    }

    consumeCreatorInvite(token) {
        const row = this.findCreatorInvite(token);
        if (!row || row.used_utc || row.expires_utc <= now()) return null;
        this.db.prepare('UPDATE mb_creator_invites SET used_utc=? WHERE id=?').run(now(), row.id);
        return row;
    }

    createCreatorPortalSession(creatorId, token, csrfToken, expiresUtc) {
        const stamp = now();
        this.db.prepare('DELETE FROM mb_creator_portal_sessions WHERE expires_utc<=?').run(stamp);
        this.db.prepare('INSERT INTO mb_creator_portal_sessions(creator_source_id,token_hash,csrf_hash,expires_utc,last_seen_utc,created_utc) VALUES(?,?,?,?,?,?)')
            .run(Number(creatorId), sha256(token), sha256(csrfToken), expiresUtc, stamp, stamp);
        return this.findCreatorPortalSession(token);
    }

    findCreatorPortalSession(token) {
        if (!token) return null;
        const row = this.db.prepare(`SELECT session.*,creator.guild_id,creator.youtube_channel_id,creator.display_name,creator.connection_status,creator.last_successful_check_utc,creator.last_error_code,creator.last_error_message
            FROM mb_creator_portal_sessions session JOIN mb_creator_sources creator ON creator.id=session.creator_source_id
            WHERE session.token_hash=?`).get(sha256(token));
        if (!row || row.expires_utc <= now()) return null;
        this.db.prepare('UPDATE mb_creator_portal_sessions SET last_seen_utc=? WHERE id=?').run(now(), row.id);
        return row;
    }

    deleteCreatorPortalSession(token) {
        return this.db.prepare('DELETE FROM mb_creator_portal_sessions WHERE token_hash=?').run(sha256(token || '')).changes > 0;
    }

    createOwnerPortalSession(token, csrfToken, expiresUtc) {
        const stamp = now();
        this.db.prepare('DELETE FROM mb_owner_portal_sessions WHERE expires_utc<=?').run(stamp);
        this.db.prepare('INSERT INTO mb_owner_portal_sessions(token_hash,csrf_hash,expires_utc,last_seen_utc,created_utc) VALUES(?,?,?,?,?)')
            .run(sha256(token), sha256(csrfToken), expiresUtc, stamp, stamp);
        return this.findOwnerPortalSession(token);
    }

    findOwnerPortalSession(token) {
        if (!token) return null;
        const row = this.db.prepare('SELECT * FROM mb_owner_portal_sessions WHERE token_hash=?').get(sha256(token));
        if (!row || row.expires_utc <= now()) return null;
        this.db.prepare('UPDATE mb_owner_portal_sessions SET last_seen_utc=? WHERE id=?').run(now(), row.id);
        return row;
    }

    deleteOwnerPortalSession(token) {
        return this.db.prepare('DELETE FROM mb_owner_portal_sessions WHERE token_hash=?').run(sha256(token || '')).changes > 0;
    }

    replaceCreatorMemberCache(creatorId, members) {
        const stamp = now();
        const insert = this.db.prepare(`INSERT INTO mb_creator_member_cache(creator_source_id,youtube_channel_id,display_name,profile_image_url,highest_level_id,highest_level_name,member_since_utc,total_duration_months,fetched_utc)
            VALUES(?,?,?,?,?,?,?,?,?)`);
        this.db.exec('BEGIN IMMEDIATE');
        try {
            this.db.prepare('DELETE FROM mb_creator_member_cache WHERE creator_source_id=?').run(Number(creatorId));
            for (const member of members) insert.run(Number(creatorId), member.channelId, member.displayName || member.channelId, member.profileImageUrl || '', member.highestLevelId || '', member.highestLevelName || '', member.memberSinceUtc || null, Number(member.totalDurationMonths || 0), stamp);
            this.db.prepare('UPDATE mb_creator_sources SET member_cache_refreshed_utc=?,updated_utc=? WHERE id=?').run(stamp, stamp, Number(creatorId));
            this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
        return { count: members.length, fetchedUtc: stamp };
    }

    creatorMemberCache(creatorId, query = '', page = 1, pageSize = 100) {
        const normalizedQuery = String(query || '').trim().slice(0, 100);
        const safePageSize = Math.max(1, Math.min(250, Number(pageSize) || 100));
        const safePage = Math.max(1, Number(page) || 1);
        const where = normalizedQuery ? ' AND (display_name LIKE ? COLLATE NOCASE OR youtube_channel_id LIKE ? COLLATE NOCASE OR highest_level_name LIKE ? COLLATE NOCASE)' : '';
        const params = normalizedQuery ? [`%${normalizedQuery}%`, `%${normalizedQuery}%`, `%${normalizedQuery}%`] : [];
        const total = this.db.prepare(`SELECT COUNT(*) AS count FROM mb_creator_member_cache WHERE creator_source_id=?${where}`).get(Number(creatorId), ...params).count;
        const items = this.db.prepare(`SELECT * FROM mb_creator_member_cache WHERE creator_source_id=?${where} ORDER BY display_name COLLATE NOCASE LIMIT ? OFFSET ?`)
            .all(Number(creatorId), ...params, safePageSize, (safePage - 1) * safePageSize);
        const summary = this.db.prepare(`SELECT COUNT(cache.youtube_channel_id) AS total,creator.member_cache_refreshed_utc AS fetched_utc FROM mb_creator_sources creator LEFT JOIN mb_creator_member_cache cache ON cache.creator_source_id=creator.id WHERE creator.id=? GROUP BY creator.id`).get(Number(creatorId)) || {};
        return { items, total, page: safePage, pageSize: safePageSize, pages: Math.max(1, Math.ceil(total / safePageSize)), fetchedUtc: summary.fetched_utc || null, cachedTotal: summary.total || 0 };
    }

    simulatorSetMember(input) {
        this.db.prepare(`INSERT INTO mb_simulator_members(creator_source_id,youtube_channel_id,display_name,highest_level_id,accessible_levels_json,is_active) VALUES(?,?,?,?,?,?)
            ON CONFLICT(creator_source_id,youtube_channel_id) DO UPDATE SET display_name=excluded.display_name,highest_level_id=excluded.highest_level_id,accessible_levels_json=excluded.accessible_levels_json,is_active=excluded.is_active`)
            .run(Number(input.creatorId), input.youtubeChannelId, input.displayName || '', input.highestLevelId || null, JSON.stringify(input.accessibleLevelIds || []), input.active === false ? 0 : 1);
    }
    simulatorMembers(creatorId, ids) {
        if (!ids.length) return [];
        const rows = this.db.prepare(`SELECT * FROM mb_simulator_members WHERE creator_source_id=? AND youtube_channel_id IN (${ids.map(() => '?').join(',')}) AND is_active=1`).all(Number(creatorId), ...ids);
        return rows.map(row => ({ channelId: row.youtube_channel_id, displayName: row.display_name, highestLevelId: row.highest_level_id, highestLevelName: row.highest_level_id, accessibleLevelIds: asJson(row.accessible_levels_json) }));
    }
    simulatorSetFailure(creatorId, mode = '') {
        this.db.prepare(`INSERT INTO mb_simulator_state(creator_source_id,failure_mode) VALUES(?,?) ON CONFLICT(creator_source_id) DO UPDATE SET failure_mode=excluded.failure_mode`).run(Number(creatorId), mode);
    }
    simulatorFailure(creatorId) { return this.db.prepare('SELECT failure_mode FROM mb_simulator_state WHERE creator_source_id=?').get(Number(creatorId))?.failure_mode || ''; }

    dashboard(guildId) {
        const scalar = (sql, ...args) => Number(Object.values(this.db.prepare(sql).get(...args) || { value: 0 })[0] || 0);
        return {
            integrity: this.integrityCheck(),
            creators: scalar('SELECT COUNT(*) value FROM mb_creator_sources WHERE guild_id=?', guildId),
            operationalCreators: scalar("SELECT COUNT(*) value FROM mb_creator_sources WHERE guild_id=? AND connection_status='Operational' AND enabled=1", guildId),
            linkedMembers: scalar("SELECT COUNT(*) value FROM mb_account_links WHERE guild_id=? AND status='Active'", guildId),
            activeMemberships: scalar("SELECT COUNT(*) value FROM mb_membership_records WHERE guild_id=? AND status='Active'", guildId),
            graceMemberships: scalar("SELECT COUNT(*) value FROM mb_membership_records WHERE guild_id=? AND status='GracePeriod'", guildId),
            unmappedMemberships: scalar("SELECT COUNT(*) value FROM mb_membership_records WHERE guild_id=? AND status='UnmappedLevel'", guildId),
            safeModeCreators: scalar('SELECT COUNT(*) value FROM mb_creator_sources WHERE guild_id=? AND safe_mode=1', guildId),
            failedRoleOperations: scalar("SELECT COUNT(*) value FROM mb_role_operations WHERE guild_id=? AND status='Failed'", guildId),
        };
    }

    close() { this.db.close(); }
}

module.exports = { MemberBridgeStore, asJson, now };
