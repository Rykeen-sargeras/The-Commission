const { app, BrowserWindow, ipcMain, safeStorage, shell, Tray, Menu } = require('electron');
const { fork } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const {
    DISCORD_ID,
    SECRET_KEYS,
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
} = require('./storage');
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
