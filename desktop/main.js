const { app, BrowserWindow, ipcMain, safeStorage, shell, Tray, Menu } = require('electron');
const { fork } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const LOGIN_SALT = 'the-commission-v1';
const DISCORD_ID = /^\d{17,20}$/;
const SERVER_PROFILE_VERSION = 7;
const HEIST_SCHEDULE_VERSION = 1;
const ECONOMY_REWARD_VERSION = 1;
const DESTINATION_SERVER_PROFILE = {
    modChannelId: '1532504080067596381',
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
    modChannelId: '',
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
    altAccountAgeDays: 7,
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
    economyDiceJackpotPercent: 1,
    economyDiceMidPercent: 22,
    economyDiceRefundPercent: 15,
    economyDiceLossPercent: 62,
    economyDiceJackpotMultiplier: 100,
    economyDiceMidMultiplier: 3,
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
let mainWindow;
let dashboardWindow;
let tray;
let isQuitting = false;
let authenticated = false;
let authFailures = 0;
let authLockedUntil = 0;
let botProcess = null;
let botState = 'stopped';
let dashboardReady = false;
let dashboardUrl = '';
let recentLogs = [];
const pendingBotRequests = new Map();

if (process.env.COMMISSION_DATA_DIR) {
    app.setPath('userData', path.resolve(process.env.COMMISSION_DATA_DIR));
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
app.on('second-instance', () => showMainWindow());

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
    const decimalSettings = new Set([
        'economyDiceJackpotPercent', 'economyDiceMidPercent', 'economyDiceRefundPercent', 'economyDiceLossPercent',
        'economyDiceJackpotMultiplier', 'economyDiceMidMultiplier',
    ]);
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (typeof DEFAULT_SETTINGS[key] === 'boolean') {
            next[key] = Boolean(input[key]);
        } else if (typeof DEFAULT_SETTINGS[key] === 'number') {
            const parsed = decimalSettings.has(key) ? Number.parseFloat(input[key]) : Number.parseInt(input[key], 10);
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
    for (const key of ['economyDiceJackpotPercent', 'economyDiceMidPercent', 'economyDiceRefundPercent', 'economyDiceLossPercent']) {
        next[key] = Math.min(100, Math.max(0, next[key]));
    }
    next.economyDiceJackpotMultiplier = Math.min(10000, Math.max(0, next.economyDiceJackpotMultiplier));
    next.economyDiceMidMultiplier = Math.min(10000, Math.max(0, next.economyDiceMidMultiplier));
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
    const dicePercentTotal = next.economyDiceJackpotPercent + next.economyDiceMidPercent + next.economyDiceRefundPercent + next.economyDiceLossPercent;
    if (Math.abs(dicePercentTotal - 100) > 0.0001) throw new Error(`Dice outcome percentages must total exactly 100%. Current total: ${dicePercentTotal.toFixed(4).replace(/\.?0+$/, '')}%.`);
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

function sendToRenderer(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, payload);
    }
}

function appendLog(source, chunk) {
    for (const raw of String(chunk).split(/\r?\n/)) {
        const line = raw.trimEnd();
        if (!line) continue;
        const item = { at: new Date().toISOString(), source, line };
        recentLogs.push(item);
        if (recentLogs.length > 800) recentLogs.shift();
        sendToRenderer('bot:log', item);
        if (line.includes('Web dashboard running on port')) {
            dashboardReady = true;
            sendStatus();
        }
    }
}

function currentStatus() {
    return {
        state: botState,
        dashboardReady,
        dashboardUrl,
        pid: botProcess?.pid || null,
        logs: recentLogs.slice(-250),
    };
}

function sendStatus() {
    sendToRenderer('bot:status', currentStatus());
}

function isPortFree(port) {
    return new Promise(resolve => {
        const tester = net.createServer();
        tester.once('error', () => resolve(false));
        tester.once('listening', () => tester.close(() => resolve(true)));
        tester.listen(port, '127.0.0.1');
    });
}

async function availablePort(preferred) {
    if (await isPortFree(preferred)) return preferred;
    return new Promise((resolve, reject) => {
        const tester = net.createServer();
        tester.once('error', reject);
        tester.listen(0, '127.0.0.1', () => {
            const port = tester.address().port;
            tester.close(() => resolve(port));
        });
    });
}

async function startBot() {
    if (botProcess) return currentStatus();

    const config = loadConfig();
    const token = decryptSecret(config.secrets.discordToken);
    const dashboardPassword = decryptSecret(config.secrets.dashboardPassword);
    const memberBridgeEncryptionKey = ensureMemberBridgeEncryptionKey(config);
    if (!token) throw new Error('Add and save the Discord bot token first.');
    if (!dashboardPassword) throw new Error('Sign in once before starting the bot.');

    const idError = validateIds(config.settings);
    if (idError) throw new Error(idError);

    const port = await availablePort(config.settings.dashboardPort);
    dashboardUrl = `http://127.0.0.1:${port}/dashboard`;
    dashboardReady = false;
    botState = 'starting';
    recentLogs = [];
    sendStatus();

    const env = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DISCORD_TOKEN: token,
        WEB_DASHBOARD_PASSWORD: dashboardPassword,
        DATA_DIR: dataPath(),
        PORT: String(port),
        HOST: '127.0.0.1',
        MAIN_CHAT_CHANNEL_ID: config.settings.mainChatChannelId,
        ANNOUNCEMENT_CHANNEL_ID: config.settings.announcementChannelId,
        MOD_CHANNEL_ID: config.settings.modChannelId,
        LOG_CHANNEL_ID: config.settings.logChannelId,
        TICKET_CATEGORY_ID: config.settings.ticketCategoryId,
        OWNER_USER_ID: config.settings.ownerUserId,
        STAFF_ROLE_IDS: config.settings.staffRoleIds,
        PATROL_CHANNEL_ID: config.settings.patrolChannelId,
        MUSIC_CHANNEL_ID: config.settings.musicChannelId,
        MUSIC_VOICE_CHANNEL_ID: config.settings.musicVoiceChannelId,
        REPORT_CATEGORY_ID: config.settings.reportCategoryId,
        OLD_REPORTS_CHANNEL_ID: config.settings.oldReportsChannelId,
        JAIL_CATEGORY_IDS: config.settings.jailCategoryIds,
        JAIL_CATEGORY_ID: config.settings.jailCategoryId,
        JAIL_ROLE_ID: config.settings.jailRoleId,
        JAIL_LOG_CHANNEL_ID: config.settings.jailLogChannelId,
        PREEMPTIVE_BAN_USER_IDS: config.settings.preemptiveBanUserIds,
        PREEMPTIVE_BAN_REASON: config.settings.preemptiveBanReason,
        ALT_DETECTION_ENABLED: String(config.settings.altDetectionEnabled),
        ALT_ACCOUNT_AGE_DAYS: String(config.settings.altAccountAgeDays),
        ECONOMY_CONFIG_JSON: JSON.stringify({
            enabled: config.settings.economyEnabled,
            currencyName: config.settings.economyCurrencyName,
            auditChannelId: config.settings.economyAuditChannelId,
            archiveChannelId: config.settings.economyArchiveChannelId,
            leaderboardChannelId: config.settings.economyLeaderboardChannelId,
            heistChannelId: config.settings.economyHeistChannelId,
            gamblingChannelId: config.settings.economyGamblingChannelId,
            excludedChannelIds: config.settings.economyExcludedChannelIds,
            mediaChannelIds: config.settings.economyMediaChannelIds,
            excludedVoiceChannelIds: config.settings.economyExcludedVoiceChannelIds,
            excludedLeaderboardUserIds: config.settings.economyExcludedLeaderboardUserIds,
            messageChance: config.settings.economyMessageChance,
            messageRewardMin: config.settings.economyMessageRewardMin,
            messageRewardMax: config.settings.economyMessageRewardMax,
            messageCooldownSeconds: config.settings.economyMessageCooldownSeconds,
            messageDailyCap: config.settings.economyMessageDailyCap,
            messageHourlyLimit: config.settings.economyMessageHourlyLimit,
            mediaRewardMin: config.settings.economyMediaRewardMin,
            mediaRewardMax: config.settings.economyMediaRewardMax,
            mediaCooldownMinutes: config.settings.economyMediaCooldownMinutes,
            mediaDailyCap: config.settings.economyMediaDailyCap,
            mediaDailyPosts: config.settings.economyMediaDailyPosts,
            voiceRewardMin: config.settings.economyVoiceRewardMin,
            voiceRewardMax: config.settings.economyVoiceRewardMax,
            voiceIntervalMinutes: config.settings.economyVoiceIntervalMinutes,
            voiceDailyCap: config.settings.economyVoiceDailyCap,
            minimumAccountAgeDays: config.settings.economyMinimumAccountAgeDays,
            dailyBase: config.settings.economyDailyBase,
            dailyStreakStep: config.settings.economyDailyStreakStep,
            dailyStreakMaximum: config.settings.economyDailyStreakMaximum,
            gamblingEnabled: config.settings.economyGamblingEnabled,
            diceJackpotPercent: config.settings.economyDiceJackpotPercent,
            diceMidPercent: config.settings.economyDiceMidPercent,
            diceRefundPercent: config.settings.economyDiceRefundPercent,
            diceLossPercent: config.settings.economyDiceLossPercent,
            diceJackpotMultiplier: config.settings.economyDiceJackpotMultiplier,
            diceMidMultiplier: config.settings.economyDiceMidMultiplier,
            gamblingDailyWagerCap: config.settings.economyGamblingDailyWagerCap,
            gamblingMaxActionsPerMinute: config.settings.economyGamblingMaxActionsPerMinute,
            gamblingMaxActionsPerHour: config.settings.economyGamblingMaxActionsPerHour,
            blackjackMinimumWager: config.settings.economyBlackjackMinimumWager,
            blackjackMaximumWager: config.settings.economyBlackjackMaximumWager,
            blackjackDailyCap: config.settings.economyBlackjackDailyCap,
            pokerMinimumWager: config.settings.economyPokerMinimumWager,
            pokerMaximumWager: config.settings.economyPokerMaximumWager,
            pokerDailyCap: config.settings.economyPokerDailyCap,
            prizeMonths: config.settings.economyPrizeMonths,
            minimumTransfer: config.settings.economyMinimumTransfer,
            transferLimitPercent: config.settings.economyTransferLimitPercent,
            minimumMembershipDays: config.settings.economyMinimumMembershipDays,
            resetHour: config.settings.economyResetHour,
            timeZone: config.settings.economyTimeZone,
            pokerTimeoutBehavior: config.settings.economyPokerTimeoutBehavior,
            heistEntryFee: config.settings.economyHeistEntryFee,
            heistFreeSuccessReward: config.settings.economyHeistFreeSuccessReward,
            heistEntryMinutes: config.settings.economyHeistEntryMinutes,
            heistCooldownMinutes: config.settings.economyHeistCooldownMinutes,
            heistMinimumPlayers: config.settings.economyHeistMinimumPlayers,
            heistBaseSuccessChance: config.settings.economyHeistBaseSuccessChance,
            heistChancePerExtraPlayer: config.settings.economyHeistChancePerExtraPlayer,
            heistMaximumSuccessChance: config.settings.economyHeistMaximumSuccessChance,
            heistPayoutMultiplier: config.settings.economyHeistPayoutMultiplier,
        }),
        MEMBERBRIDGE_CONFIG_JSON: JSON.stringify({
            enabled: config.settings.memberBridgeEnabled,
            publicBaseUrl: config.settings.memberBridgePublicBaseUrl,
            callbackHost: config.settings.memberBridgeCallbackHost,
            callbackPort: config.settings.memberBridgeCallbackPort,
            productionMode: config.settings.memberBridgeProductionMode,
            simulationMode: config.settings.memberBridgeSimulationMode,
            googleClientId: config.settings.memberBridgeGoogleClientId,
            discordApplicationId: config.settings.memberBridgeDiscordApplicationId,
            administratorRoleIds: config.settings.memberBridgeAdministratorRoleIds,
            auditChannelId: config.settings.memberBridgeAuditChannelId,
            verifyCategoryId: config.settings.memberBridgeVerifyCategoryId,
            verifyChannelId: config.settings.memberBridgeVerifyChannelId,
            verifyChannelName: config.settings.memberBridgeVerifyChannelName,
            verificationIntervalMinutes: config.settings.memberBridgeVerificationIntervalMinutes,
            levelSyncHours: config.settings.memberBridgeLevelSyncHours,
            missingChecksBeforeGrace: config.settings.memberBridgeMissingChecksBeforeGrace,
            gracePeriodHours: config.settings.memberBridgeGracePeriodHours,
            massAbsencePercent: config.settings.memberBridgeMassAbsencePercent,
            memberDmsEnabled: config.settings.memberBridgeMemberDmsEnabled,
        }),
        MEMBERBRIDGE_ENCRYPTION_KEY: memberBridgeEncryptionKey,
        MEMBERBRIDGE_GOOGLE_CLIENT_SECRET: decryptSecret(config.secrets.memberBridgeGoogleClientSecret),
        MEMBERBRIDGE_DISCORD_CLIENT_SECRET: decryptSecret(config.secrets.memberBridgeDiscordClientSecret),
        LOCATIONIQ_API_KEY: decryptSecret(config.secrets.locationIqApiKey),
        POSITIONSTACK_API_KEY: decryptSecret(config.secrets.positionstackApiKey),
    };

    const worker = path.join(app.getAppPath(), 'discord_bot.js');
    botProcess = fork(worker, [], {
        cwd: dataPath(),
        execPath: process.execPath,
        env,
        silent: true,
        windowsHide: true,
    });

    botState = 'running';
    appendLog('system', `The Commission bot process started (PID ${botProcess.pid}).`);
    botProcess.stdout?.on('data', data => appendLog('bot', data));
    botProcess.stderr?.on('data', data => appendLog('error', data));
    botProcess.on('message', message => {
        if (message?.channel === 'commission:blueprint-progress') {
            appendLog('blueprint', message.message);
            return;
        }
        if (!['commission:blueprint-response', 'commission:economy-response', 'commission:memberbridge-response'].includes(message?.channel)) return;
        const pending = pendingBotRequests.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingBotRequests.delete(message.id);
        if (message.ok) pending.resolve(message.data);
        else pending.reject(new Error(message.error || 'Blueprint operation failed.'));
    });
    botProcess.on('error', error => appendLog('error', error.message));
    botProcess.on('exit', (code, signal) => {
        appendLog('system', `Bot process stopped (code ${code ?? 'n/a'}, signal ${signal || 'none'}).`);
        botProcess = null;
        botState = code === 0 || signal ? 'stopped' : 'error';
        dashboardReady = false;
        for (const pending of pendingBotRequests.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('The bot stopped during the requested operation.'));
        }
        pendingBotRequests.clear();
        sendStatus();
    });
    sendStatus();
    return currentStatus();
}

function stopBot() {
    if (!botProcess) return currentStatus();
    botState = 'stopping';
    sendStatus();
    botProcess.kill();
    return currentStatus();
}

function waitForBotExit(timeoutMs = 15_000) {
    if (!botProcess) return Promise.resolve();
    const processToWaitFor = botProcess;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The bot did not stop in time for the restore.')), timeoutMs);
        processToWaitFor.once('exit', () => { clearTimeout(timer); resolve(); });
    });
}

async function restoreMemberBridgeBackup(fileName) {
    if (!/^memberbridge-[\w.-]+\.db$/.test(String(fileName))) throw new Error('Invalid MemberBridge backup file.');
    const verification = await memberBridgeRequest('backup-verify', { fileName: String(fileName) });
    if (!verification.valid) throw new Error('The selected backup failed hash or SQLite integrity verification.');
    const backupDir = path.resolve(dataPath(), 'memberbridge-backups');
    const source = path.resolve(backupDir, String(fileName));
    if (path.dirname(source) !== backupDir || !fs.existsSync(source)) throw new Error('The selected backup is outside the MemberBridge backup directory or no longer exists.');
    const database = path.resolve(dataPath(), 'memberbridge.db');
    const wasRunning = Boolean(botProcess);
    const waiting = waitForBotExit();
    stopBot();
    await waiting;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const preRestore = path.resolve(backupDir, `memberbridge-pre-restore-${stamp}.db`);
    if (path.dirname(preRestore) !== backupDir) throw new Error('Pre-restore backup target is invalid.');
    if (fs.existsSync(database)) {
        fs.copyFileSync(database, preRestore);
        const sha256 = crypto.createHash('sha256').update(fs.readFileSync(preRestore)).digest('hex');
        fs.writeFileSync(`${preRestore}.json`, JSON.stringify({ fileName: path.basename(preRestore), createdUtc: new Date().toISOString(), sha256, application: 'The Commission MemberBridge pre-restore backup', schemaVersion: 1 }, null, 2));
    }
    const staged = `${database}.restore-${stamp}`;
    fs.copyFileSync(source, staged);
    if (fs.existsSync(database)) fs.renameSync(database, `${database}.rollback-${stamp}`);
    for (const suffix of ['-wal','-shm']) if (fs.existsSync(`${database}${suffix}`)) fs.renameSync(`${database}${suffix}`, `${database}${suffix}.rollback-${stamp}`);
    fs.renameSync(staged, database);
    if (wasRunning) await startBot();
    return { restored: String(fileName), preRestore: fs.existsSync(preRestore) ? path.basename(preRestore) : '' };
}

function botRequest(action, payload = {}, timeoutMs = 300_000) {
    if (!botProcess || !botProcess.connected) {
        return Promise.reject(new Error('Start the bot and wait for Discord to connect first.'));
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingBotRequests.delete(id);
            reject(new Error(`Blueprint ${action} timed out.`));
        }, timeoutMs);
        pendingBotRequests.set(id, { resolve, reject, timer });
        botProcess.send({ channel: 'commission:blueprint-request', id, action, payload });
    });
}

function economyRequest(action, payload = {}, timeoutMs = 30_000) {
    if (!botProcess || !botProcess.connected) {
        return Promise.reject(new Error('Start the bot and wait for Discord to connect first.'));
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingBotRequests.delete(id);
            reject(new Error(`Economy ${action} timed out.`));
        }, timeoutMs);
        pendingBotRequests.set(id, { resolve, reject, timer });
        botProcess.send({ channel: 'commission:economy-request', id, action, payload });
    });
}

function memberBridgeRequest(action, payload = {}, timeoutMs = 90_000) {
    if (!botProcess || !botProcess.connected) {
        return Promise.reject(new Error('Start the bot and wait for Discord to connect first.'));
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingBotRequests.delete(id);
            reject(new Error(`MemberBridge ${action} timed out.`));
        }, timeoutMs);
        pendingBotRequests.set(id, { resolve, reject, timer });
        botProcess.send({ channel: 'commission:memberbridge-request', id, action, payload });
    });
}

function showMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
    mainWindow.show();
    mainWindow.restore();
    mainWindow.focus();
}

function createTray() {
    if (tray) return;
    tray = new Tray(path.join(app.getAppPath(), 'assets', 'app-icon.ico'));
    tray.setToolTip('The Commission · Discord protection is running');
    const rebuildMenu = () => Menu.buildFromTemplate([
        { label: 'Open The Commission', click: showMainWindow },
        { type: 'separator' },
        { label: botProcess ? 'Bot: Running' : 'Bot: Stopped', enabled: false },
        { label: 'Start bot', enabled: !botProcess, click: () => startBot().catch(error => appendLog('error', error.message)) },
        { label: 'Stop bot', enabled: Boolean(botProcess), click: () => stopBot() },
        { type: 'separator' },
        { label: 'Exit', click: () => { isQuitting = true; app.quit(); } },
    ]);
    tray.on('click', showMainWindow);
    tray.on('right-click', () => tray.popUpContextMenu(rebuildMenu()));
}

function createMainWindow() {
    const startHidden = process.argv.includes('--hidden');
    mainWindow = new BrowserWindow({
        width: 1240,
        height: 820,
        minWidth: 980,
        minHeight: 680,
        backgroundColor: '#090a0c',
        title: 'The Commission',
        icon: path.join(app.getAppPath(), 'assets', 'commission-mark.png'),
        show: !startHidden,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile(path.join(__dirname, 'index.html'));
    mainWindow.on('close', event => {
        if (isQuitting) return;
        if (!loadConfig().settings.closeToTray) {
            isQuitting = true;
            app.quit();
            return;
        }
        event.preventDefault();
        mainWindow.hide();
    });
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

function configureLoginItem(enabled) {
    if (process.env.COMMISSION_DATA_DIR) return;
    app.setLoginItemSettings({
        openAtLogin: Boolean(enabled),
        args: enabled ? ['--hidden'] : [],
    });
}

function registerIpc() {
    ipcMain.handle('auth:bootstrap', () => {
        if (!authenticated) return { authenticated: false };
        return { authenticated: true, config: publicConfig(), status: currentStatus() };
    });

    ipcMain.handle('auth:login', (_event, payload) => {
        const password = typeof payload === 'object' ? payload.password : payload;
        const remember = typeof payload === 'object' ? Boolean(payload.remember) : false;
        const config = loadConfig();
        const now = Date.now();
        if (now < authLockedUntil) {
            const seconds = Math.ceil((authLockedUntil - now) / 1000);
            return { ok: false, error: `Too many attempts. Try again in ${seconds} seconds.` };
        }
        if (!configuredLoginHash(config)) {
            if (String(password || '').length < 12) {
                return { ok: false, error: 'For first-time setup, choose a password with at least 12 characters.' };
            }
            config.secrets.loginPasswordHash = encryptSecret(passwordHash(password));
        } else if (!passwordMatches(password, config)) {
            authFailures += 1;
            if (authFailures >= 5) {
                authFailures = 0;
                authLockedUntil = now + 30_000;
                return { ok: false, error: 'Too many attempts. The panel is locked for 30 seconds.' };
            }
            return { ok: false, error: 'The password is incorrect.' };
        }
        authFailures = 0;
        authLockedUntil = 0;
        authenticated = true;
        if (!decryptSecret(config.secrets.loginPasswordHash)) {
            config.secrets.loginPasswordHash = encryptSecret(passwordHash(password));
        }
        config.secrets.dashboardPassword = encryptSecret(String(password));
        config.settings.rememberLogin = remember;
        writeConfig(config);
        return { ok: true, config: publicConfig(), status: currentStatus() };
    });

    ipcMain.handle('auth:lock', () => {
        authenticated = false;
        return { ok: true };
    });

    ipcMain.handle('config:get', () => {
        if (!authenticated) throw new Error('The control panel is locked.');
        return publicConfig();
    });

    ipcMain.handle('config:save', (_event, payload = {}) => {
        if (!authenticated) throw new Error('The control panel is locked.');
        const config = loadConfig();
        const settings = sanitizeSettings(payload.settings);
        const idError = validateIds(settings);
        if (idError) throw new Error(idError);
        config.settings = settings;
        const suppliedSecrets = payload.secrets || {};
        for (const key of SECRET_KEYS.filter(key => key !== 'dashboardPassword')) {
            if (typeof suppliedSecrets[key] === 'string' && suppliedSecrets[key].trim()) {
                config.secrets[key] = encryptSecret(suppliedSecrets[key].trim());
            }
        }
        writeConfig(config);
        configureLoginItem(settings.launchAtLogin);
        return { ok: true, config: publicConfig() };
    });

    ipcMain.handle('bot:start', async () => {
        if (!authenticated) throw new Error('The control panel is locked.');
        return startBot();
    });

    ipcMain.handle('bot:stop', () => {
        if (!authenticated) throw new Error('The control panel is locked.');
        return stopBot();
    });

    ipcMain.handle('bot:status', () => currentStatus());

    ipcMain.handle('bot:open-dashboard', async () => {
        if (!authenticated) throw new Error('The control panel is locked.');
        if (!dashboardReady) throw new Error('The dashboard is not ready yet.');
        if (dashboardWindow && !dashboardWindow.isDestroyed()) {
            dashboardWindow.focus();
            return { ok: true };
        }
        dashboardWindow = new BrowserWindow({
            width: 1320,
            height: 860,
            minWidth: 900,
            minHeight: 650,
            backgroundColor: '#090a0c',
            title: 'The Commission Dashboard',
            icon: path.join(app.getAppPath(), 'assets', 'commission-mark.png'),
            webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
        });
        dashboardWindow.setMenuBarVisibility(false);
        await dashboardWindow.loadURL(dashboardUrl);
        dashboardWindow.on('closed', () => {
            dashboardWindow = null;
        });
        return { ok: true };
    });

    ipcMain.handle('system:open-data', async () => {
        if (!authenticated) throw new Error('The control panel is locked.');
        await shell.openPath(dataPath());
        return { ok: true };
    });

    ipcMain.handle('economy:stats', async () => {
        if (!authenticated) throw new Error('The control panel is locked.');
        return economyRequest('stats');
    });

    ipcMain.handle('economy:leaderboard', async (_event, type = 'balance') => {
        if (!authenticated) throw new Error('The control panel is locked.');
        return economyRequest('leaderboard', { type: String(type || 'balance') });
    });

    ipcMain.handle('economy:push-heist', async () => {
        if (!authenticated) throw new Error('The control panel is locked.');
        const config = loadConfig();
        if (!DISCORD_ID.test(config.settings.economyHeistChannelId)) {
            throw new Error('Enter and save a valid Persistent heist channel ID first.');
        }
        return economyRequest('push-heist-panel', { channelId: config.settings.economyHeistChannelId });
    });

    ipcMain.handle('economy:reset-preview', async (_event, payload = {}) => {
        if (!authenticated) throw new Error('The control panel is locked.');
        return economyRequest('reset-preview', {
            action: String(payload.action || ''),
            userId: String(payload.userId || '').trim(),
        });
    });

    ipcMain.handle('economy:reset-execute', async (_event, token = '') => {
        if (!authenticated) throw new Error('The control panel is locked.');
        if (!String(token).trim()) throw new Error('Preview the reset before confirming it.');
        return economyRequest('reset-execute', { token: String(token) });
    });

    ipcMain.handle('economy:bulk-grant-preview', async (_event, amount = 0) => {
        if (!authenticated) throw new Error('The control panel is locked.');
        const parsed = Number.parseInt(amount, 10);
        if (!Number.isFinite(parsed) || parsed < 1) throw new Error('Enter a positive Blood Money amount for each member.');
        return economyRequest('bulk-grant-preview', { amount: parsed }, 60_000);
    });

    ipcMain.handle('economy:bulk-grant-execute', async (_event, token = '') => {
        if (!authenticated) throw new Error('The control panel is locked.');
        if (!String(token).trim()) throw new Error('Preview the bulk grant before confirming it.');
        return economyRequest('bulk-grant-execute', { token: String(token) }, 60_000);
    });

    ipcMain.handle('memberbridge:request', async (_event, action, payload = {}) => {
        if (!authenticated) throw new Error('The control panel is locked.');
        const allowed = new Set(['dashboard','publish-verify-panel','creators','create-creator','update-creator','connect-creator','creator-portal-link','activate-simulator','levels','sync-levels','seed-level','map-level','verify','reconcile','set-safe-mode','create-override','remove-override','links','audit','guild-roles','simulator-link','simulator-member','simulator-failure','export-member','delete-member','backup-create','backup-list','backup-verify']);
        if (!allowed.has(String(action))) throw new Error('That MemberBridge administration action is not allowed.');
        const result = await memberBridgeRequest(String(action), payload || {});
        if (String(action) === 'connect-creator' && result?.url) await shell.openExternal(result.url);
        return result;
    });

    ipcMain.handle('memberbridge:restore-backup', async (_event, fileName) => {
        if (!authenticated) throw new Error('The control panel is locked.');
        return restoreMemberBridgeBackup(String(fileName || ''));
    });

    ipcMain.handle('blueprint:list-guilds', async () => {
        if (!authenticated) throw new Error('The control panel is locked.');
        return botRequest('list-guilds', {}, 30_000);
    });

    ipcMain.handle('blueprint:list', () => {
        if (!authenticated) throw new Error('The control panel is locked.');
        return listBlueprints();
    });

    ipcMain.handle('blueprint:capture', async (_event, guildId) => {
        if (!authenticated) throw new Error('The control panel is locked.');
        if (!DISCORD_ID.test(String(guildId || ''))) throw new Error('Select a valid source server.');
        const blueprint = await botRequest('capture', { guildId: String(guildId) });
        return { saved: saveBlueprint(blueprint), blueprints: listBlueprints() };
    });

    ipcMain.handle('blueprint:apply', async (_event, payload = {}) => {
        if (!authenticated) throw new Error('The control panel is locked.');
        if (!DISCORD_ID.test(String(payload.guildId || ''))) throw new Error('Select a valid destination server.');
        const blueprint = readBlueprint(payload.blueprintId);
        if (blueprint.sourceGuild.id === String(payload.guildId)) {
            throw new Error('The source and destination servers must be different.');
        }
        return botRequest('apply', {
            guildId: String(payload.guildId),
            blueprint,
            applyEveryonePermissions: Boolean(payload.applyEveryonePermissions),
        });
    });
}

app.whenReady().then(async () => {
    const config = loadConfig();
    const rememberedPassword = decryptSecret(config.secrets.dashboardPassword);
    authenticated = Boolean(config.settings.rememberLogin && rememberedPassword && passwordMatches(rememberedPassword, config));
    if (authenticated && !decryptSecret(config.secrets.loginPasswordHash)) {
        config.secrets.loginPasswordHash = encryptSecret(passwordHash(rememberedPassword));
        writeConfig(config);
    }
    registerIpc();
    createTray();
    createMainWindow();
    configureLoginItem(config.settings.launchAtLogin);
    if (config.settings.autoStartBot && decryptSecret(config.secrets.discordToken) && decryptSecret(config.secrets.dashboardPassword)) {
        startBot().catch(error => appendLog('error', `Auto-start failed: ${error.message}`));
    }
});

app.on('window-all-closed', () => {
    // The tray owns the background process; use its Exit action to quit completely.
});

app.on('before-quit', () => {
    isQuitting = true;
    if (botProcess) botProcess.kill();
});

app.on('activate', () => {
    showMainWindow();
});
