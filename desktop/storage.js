'use strict';

const { app, safeStorage } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LOGIN_SALT = 'the-commission-v1';
const DISCORD_ID = /^\d{17,20}$/;
const SERVER_PROFILE_VERSION = 8;
const HEIST_SCHEDULE_VERSION = 1;
const ECONOMY_REWARD_VERSION = 1;
const DESTINATION_SERVER_PROFILE = {
    modChannelId: '1532529016479682774',
    altAccountAgeDays: 14,
    ticketCategoryId: '1532513762618118308',
    reportCategoryId: '1532513762618118308',
    oldReportsChannelId: '1532513790673813655',
    jailCategoryIds: [
        '1532513762618118308',
        '1532513763918483497',
        '1532513765701189683',
        '1532513764660871180',
        '1532513767454281931',
    ].join(','),
    jailCategoryId: '1532513767114412262',
    jailLogChannelId: '1532513790673813655',
    launchAtLogin: true,
    autoStartBot: true,
    closeToTray: true,
    economyArchiveChannelId: '1532792745385529455',
    economyAuditChannelId: '1532792745385529455',
    economyLeaderboardChannelId: '1532786508459671734',
    economyHeistChannelId: '1532787416098672750',
    economyGamblingChannelId: '1532786549773832255',
    economyHeistEntryFee: 0,
    rememberLogin: true,
    memberBridgeEnabled: true,
    memberBridgeVerifyCategoryId: '1532513761573863577',
    memberBridgeVerifyChannelId: '1534990967923282080',
    memberBridgeVerifyChannelName: 'verify-membership',
};

const DEFAULT_SETTINGS = {
    mainChatChannelId: '',
    announcementChannelId: '',
    modChannelId: DESTINATION_SERVER_PROFILE.modChannelId,
    logChannelId: '',
    ticketCategoryId: '',
    ownerUserId: '1475473411642884227',
    staffRoleIds: '1475476293058301952,1475844551737475257',
    patrolChannelId: '1486376733413347358',
    musicChannelId: '1507520750503067648',
    musicVoiceChannelId: '1492298788935565552',
    reportCategoryId: DESTINATION_SERVER_PROFILE.reportCategoryId,
    oldReportsChannelId: DESTINATION_SERVER_PROFILE.oldReportsChannelId,
    jailCategoryIds: DESTINATION_SERVER_PROFILE.jailCategoryIds,
    jailCategoryId: DESTINATION_SERVER_PROFILE.jailCategoryId,
    jailRoleId: '1493335204419473438',
    jailLogChannelId: DESTINATION_SERVER_PROFILE.jailLogChannelId,
    preemptiveBanUserIds: '',
    preemptiveBanReason: 'Listed in The Commission preemptive ban list',
    altDetectionEnabled: true,
    altAccountAgeDays: 14,
    autoStartBot: false,
    launchAtLogin: false,
    closeToTray: true,
    rememberLogin: true,
    dashboardPort: 17841,
    economyEnabled: true,
    economyCurrencyName: 'Blood Money',
    economyAuditChannelId: '1532792745385529455',
    economyArchiveChannelId: '1532792745385529455',
    economyLeaderboardChannelId: '1532786508459671734',
    economyHeistChannelId: '1532787416098672750',
    economyGamblingChannelId: '1532786549773832255',
    economyExcludedChannelIds: '',
    economyMediaChannelIds: '',
    economyExcludedVoiceChannelIds: '',
    economyExcludedLeaderboardUserIds: '',
    economyMessageChance: 40,
    economyMessageRewardMin: 1,
    economyMessageRewardMax: 3,
    economyMessageCooldownSeconds: 60,
    economyMessageDailyCap: 50,
    economyMessageHourlyLimit: 10,
    economyMediaRewardMin: 3,
    economyMediaRewardMax: 8,
    economyMediaCooldownMinutes: 10,
    economyMediaDailyCap: 40,
    economyMediaDailyPosts: 5,
    economyVoiceRewardMin: 2,
    economyVoiceRewardMax: 5,
    economyVoiceIntervalMinutes: 10,
    economyVoiceDailyCap: 100,
    economyMinimumAccountAgeDays: 7,
    economyDailyBase: 100,
    economyDailyStreakStep: 100,
    economyDailyStreakMaximum: 700,
    economyGamblingEnabled: true,
    economyGamblingDailyWagerCap: 0,
    economyGamblingMaxActionsPerMinute: 0,
    economyGamblingMaxActionsPerHour: 0,
    economyBlackjackMinimumWager: 1,
    economyBlackjackMaximumWager: 100,
    economyBlackjackDailyCap: 500,
    economyPokerMinimumWager: 1,
    economyPokerMaximumWager: 250,
    economyPokerDailyCap: 1000,
    economyPrizeMonths: '',
    economyMinimumTransfer: 10,
    economyTransferLimitPercent: 10,
    economyMinimumMembershipDays: 7,
    economyResetHour: 0,
    economyTimeZone: 'America/New_York',
    economyPokerTimeoutBehavior: 'keep',
    economyHeistEntryFee: 0,
    economyHeistFreeSuccessReward: 100,
    economyHeistEntryMinutes: 58,
    economyHeistCooldownMinutes: 2,
    economyHeistMinimumPlayers: 2,
    economyHeistBaseSuccessChance: 45,
    economyHeistChancePerExtraPlayer: 5,
    economyHeistMaximumSuccessChance: 80,
    economyHeistPayoutMultiplier: 2,
    memberBridgeEnabled: true,
    memberBridgePublicBaseUrl: 'http://127.0.0.1:17842',
    memberBridgeCallbackHost: '127.0.0.1',
    memberBridgeCallbackPort: 17842,
    memberBridgeProductionMode: false,
    memberBridgeSimulationMode: true,
    memberBridgeGoogleClientId: '',
    memberBridgeDiscordApplicationId: '',
    memberBridgeAdministratorRoleIds: '',
    memberBridgeAuditChannelId: '',
    memberBridgeVerifyCategoryId: '1532513761573863577',
    memberBridgeVerifyChannelId: '1534990967923282080',
    memberBridgeVerifyChannelName: 'verify-membership',
    memberBridgeVerificationIntervalMinutes: 360,
    memberBridgeLevelSyncHours: 24,
    memberBridgeMissingChecksBeforeGrace: 2,
    memberBridgeGracePeriodHours: 168,
    memberBridgeMassAbsencePercent: 20,
    memberBridgeMemberDmsEnabled: true,
};

const SECRET_KEYS = ['discordToken', 'locationIqApiKey', 'positionstackApiKey', 'dashboardPassword', 'memberBridgeGoogleClientSecret', 'memberBridgeDiscordClientSecret', 'memberBridgeEncryptionKey'];

function configPath() {
    return path.join(app.getPath('userData'), 'commission-config.json');
}

function dataPath() {
    const target = path.join(app.getPath('userData'), 'bot-data');
    fs.mkdirSync(target, { recursive: true });
    return target;
}

function blueprintsPath() {
    const target = path.join(app.getPath('userData'), 'blueprints');
    fs.mkdirSync(target, { recursive: true });
    return target;
}

function blueprintSummary(fileName, blueprint) {
    return {
        id: fileName,
        sourceGuild: blueprint.sourceGuild,
        capturedAt: blueprint.capturedAt,
        roles: blueprint.roles?.length || 0,
        categories: blueprint.channels?.filter(channel => channel.type === 4).length || 0,
        channels: blueprint.channels?.filter(channel => channel.type !== 4).length || 0,
        skippedChannels: blueprint.skippedChannels || 0,
    };
}

function listBlueprints() {
    return fs.readdirSync(blueprintsPath(), { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .map(entry => {
            try {
                const blueprint = JSON.parse(fs.readFileSync(path.join(blueprintsPath(), entry.name), 'utf8'));
                return blueprintSummary(entry.name, blueprint);
            } catch {
                return null;
            }
        })
        .filter(Boolean)
        .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
}

function readBlueprint(fileName) {
    if (!fileName || path.basename(fileName) !== fileName || !fileName.endsWith('.json')) {
        throw new Error('Invalid blueprint file.');
    }
    return JSON.parse(fs.readFileSync(path.join(blueprintsPath(), fileName), 'utf8'));
}

function saveBlueprint(blueprint) {
    const stamp = blueprint.capturedAt.replace(/[:.]/g, '-');
    const fileName = `${blueprint.sourceGuild.id}-${stamp}.json`;
    fs.writeFileSync(path.join(blueprintsPath(), fileName), JSON.stringify(blueprint, null, 2), 'utf8');
    return blueprintSummary(fileName, blueprint);
}

function loadConfig() {
    try {
        const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
        const settings = { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) };
        if ((parsed.serverProfileVersion || 0) < SERVER_PROFILE_VERSION) {
            Object.assign(settings, DESTINATION_SERVER_PROFILE);
        }
        if ((parsed.heistScheduleVersion || 0) < HEIST_SCHEDULE_VERSION) {
            settings.economyHeistEntryMinutes = 58;
            settings.economyHeistCooldownMinutes = 2;
        }
        if ((parsed.economyRewardVersion || 0) < ECONOMY_REWARD_VERSION
            && Number(settings.economyDailyBase) === 25
            && Number(settings.economyDailyStreakStep) === 5
            && Number(settings.economyDailyStreakMaximum) === 75) {
            settings.economyDailyBase = 100;
            settings.economyDailyStreakStep = 100;
            settings.economyDailyStreakMaximum = 700;
        }
        return {
            serverProfileVersion: SERVER_PROFILE_VERSION,
            heistScheduleVersion: HEIST_SCHEDULE_VERSION,
            economyRewardVersion: ECONOMY_REWARD_VERSION,
            settings,
            secrets: parsed.secrets || {},
        };
    } catch {
        return {
            serverProfileVersion: SERVER_PROFILE_VERSION,
            heistScheduleVersion: HEIST_SCHEDULE_VERSION,
            economyRewardVersion: ECONOMY_REWARD_VERSION,
            settings: { ...DEFAULT_SETTINGS, ...DESTINATION_SERVER_PROFILE },
            secrets: {},
        };
    }
}

function writeConfig(config) {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    const temp = `${configPath()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(temp, configPath());
}

function encryptSecret(value) {
    if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('Windows credential encryption is not available on this computer.');
    }
    return safeStorage.encryptString(value).toString('base64');
}

function decryptSecret(value) {
    if (!value) return '';
    try {
        return safeStorage.decryptString(Buffer.from(value, 'base64'));
    } catch {
        return '';
    }
}

function ensureMemberBridgeEncryptionKey(config) {
    let key = decryptSecret(config.secrets.memberBridgeEncryptionKey);
    if (Buffer.from(key || '', 'base64').length === 32) return key;
    key = crypto.randomBytes(32).toString('base64');
    config.secrets.memberBridgeEncryptionKey = encryptSecret(key);
    writeConfig(config);
    return key;
}

function passwordHash(password) {
    return crypto.scryptSync(String(password || ''), LOGIN_SALT, 32).toString('hex');
}

function configuredLoginHash(config = loadConfig()) {
    const stored = decryptSecret(config.secrets.loginPasswordHash);
    if (/^[a-f0-9]{64}$/i.test(stored)) return stored;

    // Migrate existing installs without publishing the former application hash.
    const rememberedPassword = decryptSecret(config.secrets.dashboardPassword);
    if (rememberedPassword) return passwordHash(rememberedPassword);

    const environmentHash = String(process.env.COMMISSION_LOGIN_HASH || '').trim();
    return /^[a-f0-9]{64}$/i.test(environmentHash) ? environmentHash : '';
}

function passwordMatches(password, config = loadConfig()) {
    const configured = configuredLoginHash(config);
    if (!configured) return false;
    const calculated = Buffer.from(passwordHash(password), 'hex');
    const expected = Buffer.from(configured, 'hex');
    return calculated.length === expected.length && crypto.timingSafeEqual(calculated, expected);
}

function cleanCsvIds(value) {
    return [...new Set(String(value || '')
        .split(/[\s,]+/)
        .map(item => item.trim())
        .filter(Boolean))].join(',');
}

function sanitizeSettings(input = {}) {
    const next = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (typeof DEFAULT_SETTINGS[key] === 'boolean') {
            next[key] = Boolean(input[key]);
        } else if (typeof DEFAULT_SETTINGS[key] === 'number') {
            const parsed = Number.parseInt(input[key], 10);
            next[key] = Number.isFinite(parsed) ? parsed : DEFAULT_SETTINGS[key];
        } else {
            next[key] = String(input[key] || '').trim();
        }
    }
    next.staffRoleIds = cleanCsvIds(next.staffRoleIds);
    next.jailCategoryIds = cleanCsvIds(next.jailCategoryIds);
    next.preemptiveBanUserIds = cleanCsvIds(next.preemptiveBanUserIds);
    next.economyExcludedChannelIds = cleanCsvIds(next.economyExcludedChannelIds);
    next.economyMediaChannelIds = cleanCsvIds(next.economyMediaChannelIds);
    next.economyExcludedVoiceChannelIds = cleanCsvIds(next.economyExcludedVoiceChannelIds);
    next.economyExcludedLeaderboardUserIds = cleanCsvIds(next.economyExcludedLeaderboardUserIds);
    next.preemptiveBanReason = next.preemptiveBanReason.substring(0, 512);
    next.altAccountAgeDays = Math.min(365, Math.max(1, next.altAccountAgeDays));
    next.dashboardPort = Math.min(65535, Math.max(1024, next.dashboardPort));
    next.economyMessageChance = Math.min(100, Math.max(0, next.economyMessageChance));
    next.economyTransferLimitPercent = Math.min(100, Math.max(0, next.economyTransferLimitPercent));
    next.economyResetHour = Math.min(23, Math.max(0, next.economyResetHour));
    next.economyHeistBaseSuccessChance = Math.min(100, Math.max(0, next.economyHeistBaseSuccessChance));
    next.economyHeistChancePerExtraPlayer = Math.min(100, Math.max(0, next.economyHeistChancePerExtraPlayer));
    next.economyHeistMaximumSuccessChance = Math.min(100, Math.max(0, next.economyHeistMaximumSuccessChance));
    next.economyBlackjackMinimumWager = Math.max(1, next.economyBlackjackMinimumWager);
    next.economyBlackjackMaximumWager = Math.max(next.economyBlackjackMinimumWager, next.economyBlackjackMaximumWager);
    next.economyBlackjackDailyCap = Math.max(next.economyBlackjackMinimumWager, next.economyBlackjackDailyCap);
    next.economyPokerMinimumWager = Math.max(1, next.economyPokerMinimumWager);
    next.economyPokerMaximumWager = Math.max(next.economyPokerMinimumWager, next.economyPokerMaximumWager);
    next.economyPokerDailyCap = Math.max(next.economyPokerMinimumWager, next.economyPokerDailyCap);
    next.economyGamblingDailyWagerCap = Math.max(0, next.economyGamblingDailyWagerCap);
    next.economyGamblingMaxActionsPerMinute = Math.max(0, next.economyGamblingMaxActionsPerMinute);
    next.economyGamblingMaxActionsPerHour = Math.max(0, next.economyGamblingMaxActionsPerHour);
    next.memberBridgeCallbackPort = Math.min(65535, Math.max(1024, next.memberBridgeCallbackPort));
    next.memberBridgeVerificationIntervalMinutes = Math.min(10080, Math.max(15, next.memberBridgeVerificationIntervalMinutes));
    next.memberBridgeLevelSyncHours = Math.min(168, Math.max(1, next.memberBridgeLevelSyncHours));
    next.memberBridgeMissingChecksBeforeGrace = Math.min(10, Math.max(1, next.memberBridgeMissingChecksBeforeGrace));
    next.memberBridgeGracePeriodHours = Math.min(2160, Math.max(0, next.memberBridgeGracePeriodHours));
    next.memberBridgeMassAbsencePercent = Math.min(100, Math.max(1, next.memberBridgeMassAbsencePercent));
    next.memberBridgeAdministratorRoleIds = cleanCsvIds(next.memberBridgeAdministratorRoleIds);
    next.memberBridgeVerifyChannelName = next.memberBridgeVerifyChannelName.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').substring(0, 90) || 'verify-membership';
    if (next.memberBridgePublicBaseUrl) {
        let parsed;
        try { parsed = new URL(next.memberBridgePublicBaseUrl); } catch { throw new Error('MemberBridge public base URL must be a complete http:// or https:// URL.'); }
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('MemberBridge public base URL must use HTTP or HTTPS.');
        if (next.memberBridgeProductionMode && parsed.protocol !== 'https:') throw new Error('MemberBridge production mode requires an HTTPS public base URL.');
        next.memberBridgePublicBaseUrl = next.memberBridgePublicBaseUrl.replace(/\/$/, '');
    }
    if (next.memberBridgeProductionMode && next.memberBridgeSimulationMode) throw new Error('Turn off MemberBridge simulation mode before enabling production mode.');
    next.economyHeistEntryMinutes = 58;
    next.economyHeistCooldownMinutes = 2;
    return next;
}

function validateIds(settings) {
    const singleIds = [
        ['Main chat channel', settings.mainChatChannelId],
        ['Announcement channel', settings.announcementChannelId],
        ['Moderator channel', settings.modChannelId],
        ['Log channel', settings.logChannelId],
        ['Ticket category', settings.ticketCategoryId],
        ['Owner user', settings.ownerUserId],
        ['Patrol channel', settings.patrolChannelId],
        ['Music channel', settings.musicChannelId],
        ['Music voice channel', settings.musicVoiceChannelId],
        ['Report category', settings.reportCategoryId],
        ['Old reports channel', settings.oldReportsChannelId],
        ['Jail category', settings.jailCategoryId],
        ['Jail role', settings.jailRoleId],
        ['Jail log channel', settings.jailLogChannelId],
        ['Economy audit channel', settings.economyAuditChannelId],
        ['Economy archive channel', settings.economyArchiveChannelId],
        ['Economy leaderboard channel', settings.economyLeaderboardChannelId],
        ['Economy heist channel', settings.economyHeistChannelId],
        ['Economy gambling channel', settings.economyGamblingChannelId],
        ['MemberBridge audit channel', settings.memberBridgeAuditChannelId],
        ['MemberBridge verification category', settings.memberBridgeVerifyCategoryId],
        ['MemberBridge verification channel', settings.memberBridgeVerifyChannelId],
        ['MemberBridge Discord application', settings.memberBridgeDiscordApplicationId],
    ];
    const invalid = singleIds.find(([, value]) => value && !DISCORD_ID.test(value));
    if (invalid) return `${invalid[0]} must be a 17-20 digit Discord ID.`;
    for (const [label, value] of [
        ['Staff role IDs', settings.staffRoleIds],
        ['Jail category IDs', settings.jailCategoryIds],
        ['Preemptive ban user IDs', settings.preemptiveBanUserIds],
        ['Economy excluded channel IDs', settings.economyExcludedChannelIds],
        ['Economy media channel IDs', settings.economyMediaChannelIds],
        ['Economy excluded voice channel IDs', settings.economyExcludedVoiceChannelIds],
        ['Economy excluded leaderboard user IDs', settings.economyExcludedLeaderboardUserIds],
        ['MemberBridge administrator role IDs', settings.memberBridgeAdministratorRoleIds],
    ]) {
        if (value && value.split(',').some(id => !DISCORD_ID.test(id))) {
            return `${label} must contain comma-separated Discord IDs.`;
        }
    }
    return '';
}

function publicConfig() {
    const config = loadConfig();
    return {
        settings: config.settings,
        hasDiscordToken: Boolean(decryptSecret(config.secrets.discordToken)),
        hasLocationIqApiKey: Boolean(decryptSecret(config.secrets.locationIqApiKey)),
        hasPositionstackApiKey: Boolean(decryptSecret(config.secrets.positionstackApiKey)),
        hasMemberBridgeGoogleClientSecret: Boolean(decryptSecret(config.secrets.memberBridgeGoogleClientSecret)),
        hasMemberBridgeDiscordClientSecret: Boolean(decryptSecret(config.secrets.memberBridgeDiscordClientSecret)),
    };
}

module.exports = {
    DISCORD_ID,
    SECRET_KEYS,
    DEFAULT_SETTINGS,
    dataPath,
    listBlueprints,
    readBlueprint,
    saveBlueprint,
    loadConfig,
    writeConfig,
    encryptSecret,
    decryptSecret,
    ensureMemberBridgeEncryptionKey,
    passwordHash,
    passwordMatches,
    sanitizeSettings,
    validateIds,
    publicConfig,
};
