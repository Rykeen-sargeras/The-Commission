'use strict';

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
