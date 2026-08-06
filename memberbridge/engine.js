'use strict';

const crypto = require('crypto');
const { MAX_MEMBER_BATCH, ROLE_MODE, STATUS } = require('./constants');
const { asJson, now } = require('./store');

function addHours(iso, hours) { return new Date(new Date(iso).getTime() + Number(hours) * 3600000).toISOString(); }
function addMinutes(iso, minutes) { return new Date(new Date(iso).getTime() + Number(minutes) * 60000).toISOString(); }
function batches(items, size = MAX_MEMBER_BATCH) {
    const output = [];
    for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
    return output;
}

class DiscordRoleAdapter {
    constructor(client, store) { this.client = client; this.store = store; }

    async validate(creator, roleIds) {
        const guild = await this.client.guilds.fetch(creator.guild_id);
        const me = guild.members.me || await guild.members.fetchMe();
        if (!me.permissions.has('ManageRoles')) throw new Error('The bot is missing Manage Roles.');
        for (const id of roleIds.filter(Boolean)) {
            const role = await guild.roles.fetch(id);
            if (!role) throw new Error(`Mapped Discord role ${id} does not exist.`);
            if (role.managed) throw new Error(`Discord role ${role.name} is managed by an integration.`);
            if (role.position >= me.roles.highest.position) throw new Error(`Move the bot role above ${role.name}.`);
        }
        return guild;
    }

    async operate({ creator, record, roleId, operation, correlationId, reason }) {
        const requestedUtc = now();
        let lastError;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
                const guild = await this.client.guilds.fetch(creator.guild_id);
                const member = await guild.members.fetch(record.discord_user_id);
                if (operation === 'add') await member.roles.add(roleId, reason);
                else await member.roles.remove(roleId, reason);
                this.store.addRoleOperation({ guildId: creator.guild_id, discordUserId: record.discord_user_id, roleId, creatorId: creator.id, recordId: record.id, operationType: operation, status: 'Succeeded', attemptCount: attempt, requestedUtc, completedUtc: now(), correlationId });
                return;
            } catch (error) {
                lastError = error;
                const permanent = [10011,10013,50001,50013,50028].includes(error.code) || /missing manage roles|does not exist|above/i.test(error.message);
                if (permanent || attempt === 3) break;
                await new Promise(resolve => setTimeout(resolve, 300 * (2 ** (attempt - 1))));
            }
        }
        this.store.addRoleOperation({ guildId: creator.guild_id, discordUserId: record.discord_user_id, roleId, creatorId: creator.id, recordId: record.id, operationType: operation, status: 'Failed', attemptCount: 3, requestedUtc, nextRetryUtc: addMinutes(now(), 15), error: lastError?.message, correlationId });
        throw lastError;
    }
}

class MembershipEngine {
    constructor({ store, youtube, simulatedYoutube, roleAdapter, simulationMode = false, auditChannel = null }) {
        this.store = store;
        this.youtube = youtube;
        this.simulatedYoutube = simulatedYoutube;
        this.roleAdapter = roleAdapter;
        this.simulationMode = simulationMode;
        this.auditChannel = auditChannel;
        this.creatorLocks = new Set();
    }

    clientFor() { return this.simulationMode ? this.simulatedYoutube : this.youtube; }

    async accessToken(creator) {
        if (this.simulationMode) return 'simulation';
        const refreshToken = this.store.getCreatorRefreshToken(creator.id);
        if (!refreshToken) throw new Error('Creator refresh token is missing. Reconnect the creator.');
        return (await this.youtube.refresh(refreshToken)).access_token;
    }

    async syncLevels(creatorId) {
        const creator = this.store.getCreator(creatorId);
        if (!creator) throw new Error('Creator source was not found.');
        const token = await this.accessToken(creator);
        const levels = await this.clientFor().membershipLevels(token, creator.id);
        const saved = this.store.saveLevels(creator.id, levels);
        this.store.audit('Membership levels imported', `Imported ${saved.length} level(s) for ${creator.display_name}.`, { guildId: creator.guild_id, creatorSourceId: creator.id });
        return saved;
    }

    requiredRoles(creator, reported) {
        const levels = this.store.listLevels(creator.id);
        const byId = new Map(levels.map(level => [level.youtube_level_id, level]));
        const required = [];
        if (creator.role_mode === ROLE_MODE.CUMULATIVE) {
            for (const id of reported.accessibleLevelIds) {
                const level = byId.get(id);
                if (level?.enabled && level.mapped_role_id) required.push(level.mapped_role_id);
            }
        } else {
            const level = byId.get(reported.highestLevelId);
            if (level?.enabled && level.mapped_role_id) required.push(level.mapped_role_id);
            if (creator.role_mode === ROLE_MODE.GENERAL_PLUS_HIGHEST && creator.general_role_id) required.push(creator.general_role_id);
        }
        return { required: [...new Set(required)], mapped: byId.get(reported.highestLevelId) };
    }

    async applyActive(creator, record, reported, correlationId) {
        const { required, mapped } = this.requiredRoles(creator, reported);
        const existing = asJson(record.managed_role_ids_json);
        if (!mapped || (!mapped.mapped_role_id && !creator.fallback_role_id)) {
            this.store.updateRecord(record.id, { previous_status: record.status, status: STATUS.UNMAPPED, last_attempt_utc: now(), last_successful_utc: now(), current_highest_level_id: reported.highestLevelId, current_level_name: reported.highestLevelName, accessible_level_ids_json: JSON.stringify(reported.accessibleLevelIds), last_error_code: 'unmapped_level', last_error_message: `No Discord role is mapped to ${reported.highestLevelId}.` });
            this.store.audit('Unmapped YouTube level found', `No Discord role is mapped to ${reported.highestLevelId}; existing roles were preserved.`, { severity: 'warning', guildId: creator.guild_id, creatorSourceId: creator.id, membershipRecordId: record.id, discordUserId: record.discord_user_id, correlationId });
            return;
        }
        if (record.current_highest_level_id && record.current_highest_level_id !== reported.highestLevelId) {
            const isDowngrade = !reported.accessibleLevelIds.includes(record.current_highest_level_id);
            if (isDowngrade && creator.downgrade_checks_required > 1) {
                const count = record.pending_downgrade_level_id === reported.highestLevelId ? Number(record.consecutive_downgrade_checks || 0) + 1 : 1;
                if (count < creator.downgrade_checks_required) {
                    this.store.updateRecord(record.id, { status: STATUS.ACTIVE, pending_downgrade_level_id: reported.highestLevelId, consecutive_downgrade_checks: count, last_attempt_utc: now(), last_successful_utc: now(), next_verification_utc: addMinutes(now(), creator.verification_interval_minutes), last_error_code: null, last_error_message: null });
                    this.store.audit('Membership downgrade pending confirmation', `${record.discord_user_id} reported at ${reported.highestLevelName || reported.highestLevelId}; confirmation ${count}/${creator.downgrade_checks_required}. Existing role was preserved.`, { severity: 'warning', guildId: creator.guild_id, creatorSourceId: creator.id, membershipRecordId: record.id, discordUserId: record.discord_user_id, correlationId });
                    return;
                }
            }
        }
        if (!required.length && creator.fallback_role_id) required.push(creator.fallback_role_id);
        await this.roleAdapter.validate(creator, required);
        const added = [];
        try {
            for (const roleId of required.filter(id => !existing.includes(id))) {
                await this.roleAdapter.operate({ creator, record, roleId, operation: 'add', correlationId, reason: `MemberBridge: verified ${creator.display_name} / ${reported.highestLevelName || reported.highestLevelId}` });
                added.push(roleId);
            }
        } catch (error) {
            this.store.updateRecord(record.id, { previous_status: record.status, status: STATUS.UNAVAILABLE, last_attempt_utc: now(), last_error_code: 'discord_role_add_failed', last_error_message: error.message });
            throw error;
        }
        if (!creator.safe_mode) {
            for (const roleId of existing.filter(id => !required.includes(id))) {
                await this.roleAdapter.operate({ creator, record, roleId, operation: 'remove', correlationId, reason: `MemberBridge: replaced obsolete ${creator.display_name} membership role` });
            }
        }
        const changedLevel = record.current_highest_level_id && record.current_highest_level_id !== reported.highestLevelId;
        this.store.updateRecord(record.id, {
            previous_status: record.status,
            status: STATUS.ACTIVE,
            previous_highest_level_id: changedLevel ? record.current_highest_level_id : record.previous_highest_level_id,
            current_highest_level_id: reported.highestLevelId,
            current_level_name: reported.highestLevelName,
            accessible_level_ids_json: JSON.stringify(reported.accessibleLevelIds),
            managed_role_ids_json: JSON.stringify(required),
            consecutive_missing_checks: 0,
            pending_downgrade_level_id: null,
            consecutive_downgrade_checks: 0,
            first_missing_utc: null,
            grace_started_utc: null,
            grace_expires_utc: null,
            last_attempt_utc: now(),
            last_successful_utc: now(),
            last_active_utc: now(),
            next_verification_utc: addMinutes(now(), creator.verification_interval_minutes),
            last_error_code: null,
            last_error_message: null,
        });
        const event = changedLevel ? 'Membership level changed' : 'Membership verified active';
        this.store.audit(event, `${record.discord_user_id} verified for ${creator.display_name} at ${reported.highestLevelName || reported.highestLevelId}.`, { severity: 'success', guildId: creator.guild_id, creatorSourceId: creator.id, membershipRecordId: record.id, discordUserId: record.discord_user_id, correlationId, data: { addedRoles: added, requiredRoles: required } });
    }

    async applyMissing(creator, record, correlationId) {
        const override = this.store.activeOverride(record.id);
        if (override && ['ForceMembershipActive','PreserveCurrentRole','SuppressRoleRemoval'].includes(override.override_type)) {
            this.store.updateRecord(record.id, { previous_status: record.status, status: STATUS.OVERRIDE, last_attempt_utc: now(), last_successful_utc: now(), next_verification_utc: addMinutes(now(), creator.verification_interval_minutes), last_error_code: null, last_error_message: null });
            this.store.audit('Manual override preserved role', `${record.discord_user_id} was absent, but ${override.override_type} preserved the current role.`, { guildId: creator.guild_id, creatorSourceId: creator.id, membershipRecordId: record.id, discordUserId: record.discord_user_id, correlationId });
            return;
        }
        const previousStatus = record.status === STATUS.UNAVAILABLE ? (record.previous_status || STATUS.UNVERIFIED) : record.status;
        const count = Number(record.consecutive_missing_checks || 0) + 1;
        const stamp = now();
        if (previousStatus === STATUS.GRACE) {
            if (record.grace_expires_utc && record.grace_expires_utc <= stamp) {
                if (creator.safe_mode) {
                    this.store.updateRecord(record.id, { status: STATUS.GRACE, consecutive_missing_checks: count, last_attempt_utc: stamp, last_successful_utc: stamp, next_verification_utc: addMinutes(stamp, creator.verification_interval_minutes), last_error_code: 'safe_mode', last_error_message: 'Final absence confirmed, but role removal is paused by safe mode.' });
                    return;
                }
                for (const roleId of asJson(record.managed_role_ids_json)) {
                    await this.roleAdapter.operate({ creator, record, roleId, operation: 'remove', correlationId, reason: `MemberBridge: ${creator.display_name} membership expired after confirmed grace period` });
                }
                this.store.updateRecord(record.id, { previous_status: previousStatus, status: STATUS.EXPIRED, managed_role_ids_json: '[]', consecutive_missing_checks: count, last_attempt_utc: stamp, last_successful_utc: stamp, next_verification_utc: addMinutes(stamp, creator.verification_interval_minutes), last_error_code: null, last_error_message: null });
                this.store.audit('Membership expired', `${record.discord_user_id} expired for ${creator.display_name} after final confirmed absence.`, { guildId: creator.guild_id, creatorSourceId: creator.id, membershipRecordId: record.id, discordUserId: record.discord_user_id, correlationId });
                return;
            }
            this.store.updateRecord(record.id, { status: STATUS.GRACE, consecutive_missing_checks: count, last_attempt_utc: stamp, last_successful_utc: stamp, next_verification_utc: addMinutes(stamp, creator.verification_interval_minutes), last_error_code: null, last_error_message: null });
            return;
        }
        if (count < creator.missing_checks_before_grace) {
            this.store.updateRecord(record.id, { previous_status: previousStatus, status: STATUS.PENDING_MISSING, consecutive_missing_checks: count, first_missing_utc: record.first_missing_utc || stamp, last_attempt_utc: stamp, last_successful_utc: stamp, next_verification_utc: addMinutes(stamp, creator.verification_interval_minutes), last_error_code: null, last_error_message: null });
            this.store.audit('Missing check recorded', `Successful missing check ${count}/${creator.missing_checks_before_grace} for ${record.discord_user_id}.`, { guildId: creator.guild_id, creatorSourceId: creator.id, membershipRecordId: record.id, discordUserId: record.discord_user_id, correlationId });
            return;
        }
        const deadline = addHours(stamp, creator.grace_period_hours);
        this.store.updateRecord(record.id, { previous_status: previousStatus, status: STATUS.GRACE, consecutive_missing_checks: count, first_missing_utc: record.first_missing_utc || stamp, grace_started_utc: stamp, grace_expires_utc: deadline, last_attempt_utc: stamp, last_successful_utc: stamp, next_verification_utc: addMinutes(stamp, creator.verification_interval_minutes), last_error_code: null, last_error_message: null });
        this.store.audit('Grace period started', `${record.discord_user_id} entered grace for ${creator.display_name} until ${deadline}.`, { severity: 'warning', guildId: creator.guild_id, creatorSourceId: creator.id, membershipRecordId: record.id, discordUserId: record.discord_user_id, correlationId });
    }

    markUnavailable(creator, records, error, correlationId) {
        for (const record of records) {
            this.store.updateRecord(record.id, { previous_status: record.status === STATUS.UNAVAILABLE ? record.previous_status : record.status, status: STATUS.UNAVAILABLE, last_attempt_utc: now(), next_verification_utc: addMinutes(now(), Math.min(60, creator.verification_interval_minutes)), last_error_code: error.code || 'verification_error', last_error_message: error.message });
            this.store.addVerification({ recordId: record.id, creatorId: creator.id, result: 'Unavailable', errorCode: error.code || 'verification_error', errorSummary: error.message, httpStatus: error.httpStatus, correlationId });
        }
        this.store.markCreatorError(creator.id, error.code || 'verification_error', error.message);
        this.store.audit('Verification unavailable', `${creator.display_name}: ${error.message}. Existing roles were preserved.`, { severity: 'error', guildId: creator.guild_id, creatorSourceId: creator.id, correlationId });
    }

    async verifyCreator(creatorId, onlyDiscordUserId = '') {
        creatorId = Number(creatorId);
        if (this.creatorLocks.has(creatorId)) throw new Error('A synchronization is already running for this creator.');
        this.creatorLocks.add(creatorId);
        const correlationId = crypto.randomUUID();
        try {
            let creator = this.store.getCreator(creatorId);
            if (!creator || !creator.enabled) throw new Error('Creator source is disabled or missing.');
            let records = this.store.creatorRecords(creatorId);
            if (onlyDiscordUserId) records = records.filter(record => record.discord_user_id === onlyDiscordUserId);
            records = records.filter(record => this.store.activeOverride(record.id)?.override_type !== 'DisableAutomaticVerification');
            if (!records.length) return { checked: 0, active: 0, missing: 0, safeMode: Boolean(creator.safe_mode) };
            const token = await this.accessToken(creator);
            const returned = new Map();
            const successfulRecordIds = new Set();
            for (const group of batches(records, MAX_MEMBER_BATCH)) {
                const ids = group.map(record => record.youtube_channel_id);
                let members;
                try { members = await this.clientFor().members(token, ids, creator.id); }
                catch (error) { this.markUnavailable(creator, group, error, correlationId); continue; }
                group.forEach(record => successfulRecordIds.add(record.id));
                for (const member of members) {
                    if (!member.channelId) {
                        this.store.audit('Unmatched membership resource', 'YouTube returned a member without a channel ID; no role was changed.', { severity: 'warning', guildId: creator.guild_id, creatorSourceId: creator.id, correlationId });
                        continue;
                    }
                    if (!ids.includes(member.channelId)) {
                        this.store.audit('Unmatched membership resource', `YouTube returned unexpected member channel ${member.channelId}; no role was changed.`, { severity: 'warning', guildId: creator.guild_id, creatorSourceId: creator.id, correlationId });
                        continue;
                    }
                    returned.set(member.channelId, member);
                }
            }
            const successfullyChecked = records.filter(record => successfulRecordIds.has(record.id));
            const missing = successfullyChecked.filter(record => !returned.has(record.youtube_channel_id));
            const activeBefore = successfullyChecked.filter(record => [STATUS.ACTIVE,STATUS.PENDING_MISSING,STATUS.GRACE].includes(record.status)).length;
            const absencePercent = activeBefore ? (missing.filter(record => [STATUS.ACTIVE,STATUS.PENDING_MISSING,STATUS.GRACE].includes(record.status)).length / activeBefore) * 100 : 0;
            if (activeBefore >= 5 && absencePercent > creator.mass_absence_percent) {
                creator = this.store.updateCreator(creator.id, { safe_mode: 1, safe_mode_reason: `${absencePercent.toFixed(1)}% of active members appeared absent in one synchronization.` });
                this.store.audit('Safe mode enabled', creator.safe_mode_reason, { severity: 'critical', guildId: creator.guild_id, creatorSourceId: creator.id, correlationId });
            }
            let activeCount = 0;
            for (const record of successfullyChecked) {
                const member = returned.get(record.youtube_channel_id);
                try {
                    const override = this.store.activeOverride(record.id);
                    const forced = override?.override_type === 'ForceSpecificMembershipLevel' && override.forced_level_id
                        ? { channelId: record.youtube_channel_id, displayName: record.youtube_display_name, highestLevelId: override.forced_level_id, highestLevelName: override.forced_level_id, accessibleLevelIds: [override.forced_level_id] }
                        : member;
                    if (forced) { await this.applyActive(creator, record, forced, correlationId); activeCount += 1; }
                    else await this.applyMissing(creator, record, correlationId);
                    this.store.addVerification({ recordId: record.id, creatorId: creator.id, result: forced ? (override ? 'ManualOverride' : 'Active') : 'Missing', returnedMember: Boolean(member), levelId: forced?.highestLevelId, correlationId });
                } catch (error) {
                    this.store.audit('Role operation failed', `${record.discord_user_id}: ${error.message}. Existing roles were preserved where possible.`, { severity: 'error', guildId: creator.guild_id, creatorSourceId: creator.id, membershipRecordId: record.id, discordUserId: record.discord_user_id, correlationId });
                }
            }
            this.store.db.prepare(`UPDATE mb_creator_sources SET connection_status='Operational',last_successful_check_utc=?,last_attempt_utc=?,last_error_code=NULL,last_error_message=NULL,updated_utc=? WHERE id=?`).run(now(),now(),now(),creator.id);
            return { checked: successfullyChecked.length, active: activeCount, missing: missing.length, safeMode: Boolean(creator.safe_mode), correlationId };
        } finally { this.creatorLocks.delete(creatorId); }
    }

    async reconcileCreator(creatorId) {
        const creator = this.store.getCreator(creatorId);
        if (!creator) throw new Error('Creator source not found.');
        let restored = 0;
        for (const record of this.store.creatorRecords(creatorId).filter(row => row.status === STATUS.ACTIVE)) {
            const guild = await this.roleAdapter.validate(creator, asJson(record.managed_role_ids_json));
            const member = await guild.members.fetch(record.discord_user_id);
            for (const roleId of asJson(record.managed_role_ids_json).filter(id => !member.roles.cache.has(id))) {
                await this.roleAdapter.operate({ creator, record, roleId, operation: 'add', correlationId: crypto.randomUUID(), reason: `MemberBridge: daily reconciliation for ${creator.display_name}` });
                restored += 1;
            }
        }
        return { restored };
    }
}

module.exports = { DiscordRoleAdapter, MembershipEngine, addHours, addMinutes, batches };
