const loginView = document.getElementById('loginView');
const appView = document.getElementById('appView');
const loginForm = document.getElementById('loginForm');
const loginPassword = document.getElementById('loginPassword');
const rememberLogin = document.getElementById('rememberLogin');
const loginError = document.getElementById('loginError');
const settingsForm = document.getElementById('settingsForm');
const toast = document.getElementById('toast');
const logConsole = document.getElementById('logConsole');

let currentStatus = { state: 'stopped', dashboardReady: false, logs: [] };
let toastTimer;
let savedBlueprints = [];
let availableGuilds = [];
let pendingEconomyResetToken = '';
let pendingBulkGrantToken = '';
let memberBridgeCreators = [];
let memberBridgeRoles = [];
let memberBridgeLevels = [];

function showToast(message, isError = false) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.className = `toast show${isError ? ' error' : ''}`;
    toastTimer = setTimeout(() => {
        toast.className = 'toast';
    }, 3500);
}

function friendlyError(error) {
    return error?.message?.replace(/^Error invoking remote method '[^']+': /, '') || String(error);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function showApp() {
    loginView.classList.add('hidden');
    appView.classList.remove('hidden');
}

function showLogin() {
    appView.classList.add('hidden');
    loginView.classList.remove('hidden');
    loginPassword.value = '';
    loginPassword.focus();
}

function applyConfig(config) {
    const settings = config.settings || {};
    document.querySelectorAll('[data-setting]').forEach(input => {
        const value = settings[input.dataset.setting];
        if (input.type === 'checkbox') input.checked = Boolean(value);
        else input.value = value ?? '';
    });
    document.getElementById('tokenState').textContent = config.hasDiscordToken ? 'Saved & encrypted' : 'Not saved';
    document.getElementById('locationIqState').textContent = config.hasLocationIqApiKey ? 'Saved & encrypted' : 'Not saved';
    document.getElementById('positionstackState').textContent = config.hasPositionstackApiKey ? 'Saved & encrypted' : 'Not saved';
    document.getElementById('mbGoogleSecretState').textContent = config.hasMemberBridgeGoogleClientSecret ? 'Saved & encrypted' : 'Not saved';
    document.getElementById('mbDiscordSecretState').textContent = config.hasMemberBridgeDiscordClientSecret ? 'Saved & encrypted' : 'Not saved';
    document.getElementById('metricConfig').textContent = config.hasDiscordToken ? 'Token saved' : 'Token needed';
    document.getElementById('memberBridgeSimulationWarning').classList.toggle('hidden', !settings.memberBridgeSimulationMode);
    updateMemberBridgeRedirects();
}

function updateMemberBridgeRedirects() {
    const base = String(document.querySelector('[data-setting="memberBridgePublicBaseUrl"]')?.value || '').replace(/\/$/, '') || 'https://members.example.com';
    document.getElementById('mbDiscordRedirect').textContent = `${base}/oauth/discord/callback`;
    document.getElementById('mbCreatorRedirect').textContent = `${base}/oauth/google/creator-callback`;
}

function collectPayload() {
    const settings = {};
    const secrets = {};
    document.querySelectorAll('[data-setting]').forEach(input => {
        settings[input.dataset.setting] = input.type === 'checkbox' ? input.checked : input.value;
    });
    document.querySelectorAll('[data-secret]').forEach(input => {
        if (input.value.trim()) secrets[input.dataset.secret] = input.value.trim();
    });
    return { settings, secrets };
}

function clearSecretInputs() {
    document.querySelectorAll('[data-secret]').forEach(input => {
        input.value = '';
    });
}

function statusLabel(state) {
    return ({
        stopped: 'Bot stopped',
        starting: 'Bot starting',
        running: 'Bot online',
        stopping: 'Bot stopping',
        error: 'Bot error',
    })[state] || state;
}

function renderStatus(status) {
    currentStatus = status;
    const dot = document.getElementById('sidebarStatusDot');
    dot.className = status.state;
    document.getElementById('sidebarStatus').textContent = statusLabel(status.state);
    document.getElementById('metricState').textContent = status.state.charAt(0).toUpperCase() + status.state.slice(1);
    document.getElementById('metricPid').textContent = status.pid ? `Windows PID ${status.pid}` : 'No active PID';
    document.getElementById('metricDashboard').textContent = status.dashboardReady ? 'Ready' : 'Offline';

    const busy = status.state === 'starting' || status.state === 'stopping';
    document.getElementById('startButton').disabled = status.state === 'running' || busy;
    document.getElementById('stopButton').disabled = status.state === 'stopped' || status.state === 'error' || busy;
    document.getElementById('dashboardButton').disabled = !status.dashboardReady;
}

function appendLog(item) {
    const empty = logConsole.querySelector('.log-empty');
    if (empty) empty.remove();
    const row = document.createElement('div');
    row.className = `log-line ${item.source}`;
    const time = document.createElement('time');
    time.textContent = new Date(item.at).toLocaleTimeString([], { hour12: false });
    const source = document.createElement('b');
    source.textContent = item.source;
    const line = document.createElement('span');
    line.textContent = item.line;
    row.append(time, source, line);
    logConsole.appendChild(row);
    while (logConsole.childElementCount > 500) logConsole.firstElementChild.remove();
    logConsole.scrollTop = logConsole.scrollHeight;
}

function replaceLogs(logs = []) {
    logConsole.innerHTML = '';
    if (!logs.length) {
        logConsole.innerHTML = '<div class="log-empty">Start the bot to see live output.</div>';
        return;
    }
    logs.forEach(appendLog);
}

function openPage(name) {
    document.querySelectorAll('.nav-item').forEach(button => {
        button.classList.toggle('active', button.dataset.pageTarget === name);
    });
    document.querySelectorAll('.page').forEach(page => {
        page.classList.toggle('active', page.dataset.page === name);
    });
    const page = document.querySelector(`[data-page="${name}"]`);
    document.getElementById('pageTitle').textContent = page.dataset.title;
    document.getElementById('pageEyebrow').textContent = page.dataset.eyebrow;
}

function fillGuildSelect(select, placeholder) {
    const previous = select.value;
    select.innerHTML = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = placeholder;
    select.appendChild(blank);
    for (const guild of availableGuilds) {
        const option = document.createElement('option');
        option.value = guild.id;
        option.textContent = `${guild.name} — ${guild.id}`;
        select.appendChild(option);
    }
    if (availableGuilds.some(guild => guild.id === previous)) select.value = previous;
}

function renderGuilds(guilds) {
    availableGuilds = guilds || [];
    fillGuildSelect(document.getElementById('sourceGuildSelect'), 'Select source server');
    fillGuildSelect(document.getElementById('destinationGuildSelect'), 'Select destination server');
}

function selectedBlueprint() {
    const id = document.getElementById('blueprintSelect').value;
    return savedBlueprints.find(blueprint => blueprint.id === id);
}

function renderBlueprintSummary(blueprint, result = null) {
    const container = document.getElementById('blueprintSummary');
    if (!blueprint) {
        container.innerHTML = '<p class="muted">No blueprint selected.</p>';
        return;
    }
    const resultMarkup = result ? `
        <div class="callout ${result.errors?.length ? 'warning' : ''}">
            <strong>Apply result</strong>
            <p>${result.rolesCreated} roles, ${result.categoriesCreated} categories, and ${result.channelsCreated} channels created.
            ${result.skippedMemberOverwrites} member-specific overrides skipped.
            ${result.errors?.length || 0} errors.</p>
            ${result.errors?.length ? `<p>${result.errors.map(escapeHtml).join('<br>')}</p>` : ''}
        </div>` : '';
    container.innerHTML = `
        <div class="panel-heading">
            <div>
                <p class="eyebrow">Saved locally</p>
                <h3>${escapeHtml(blueprint.sourceGuild.name)}</h3>
                <p class="muted">${new Date(blueprint.capturedAt).toLocaleString()}</p>
            </div>
        </div>
        <div class="blueprint-stats">
            <div class="blueprint-stat"><span>Roles</span><strong>${blueprint.roles}</strong></div>
            <div class="blueprint-stat"><span>Categories</span><strong>${blueprint.categories}</strong></div>
            <div class="blueprint-stat"><span>Channels</span><strong>${blueprint.channels}</strong></div>
            <div class="blueprint-stat"><span>Skipped types</span><strong>${blueprint.skippedChannels}</strong></div>
        </div>
        ${resultMarkup}`;
}

function renderBlueprints(blueprints) {
    savedBlueprints = blueprints || [];
    const select = document.getElementById('blueprintSelect');
    const previous = select.value;
    select.innerHTML = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = savedBlueprints.length ? 'Select a saved blueprint' : 'No saved blueprints';
    select.appendChild(blank);
    for (const blueprint of savedBlueprints) {
        const option = document.createElement('option');
        option.value = blueprint.id;
        option.textContent = `${blueprint.sourceGuild.name} — ${new Date(blueprint.capturedAt).toLocaleString()}`;
        select.appendChild(option);
    }
    if (savedBlueprints.some(blueprint => blueprint.id === previous)) select.value = previous;
    else if (savedBlueprints.length) select.value = savedBlueprints[0].id;
    renderBlueprintSummary(selectedBlueprint());
}

async function loadBlueprints() {
    try {
        renderBlueprints(await window.commission.listBlueprints());
    } catch (error) {
        showToast(friendlyError(error), true);
    }
}

function enterControlRoom(result) {
    applyConfig(result.config);
    renderStatus(result.status);
    replaceLogs(result.status.logs);
    showApp();
    loadBlueprints();
}

async function refreshEconomy() {
    const button = document.getElementById('refreshEconomyButton');
    button.disabled = true;
    button.textContent = 'Refreshing…';
    try {
        const leaderboardType = document.getElementById('economyLeaderboardType').value;
        const [stats, leaders] = await Promise.all([
            window.commission.getEconomyStats(),
            window.commission.getEconomyLeaderboard(leaderboardType),
        ]);
        document.getElementById('economyMembers').textContent = Number(stats.members || 0).toLocaleString();
        document.getElementById('economyCirculation').textContent = Number(stats.circulation || 0).toLocaleString();
        document.getElementById('economyTransactions').textContent = Number(stats.transactions || 0).toLocaleString();
        const container = document.getElementById('economyLeaderboard');
        container.innerHTML = leaders.length ? leaders.map((row, index) => `
            <div class="economy-row">
                <span><b>${index + 1}</b> User ${escapeHtml(row.user_id)}</span>
                <strong>${leaderboardType === 'rep'
                    ? `${Number(row.points || 0).toLocaleString()} REP`
                    : `${Number(row.balance || 0).toLocaleString()} · ${escapeHtml(row.rank)}`}</strong>
            </div>`).join('') : '<p class="muted">No economy activity yet.</p>';
        showToast('Economy statistics refreshed.');
    } catch (error) {
        showToast(friendlyError(error), true);
    } finally {
        button.disabled = false;
        button.textContent = 'Refresh statistics';
    }
}

function selectedMemberBridgeCreator() {
    return memberBridgeCreators.find(creator => String(creator.id) === document.getElementById('mbCreatorSelect').value);
}

function renderMemberBridgeCreatorSelect() {
    const select = document.getElementById('mbCreatorSelect');
    const previous = select.value;
    select.innerHTML = '<option value="">Select a creator</option>';
    for (const creator of memberBridgeCreators) {
        const option = document.createElement('option');
        option.value = creator.id;
        option.textContent = `${creator.display_name} · ${creator.connection_status}`;
        select.appendChild(option);
    }
    if (memberBridgeCreators.some(creator => String(creator.id) === previous)) select.value = previous;
    else if (memberBridgeCreators.length) select.value = String(memberBridgeCreators[0].id);
    applyMemberBridgeCreator();
}

function applyMemberBridgeCreator() {
    const creator = selectedMemberBridgeCreator();
    document.getElementById('mbCreatorStatus').textContent = creator ? `${creator.connection_status}${creator.safe_mode ? ' · safe mode' : ''}` : 'None selected';
    document.getElementById('mbRoleMode').value = creator?.role_mode || 'highest';
    document.getElementById('mbGeneralRoleId').value = creator?.general_role_id || '';
    document.getElementById('mbCreatorMissingChecks').value = creator?.missing_checks_before_grace ?? 2;
    document.getElementById('mbCreatorGraceHours').value = creator?.grace_period_hours ?? 168;
    document.getElementById('mbCreatorMassAbsence').value = creator?.mass_absence_percent ?? 20;
    document.getElementById('mbSafeModeButton').textContent = creator?.safe_mode ? 'Disable safe mode' : 'Enable safe mode';
    document.querySelectorAll('#mbSaveCreatorButton,#mbConnectCreatorButton,#mbCreatorPortalButton,#mbActivateSimulatorButton,#mbSyncLevelsButton,#mbVerifyButton,#mbSafeModeButton').forEach(button => { button.disabled = !creator; });
    document.getElementById('mbCreatorPortalUrl').value = '';
}

function renderMemberBridgeMappings() {
    const container = document.getElementById('mbMappings');
    const roleOptions = ['<option value="">No role mapped</option>', ...memberBridgeRoles.map(role => `<option value="${escapeHtml(role.id)}"${role.editable ? '' : ' disabled'}>${escapeHtml(role.name)} · ${escapeHtml(role.id)}${role.editable ? '' : ' · not editable'}</option>`)].join('');
    container.innerHTML = memberBridgeLevels.length ? memberBridgeLevels.map(level => `
        <div class="mapping-row" data-level-id="${escapeHtml(level.youtube_level_id)}">
            <label class="field"><span>${escapeHtml(level.display_name)}</span><small>${escapeHtml(level.youtube_level_id)}${level.currently_reported ? '' : ' · no longer reported'}</small></label>
            <label class="field"><span>Discord role</span><select class="mb-role-map">${roleOptions}</select></label>
            <button class="button secondary mb-map-button" type="button">Save mapping</button>
        </div>`).join('') : '<p class="muted">No membership levels imported for this creator.</p>';
    container.querySelectorAll('.mapping-row').forEach((row, index) => { row.querySelector('select').value = memberBridgeLevels[index].mapped_role_id || ''; });
    const simSelect = document.getElementById('mbSimLevel');
    simSelect.innerHTML = '<option value="">Not active</option>' + memberBridgeLevels.map(level => `<option value="${escapeHtml(level.youtube_level_id)}">${escapeHtml(level.display_name)} · ${escapeHtml(level.youtube_level_id)}</option>`).join('');
}

function renderMemberBridgeMembers(links) {
    const container = document.getElementById('mbMembers');
    container.innerHTML = links.length ? links.map(link => `
        <div class="mb-member-card">
            <b>${escapeHtml(link.discord_username || link.discord_user_id)}</b>
            <small>Discord ${escapeHtml(link.discord_user_id)} ↔ YouTube ${escapeHtml(link.youtube_display_name || link.youtube_channel_id)} (${escapeHtml(link.youtube_channel_id)})</small>
            ${(link.records || []).map(record => `<small>${escapeHtml(record.creator_name)}: <b>${escapeHtml(record.status)}</b>${record.current_level_name ? ` · ${escapeHtml(record.current_level_name)}` : ''}${record.grace_expires_utc ? ` · grace until ${new Date(record.grace_expires_utc).toLocaleString()}` : ''}</small>${record.id ? `<div class="button-row"><button class="button ghost mb-preserve-button" data-record-id="${record.id}" type="button">Preserve role 7 days</button><button class="button ghost mb-auto-button" data-record-id="${record.id}" type="button">Resume automatic</button></div>` : ''}`).join('')}
        </div>`).join('') : '<p class="muted">No linked members yet. Members can use /membership-link, or simulation mode can create a test link.</p>';
}

function renderMemberBridgeAudit(events) {
    const container = document.getElementById('mbAudit');
    container.innerHTML = events.length ? events.map(event => `<div class="log-line ${event.severity === 'error' || event.severity === 'critical' ? 'error' : 'system'}"><time>${new Date(event.created_utc).toLocaleString()}</time><b>${escapeHtml(event.severity)}</b><span>${escapeHtml(event.event_type)} · ${escapeHtml(event.message)}</span></div>`).join('') : '<div class="log-empty">No MemberBridge audit events yet.</div>';
}

function renderMemberBridgeBackups(backups) {
    document.getElementById('mbBackups').innerHTML = backups.length ? backups.map(item => `<div class="economy-row"><span><b>${escapeHtml(item.fileName)}</b> ${new Date(item.createdUtc).toLocaleString()} · ${Number(item.size).toLocaleString()} bytes</span><div class="button-row"><button class="button ghost mb-verify-backup" data-file-name="${escapeHtml(item.fileName)}" type="button">Verify</button><button class="button danger mb-restore-backup" data-file-name="${escapeHtml(item.fileName)}" type="button">Restore</button></div></div>`).join('') : '<p class="muted">No MemberBridge backups created yet.</p>';
}

async function loadMemberBridgeLevels() {
    const creator = selectedMemberBridgeCreator();
    memberBridgeLevels = creator ? await window.commission.memberBridge('levels', { creatorId: creator.id }) : [];
    renderMemberBridgeMappings();
}

async function refreshMemberBridge(showSuccess = true) {
    const button = document.getElementById('mbRefreshButton');
    button.disabled = true;
    button.textContent = 'Refreshing…';
    try {
        const [health, creators, links, audit, roles, backups] = await Promise.all([
            window.commission.memberBridge('dashboard'), window.commission.memberBridge('creators'), window.commission.memberBridge('links'), window.commission.memberBridge('audit', { limit: 100 }), window.commission.memberBridge('guild-roles'), window.commission.memberBridge('backup-list'),
        ]);
        memberBridgeCreators = creators;
        memberBridgeRoles = roles;
        document.getElementById('mbCreatorMetric').textContent = `${health.dashboard.operationalCreators}/${health.dashboard.creators}`;
        document.getElementById('mbLinkedMetric').textContent = Number(health.dashboard.linkedMembers).toLocaleString();
        document.getElementById('mbActiveMetric').textContent = Number(health.dashboard.activeMemberships).toLocaleString();
        document.getElementById('mbGraceMetric').textContent = Number(health.dashboard.graceMemberships).toLocaleString();
        const panelState = document.getElementById('mbVerifyPanelState');
        if (health.verifyPanel?.channel_id && health.verifyPanel?.message_id) {
            panelState.textContent = `Active · ${health.verifyPanel.channel_id}`;
            panelState.classList.remove('danger-badge');
            panelState.classList.add('active-badge');
        } else {
            panelState.textContent = 'Not published';
            panelState.classList.remove('active-badge');
            panelState.classList.add('danger-badge');
        }
        renderMemberBridgeCreatorSelect();
        await loadMemberBridgeLevels();
        renderMemberBridgeMembers(links);
        renderMemberBridgeAudit(audit);
        renderMemberBridgeBackups(backups);
        if (showSuccess) showToast(`MemberBridge is ${health.status.toLowerCase()}.`);
    } catch (error) { showToast(friendlyError(error), true); }
    finally { button.disabled = false; button.textContent = 'Refresh MemberBridge'; }
}

loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    loginError.textContent = '';
    try {
        const result = await window.commission.login({ password: loginPassword.value, remember: rememberLogin.checked });
        if (!result.ok) {
            loginError.textContent = result.error;
            loginPassword.select();
            return;
        }
        enterControlRoom(result);
    } catch (error) {
        loginError.textContent = friendlyError(error);
    }
});

document.querySelectorAll('.nav-item').forEach(button => {
    button.addEventListener('click', () => {
        openPage(button.dataset.pageTarget);
        if (button.dataset.pageTarget === 'memberbridge' && currentStatus.state === 'running') refreshMemberBridge(false);
    });
});

document.querySelector('[data-setting="memberBridgePublicBaseUrl"]').addEventListener('input', updateMemberBridgeRedirects);
document.querySelector('[data-setting="memberBridgeSimulationMode"]').addEventListener('change', event => document.getElementById('memberBridgeSimulationWarning').classList.toggle('hidden', !event.target.checked));


document.getElementById('saveButton').addEventListener('click', async () => {
    const button = document.getElementById('saveButton');
    button.disabled = true;
    document.getElementById('saveState').textContent = 'Saving…';
    try {
        const result = await window.commission.saveConfig(collectPayload());
        applyConfig(result.config);
        clearSecretInputs();
        document.getElementById('saveState').textContent = 'Saved to this PC';
        showToast('Settings saved. Restart the bot to apply changes.');
    } catch (error) {
        document.getElementById('saveState').textContent = 'Save failed';
        showToast(friendlyError(error), true);
    } finally {
        button.disabled = false;
    }
});

document.getElementById('startButton').addEventListener('click', async () => {
    try {
        renderStatus(await window.commission.startBot());
        showToast('Protection process started.');
    } catch (error) {
        showToast(friendlyError(error), true);
    }
});

document.getElementById('stopButton').addEventListener('click', async () => {
    try {
        renderStatus(await window.commission.stopBot());
        showToast('Stop signal sent.');
    } catch (error) {
        showToast(friendlyError(error), true);
    }
});

document.getElementById('dashboardButton').addEventListener('click', async () => {
    try {
        await window.commission.openDashboard();
    } catch (error) {
        showToast(friendlyError(error), true);
    }
});

document.getElementById('openDataButton').addEventListener('click', async () => {
    try {
        await window.commission.openDataFolder();
    } catch (error) {
        showToast(friendlyError(error), true);
    }
});

document.getElementById('clearLogsButton').addEventListener('click', () => replaceLogs([]));

document.getElementById('refreshEconomyButton').addEventListener('click', refreshEconomy);
document.getElementById('economyLeaderboardType').addEventListener('change', refreshEconomy);

document.getElementById('mbRefreshButton').addEventListener('click', () => refreshMemberBridge(true));
document.getElementById('mbPublishVerifyPanelButton').addEventListener('click', async () => {
    const button = document.getElementById('mbPublishVerifyPanelButton');
    button.disabled = true;
    button.textContent = 'Publishing…';
    try {
        const categoryId = document.querySelector('[data-setting="memberBridgeVerifyCategoryId"]').value.trim();
        const channelInput = document.querySelector('[data-setting="memberBridgeVerifyChannelId"]');
        const channelName = document.querySelector('[data-setting="memberBridgeVerifyChannelName"]').value.trim();
        const result = await window.commission.memberBridge('publish-verify-panel', { categoryId, channelId: channelInput.value.trim(), channelName });
        channelInput.value = result.channelId;
        const saved = await window.commission.saveConfig(collectPayload());
        applyConfig(saved.config);
        await refreshMemberBridge(false);
        showToast(`Verification panel is active in #${result.channelName}.`);
    } catch (error) { showToast(friendlyError(error), true); }
    finally { button.disabled = false; button.textContent = 'Create / repair verification panel'; }
});
document.getElementById('mbCreatorSelect').addEventListener('change', async () => {
    applyMemberBridgeCreator();
    try { await loadMemberBridgeLevels(); } catch (error) { showToast(friendlyError(error), true); }
});
document.getElementById('mbAddCreatorButton').addEventListener('click', async () => {
    const name = document.getElementById('mbNewCreatorName').value.trim();
    if (!name) return showToast('Enter a creator display name.', true);
    try {
        const creator = await window.commission.memberBridge('create-creator', { displayName: name });
        document.getElementById('mbNewCreatorName').value = '';
        await refreshMemberBridge(false);
        document.getElementById('mbCreatorSelect').value = String(creator.id);
        applyMemberBridgeCreator(); await loadMemberBridgeLevels();
        showToast(`Creator source ${creator.display_name} added.`);
    } catch (error) { showToast(friendlyError(error), true); }
});
document.getElementById('mbSaveCreatorButton').addEventListener('click', async () => {
    const creator = selectedMemberBridgeCreator(); if (!creator) return;
    try {
        await window.commission.memberBridge('update-creator', { creatorId: creator.id, patch: {
            role_mode: document.getElementById('mbRoleMode').value,
            general_role_id: document.getElementById('mbGeneralRoleId').value.trim(),
            missing_checks_before_grace: Number(document.getElementById('mbCreatorMissingChecks').value),
            grace_period_hours: Number(document.getElementById('mbCreatorGraceHours').value),
            mass_absence_percent: Number(document.getElementById('mbCreatorMassAbsence').value),
        }});
        await refreshMemberBridge(false); showToast('Creator settings saved.');
    } catch (error) { showToast(friendlyError(error), true); }
});
document.getElementById('mbConnectCreatorButton').addEventListener('click', async () => {
    const creator = selectedMemberBridgeCreator(); if (!creator) return;
    try { await window.commission.memberBridge('connect-creator', { creatorId: creator.id }); showToast('Creator authorization opened in your browser.'); }
    catch (error) { showToast(friendlyError(error), true); }
});
document.getElementById('mbCreatorPortalButton').addEventListener('click', async () => {
    const creator = selectedMemberBridgeCreator(); if (!creator) return;
    try {
        const result = await window.commission.memberBridge('creator-portal-link', { creatorId: creator.id });
        const input = document.getElementById('mbCreatorPortalUrl');
        input.value = result.url;
        input.focus(); input.select();
        try { await navigator.clipboard.writeText(result.url); showToast(result.kind === 'invite' ? 'One-time creator invitation copied. It expires in 24 hours.' : 'Creator sign-in link copied.'); }
        catch { showToast('Creator portal link generated. Copy it from the field.'); }
    } catch (error) { showToast(friendlyError(error), true); }
});
document.getElementById('mbActivateSimulatorButton').addEventListener('click', async () => {
    const creator = selectedMemberBridgeCreator(); if (!creator) return;
    try { await window.commission.memberBridge('activate-simulator', { creatorId: creator.id, youtubeChannelId: `SIM_CREATOR_${creator.id}` }); await refreshMemberBridge(false); showToast('Simulator creator activated.'); }
    catch (error) { showToast(friendlyError(error), true); }
});
document.getElementById('mbSyncLevelsButton').addEventListener('click', async () => {
    const creator = selectedMemberBridgeCreator(); if (!creator) return;
    try { await window.commission.memberBridge('sync-levels', { creatorId: creator.id }); await refreshMemberBridge(false); showToast('Membership levels imported.'); }
    catch (error) { showToast(friendlyError(error), true); }
});
document.getElementById('mbVerifyButton').addEventListener('click', async () => {
    const creator = selectedMemberBridgeCreator(); if (!creator) return;
    try { const result = await window.commission.memberBridge('verify', { creatorId: creator.id }); await refreshMemberBridge(false); showToast(`Checked ${result.checked} member(s): ${result.active} active, ${result.missing} missing.`); }
    catch (error) { showToast(friendlyError(error), true); }
});
document.getElementById('mbSafeModeButton').addEventListener('click', async () => {
    const creator = selectedMemberBridgeCreator(); if (!creator) return;
    const enabled = !creator.safe_mode;
    if (enabled && !confirm('Enable safe mode for this creator? Role removals will pause until you disable it.')) return;
    try { await window.commission.memberBridge('set-safe-mode', { creatorId: creator.id, enabled, reason: 'Changed from The Commission desktop app.' }); await refreshMemberBridge(false); showToast(`Safe mode ${enabled ? 'enabled' : 'disabled'}.`); }
    catch (error) { showToast(friendlyError(error), true); }
});
document.getElementById('mbSeedLevelButton').addEventListener('click', async () => {
    const creator = selectedMemberBridgeCreator(); if (!creator) return;
    try {
        await window.commission.memberBridge('seed-level', { creatorId: creator.id, youtubeLevelId: document.getElementById('mbSeedLevelId').value.trim(), displayName: document.getElementById('mbSeedLevelName').value.trim() });
        document.getElementById('mbSeedLevelId').value = ''; document.getElementById('mbSeedLevelName').value = '';
        await loadMemberBridgeLevels(); showToast('Simulated membership level saved.');
    } catch (error) { showToast(friendlyError(error), true); }
});
document.getElementById('mbMappings').addEventListener('click', async event => {
    const button = event.target.closest('.mb-map-button'); if (!button) return;
    const creator = selectedMemberBridgeCreator(); const row = button.closest('.mapping-row');
    try { await window.commission.memberBridge('map-level', { creatorId: creator.id, youtubeLevelId: row.dataset.levelId, roleId: row.querySelector('.mb-role-map').value }); await loadMemberBridgeLevels(); showToast('Permanent level-to-role mapping saved.'); }
    catch (error) { showToast(friendlyError(error), true); }
});
document.getElementById('mbSimSaveButton').addEventListener('click', async () => {
    const creator = selectedMemberBridgeCreator(); if (!creator) return;
    const discordUserId = document.getElementById('mbSimDiscordUserId').value.trim();
    const youtubeChannelId = document.getElementById('mbSimYoutubeChannelId').value.trim();
    const highestLevelId = document.getElementById('mbSimLevel').value;
    if (!/^\d{17,20}$/.test(discordUserId) || !youtubeChannelId) return showToast('Enter a valid Discord user ID and test YouTube channel ID.', true);
    try {
        await window.commission.memberBridge('simulator-link', { discordUserId, youtubeChannelId, youtubeDisplayName: youtubeChannelId });
        await window.commission.memberBridge('simulator-member', { creatorId: creator.id, youtubeChannelId, highestLevelId, accessibleLevelIds: highestLevelId ? [highestLevelId] : [], active: Boolean(highestLevelId) });
        const result = await window.commission.memberBridge('verify', { creatorId: creator.id, discordUserId });
        await refreshMemberBridge(false); showToast(`Simulator saved and checked: ${result.active} active, ${result.missing} missing.`);
    } catch (error) { showToast(friendlyError(error), true); }
});
document.getElementById('mbSimFailureButton').addEventListener('click', async () => {
    const creator = selectedMemberBridgeCreator(); if (!creator) return;
    try { await window.commission.memberBridge('simulator-failure', { creatorId: creator.id, mode: document.getElementById('mbSimFailure').value }); showToast('Simulator response mode updated.'); }
    catch (error) { showToast(friendlyError(error), true); }
});
document.getElementById('mbMembers').addEventListener('click', async event => {
    const preserve = event.target.closest('.mb-preserve-button');
    const automatic = event.target.closest('.mb-auto-button');
    if (!preserve && !automatic) return;
    const recordId = Number((preserve || automatic).dataset.recordId);
    try {
        if (preserve) await window.commission.memberBridge('create-override', { recordId, overrideType: 'PreserveCurrentRole', reason: 'Seven-day preservation from The Commission desktop app.', expiresUtc: new Date(Date.now() + 7 * 86400000).toISOString() });
        else await window.commission.memberBridge('remove-override', { recordId });
        await refreshMemberBridge(false); showToast(preserve ? 'Role-preservation override enabled for seven days.' : 'Automatic verification resumed.');
    } catch (error) { showToast(friendlyError(error), true); }
});
document.getElementById('mbCreateBackupButton').addEventListener('click', async () => {
    const button = document.getElementById('mbCreateBackupButton'); button.disabled = true;
    try { const result = await window.commission.memberBridge('backup-create'); await refreshMemberBridge(false); showToast(result.valid ? `Backup ${result.fileName} created and verified.` : 'Backup created but verification failed.', !result.valid); }
    catch (error) { showToast(friendlyError(error), true); }
    finally { button.disabled = false; }
});
document.getElementById('mbBackups').addEventListener('click', async event => {
    const verify = event.target.closest('.mb-verify-backup');
    const restore = event.target.closest('.mb-restore-backup');
    if (!verify && !restore) return;
    const fileName = (verify || restore).dataset.fileName;
    if (restore && !confirm(`Restore ${fileName}? The bot will stop, the current database will be preserved as a pre-restore backup, and the selected backup will replace current MemberBridge data.`)) return;
    try {
        if (verify) {
            const result = await window.commission.memberBridge('backup-verify', { fileName });
            showToast(result.valid ? 'Backup hash and SQLite integrity are valid.' : 'Backup verification failed.', !result.valid);
        } else {
            const result = await window.commission.restoreMemberBridgeBackup(fileName);
            showToast(`Restored ${result.restored}. The current database was preserved as ${result.preRestore || 'a rollback file'}.`);
        }
    }
    catch (error) { showToast(friendlyError(error), true); }
});

document.getElementById('pushHeistPanelButton').addEventListener('click', async () => {
    const button = document.getElementById('pushHeistPanelButton');
    button.disabled = true;
    button.textContent = 'Saving & pushing…';
    try {
        const saved = await window.commission.saveConfig(collectPayload());
        applyConfig(saved.config);
        clearSecretInputs();
        document.getElementById('saveState').textContent = 'Saved to this PC';
        const result = await window.commission.pushHeistPanel();
        showToast(`Heist panel pushed to Discord channel ${result.channelId}.`);
    } catch (error) {
        showToast(friendlyError(error), true);
    } finally {
        button.disabled = false;
        button.textContent = 'Push / repair heist panel';
    }
});

document.getElementById('previewBulkGrantButton').addEventListener('click', async () => {
    const button = document.getElementById('previewBulkGrantButton');
    pendingBulkGrantToken = '';
    document.getElementById('confirmBulkGrantButton').disabled = true;
    button.disabled = true;
    button.textContent = 'Counting server members…';
    try {
        const amount = Number.parseInt(document.getElementById('bulkGrantAmount').value, 10);
        const result = await window.commission.previewBulkGrant(amount);
        pendingBulkGrantToken = result.token;
        const preview = result.preview;
        document.getElementById('bulkGrantPreview').innerHTML = [
            `<p><b>Human members receiving funds:</b> ${Number(preview.affectedMembers).toLocaleString()}</p>`,
            `<p><b>Amount per member:</b> ${Number(preview.amountPerMember).toLocaleString()}</p>`,
            `<p><b>Total Blood Money created:</b> ${Number(preview.totalGrant).toLocaleString()}</p>`,
            '<p><b>Bots excluded:</b> Yes</p>',
        ].join('');
        document.getElementById('confirmBulkGrantButton').disabled = false;
        showToast('Bulk grant preview ready. Review the total before confirming.');
    } catch (error) {
        showToast(friendlyError(error), true);
    } finally {
        button.disabled = false;
        button.textContent = 'Preview bulk grant';
    }
});

document.getElementById('confirmBulkGrantButton').addEventListener('click', async () => {
    if (!pendingBulkGrantToken) return;
    if (!confirm('Add the previewed Blood Money amount to every human member? This creates a permanent ledger entry for every recipient and is audit logged.')) return;
    const button = document.getElementById('confirmBulkGrantButton');
    button.disabled = true;
    button.textContent = 'Crediting every member…';
    try {
        const result = await window.commission.executeBulkGrant(pendingBulkGrantToken);
        pendingBulkGrantToken = '';
        document.getElementById('bulkGrantPreview').innerHTML = `<p><b>Completed:</b> ${Number(result.affectedMembers).toLocaleString()} members received ${Number(result.amountPerMember).toLocaleString()} each. Total: ${Number(result.totalGrant).toLocaleString()}.</p>`;
        await refreshEconomy();
        showToast(`Added ${Number(result.amountPerMember).toLocaleString()} to ${Number(result.affectedMembers).toLocaleString()} members.`);
    } catch (error) {
        showToast(friendlyError(error), true);
    } finally {
        button.textContent = 'Confirm bulk grant';
        button.disabled = !pendingBulkGrantToken;
    }
});

document.getElementById('bulkGrantAmount').addEventListener('input', () => {
    pendingBulkGrantToken = '';
    document.getElementById('confirmBulkGrantButton').disabled = true;
});

function renderEconomyResetPreview(preview) {
    const labels = {
        'weekly-rankings': 'Weekly rankings', 'monthly-rankings': 'Monthly rankings',
        'weekly-activity': 'Weekly activity statistics', 'monthly-activity': 'Monthly activity statistics',
        'weekly-gambling': 'Weekly gambling statistics', 'monthly-gambling': 'Monthly gambling statistics',
        'all-balances': 'All current balances', 'member-balance': 'One member balance',
        'gambling-limits': 'Daily blackjack and poker allowances',
    };
    const details = [
        `<p><b>Operation:</b> ${escapeHtml(labels[preview.action] || preview.action)}</p>`,
        preview.periodKey ? `<p><b>Period:</b> ${escapeHtml(preview.periodKey)}</p>` : '',
        preview.userId ? `<p><b>Member:</b> ${escapeHtml(preview.userId)}</p>` : '',
        preview.affectedMembers !== undefined ? `<p><b>Affected members:</b> ${Number(preview.affectedMembers).toLocaleString()}</p>` : '',
        preview.currentBalance !== undefined ? `<p><b>Blood Money to remove:</b> ${Number(preview.currentBalance).toLocaleString()}</p>` : '',
        preview.transactions !== undefined ? `<p><b>Transactions in period:</b> ${Number(preview.transactions).toLocaleString()}</p>` : '',
        preview.earned !== undefined ? `<p><b>Earned in period:</b> ${Number(preview.earned).toLocaleString()}</p>` : '',
        preview.wagered !== undefined ? `<p><b>Wagered in period:</b> ${Number(preview.wagered).toLocaleString()}</p>` : '',
        preview.totalDailyWagered !== undefined ? `<p><b>Global daily wager usage:</b> ${Number(preview.totalDailyWagered).toLocaleString()}</p>` : '',
        preview.blackjackWagered !== undefined ? `<p><b>Blackjack allowance used:</b> ${Number(preview.blackjackWagered).toLocaleString()}</p>` : '',
        preview.pokerWagered !== undefined ? `<p><b>Poker allowance used:</b> ${Number(preview.pokerWagered).toLocaleString()}</p>` : '',
    ].filter(Boolean);
    if (Array.isArray(preview.leaders)) {
        const leaders = preview.leaders.map((row, index) => `<p><b>${index + 1}.</b> ${escapeHtml(row.user_id)} — ${Number(row.score || 0).toLocaleString()}</p>`).join('');
        details.push(`<hr><p><b>Current top results${preview.totalLeaderboardRows ? ` (${preview.totalLeaderboardRows} qualifying)` : ''}:</b></p>${leaders || '<p>No qualifying earnings.</p>'}`);
    }
    document.getElementById('economyResetPreview').innerHTML = details.join('');
}

document.getElementById('previewEconomyResetButton').addEventListener('click', async () => {
    const button = document.getElementById('previewEconomyResetButton');
    pendingEconomyResetToken = '';
    document.getElementById('confirmEconomyResetButton').disabled = true;
    button.disabled = true;
    button.textContent = 'Creating preview…';
    try {
        const result = await window.commission.previewEconomyReset({
            action: document.getElementById('economyResetAction').value,
            userId: document.getElementById('economyResetUserId').value.trim(),
        });
        pendingEconomyResetToken = result.token;
        renderEconomyResetPreview(result.preview);
        document.getElementById('confirmEconomyResetButton').disabled = false;
        showToast('Reset preview ready. Review it before confirming.');
    } catch (error) {
        showToast(friendlyError(error), true);
    } finally {
        button.disabled = false;
        button.textContent = 'Preview reset';
    }
});

document.getElementById('confirmEconomyResetButton').addEventListener('click', async () => {
    if (!pendingEconomyResetToken) return;
    if (!confirm('Apply exactly the reset shown in the preview? This action is audit logged. Lifetime statistics will remain intact.')) return;
    const button = document.getElementById('confirmEconomyResetButton');
    button.disabled = true;
    button.textContent = 'Applying confirmed reset…';
    try {
        const result = await window.commission.executeEconomyReset(pendingEconomyResetToken);
        pendingEconomyResetToken = '';
        document.getElementById('economyResetPreview').innerHTML = '<p class="muted">Reset completed and recorded in the audit log. Create a new preview for another operation.</p>';
        await refreshEconomy();
        showToast(`Confirmed reset completed for ${result.affectedMembers || result.members || 0} member(s).`);
    } catch (error) {
        showToast(friendlyError(error), true);
    } finally {
        button.textContent = 'Confirm previewed reset';
        button.disabled = !pendingEconomyResetToken;
    }
});

document.getElementById('economyResetAction').addEventListener('change', () => {
    pendingEconomyResetToken = '';
    document.getElementById('confirmEconomyResetButton').disabled = true;
});

document.getElementById('refreshGuildsButton').addEventListener('click', async () => {
    try {
        renderGuilds(await window.commission.listGuilds());
        showToast(`Found ${availableGuilds.length} server${availableGuilds.length === 1 ? '' : 's'}.`);
    } catch (error) {
        showToast(friendlyError(error), true);
    }
});

document.getElementById('captureBlueprintButton').addEventListener('click', async () => {
    const guildId = document.getElementById('sourceGuildSelect').value;
    const button = document.getElementById('captureBlueprintButton');
    button.disabled = true;
    button.textContent = 'Capturing…';
    try {
        const result = await window.commission.captureBlueprint(guildId);
        renderBlueprints(result.blueprints);
        document.getElementById('blueprintSelect').value = result.saved.id;
        renderBlueprintSummary(result.saved);
        showToast(`Blueprint captured from ${result.saved.sourceGuild.name}.`);
    } catch (error) {
        showToast(friendlyError(error), true);
    } finally {
        button.disabled = false;
        button.textContent = 'Capture blueprint';
    }
});

document.getElementById('blueprintSelect').addEventListener('change', () => {
    renderBlueprintSummary(selectedBlueprint());
});

document.getElementById('applyBlueprintButton').addEventListener('click', async () => {
    const blueprint = selectedBlueprint();
    const guildId = document.getElementById('destinationGuildSelect').value;
    const destination = availableGuilds.find(guild => guild.id === guildId);
    if (!blueprint || !destination) {
        showToast('Select a saved blueprint and destination server.', true);
        return;
    }
    if (!confirm(`Create the ${blueprint.sourceGuild.name} blueprint inside ${destination.name}? Existing content will not be deleted.`)) return;
    const button = document.getElementById('applyBlueprintButton');
    button.disabled = true;
    button.textContent = 'Applying…';
    try {
        const result = await window.commission.applyBlueprint({
            blueprintId: blueprint.id,
            guildId,
            applyEveryonePermissions: document.getElementById('applyEveryonePermissions').checked,
        });
        renderBlueprintSummary(blueprint, result);
        showToast(`Blueprint applied: ${result.rolesCreated} roles and ${result.channelsCreated + result.categoriesCreated} channels created.`);
    } catch (error) {
        showToast(friendlyError(error), true);
    } finally {
        button.disabled = false;
        button.textContent = 'Apply blueprint';
    }
});

document.getElementById('lockButton').addEventListener('click', async () => {
    await window.commission.lock();
    showLogin();
});

settingsForm.addEventListener('input', () => {
    document.getElementById('saveState').textContent = 'Unsaved changes';
});

window.commission.onStatus(renderStatus);
window.commission.onLog(appendLog);

(async () => {
    try {
        const result = await window.commission.bootstrap();
        if (result.authenticated) enterControlRoom(result);
        else showLogin();
    } catch (error) {
        loginError.textContent = friendlyError(error);
        showLogin();
    }
})();
