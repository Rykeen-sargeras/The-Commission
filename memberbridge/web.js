'use strict';

const http = require('http');
const { constantTimeEqual, pkce, randomToken, sha256 } = require('./crypto');
const { now } = require('./store');

function escapeHtml(value) {
    return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
}

function page(title, body, options = {}) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · The Commission</title><style>
    :root{color-scheme:dark;font-family:Inter,Segoe UI,sans-serif;background:#090b10;color:#f4f1e8}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:radial-gradient(circle at top,#2b1520,#090b10 56%);padding:28px 0}main{width:calc(100% - 40px);max-width:1040px;box-sizing:border-box;background:#11141b;border:1px solid #313640;border-radius:18px;padding:32px;box-shadow:0 28px 80px #0009}h1{font-family:Georgia,serif;font-size:34px;margin:8px 0 12px}h2{font-family:Georgia,serif;font-size:22px;margin:30px 0 8px;color:#f4f1e8}.eyebrow{color:#d4ad61;text-transform:uppercase;letter-spacing:.16em;font-size:12px;font-weight:800}p,li{color:#b7bdc8;line-height:1.65}ul{padding-left:22px}a{color:#e4bd72}.button,button{display:inline-block;border:0;border-radius:10px;padding:13px 18px;background:#b8203b;color:white;text-decoration:none;font-weight:750;cursor:pointer}.button.secondary,button.secondary{background:#303746}.legal-links,.actions{display:flex;flex-wrap:wrap;gap:10px;margin:24px 0}.legal-links a{display:inline-block;border:1px solid #444b57;border-radius:9px;padding:10px 13px;text-decoration:none}.legal-nav{display:flex;flex-wrap:wrap;gap:16px;border-top:1px solid #2b3039;margin-top:30px;padding-top:18px;font-size:13px}.updated,.muted{color:#858d9a;font-size:13px}select,input{width:100%;box-sizing:border-box;background:#090c11;color:#fff;border:1px solid #3a414c;border-radius:10px;padding:12px;margin:10px 0 18px}.warning{padding:12px;border-left:3px solid #d4ad61;background:#1d1920;color:#dfd6c2}.ok{color:#79d6a5}.error{color:#ff7c8f}small{display:block;color:#858d9a;margin-top:18px}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:22px 0}.metric{background:#0b0e13;border:1px solid #2b3039;border-radius:12px;padding:16px}.metric b{display:block;font-size:25px;margin-top:6px}.table-wrap{overflow:auto;border:1px solid #2b3039;border-radius:12px}table{width:100%;border-collapse:collapse;min-width:760px}th,td{text-align:left;padding:12px;border-bottom:1px solid #252a33}th{color:#d4ad61;font-size:12px;text-transform:uppercase;letter-spacing:.08em}td{color:#d6dae2}.pager{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:18px 0}.inline{display:flex;gap:10px;align-items:center}.inline input{margin:0}@media(max-width:700px){main{padding:22px}.metrics{grid-template-columns:1fr}.inline{align-items:stretch;flex-direction:column}}</style></head><body><main><div class="eyebrow">The Commission · MemberBridge</div><h1>${escapeHtml(title)}</h1>${body}${options.footer === false ? '' : '<nav class="legal-nav" aria-label="Legal"><a href="/">Home</a><a href="/creator">Creator Portal</a><a href="/terms">Terms of Service</a><a href="/privacy-policy">Privacy Policy</a><a href="/revoke">Disconnect</a></nav><small>Membership data is shown only to the creator who authorized that channel.</small>'}</main></body></html>`;
}

const LEGAL_UPDATED = 'August 6, 2026';

const HOME_CONTENT = `
<p>The Commission is a Discord community-management bot with moderation, virtual Blood Money, REP, games, heists, activity leaderboards, and optional YouTube channel-membership verification through MemberBridge.</p>
<p>Members verify through Discord Connections. Approved creators authorize their own YouTube channel and receive a private portal containing only that channel’s current member list.</p>
<div class="actions"><a class="button" href="/creator">Open Creator Portal</a><a class="button secondary" href="/owner">Owner Sign In</a></div>
<div class="legal-links"><a href="/terms">Read the Terms of Service</a><a href="/privacy-policy">Read the Privacy Policy</a></div>
<p class="updated">Legal documents last updated ${LEGAL_UPDATED}.</p>`;

const TERMS_CONTENT = `
<p class="updated">Effective and last updated: ${LEGAL_UPDATED}</p>
<p>These Terms govern your use of The Commission Discord bot, its MemberBridge membership-verification feature, and its related web pages (together, the “Service”). By using the Service, running one of its commands, participating in its games or economy, or linking an account, you agree to these Terms and the rules of the Discord server where the Service operates.</p>
<h2>1. Eligibility and accounts</h2>
<p>You must meet the minimum age required by Discord, Google, YouTube, and applicable law. You are responsible for your Discord and Google accounts and for making sure the account used during verification belongs to you. Do not share private OAuth links, credentials, or bot tokens.</p>
<h2>2. Acceptable use</h2>
<p>You may use the Service only for lawful community participation. You may not exploit bugs; automate gameplay or rewards; evade moderation; impersonate another person; submit another person’s account; manipulate REP, Blood Money, leaderboards, membership checks, duels, heists, or gambling results; probe or disrupt the Service; or use it in violation of Discord, Google, or YouTube rules.</p>
<h2>3. Virtual currency and games</h2>
<p>Blood Money, REP, ranks, wagers, prizes shown in the bot, and all other in-server points are virtual features controlled by the server owner. They are not legal tender, cryptocurrency, stored value, or property; have no cash value; may not be purchased, sold, or exchanged for money; and may be corrected, frozen, reset, or removed to address abuse, mistakes, seasonal resets, or server administration. Any separately announced physical prize is governed by the announcement’s eligibility rules and is not guaranteed by participation.</p>
<h2>4. Moderation and availability</h2>
<p>Server staff may restrict commands, adjust settings, correct logged balances, remove roles, jail, mute, kick, ban, or otherwise moderate users under server rules. The Service may be changed, interrupted, suspended, or discontinued at any time. We do not guarantee uninterrupted operation, permanent data retention, specific rewards, membership recognition, leaderboard placement, or preservation of virtual balances.</p>
<h2>5. Account linking and third-party services</h2>
<p>MemberBridge depends on Discord, Google, YouTube, Railway, and their APIs. Their own terms and privacy policies also apply. Member verification requests Discord’s identity and connections permissions. Creator authorization requests only the YouTube identity and channel-membership scopes shown on Google’s consent screen. You may disconnect MemberBridge with <b>/membership-unlink</b> and may separately revoke access in your Discord or Google account settings.</p>
<h2>6. Intellectual property</h2>
<p>The Service, its branding, interface, and original code or content are owned by their respective operator or licensors. Discord, Google, YouTube, Railway, and other third-party names and marks belong to their owners. These Terms do not grant ownership of any Service component.</p>
<h2>7. Disclaimers and liability</h2>
<p>The Service is provided “as is” and “as available.” To the fullest extent allowed by law, the operator disclaims implied warranties and is not responsible for indirect, incidental, special, consequential, or punitive losses arising from use, loss of access, moderation decisions, third-party outages, or loss of virtual data. Nothing here limits rights or liabilities that cannot lawfully be limited.</p>
<h2>8. Changes and termination</h2>
<p>These Terms may be updated when the Service or its legal obligations change. The updated date will appear above. Continuing to use the Service after an update means you accept the revised Terms. You may stop using the Service at any time; the operator may suspend or terminate access when reasonably necessary to protect the community or Service.</p>
<h2>9. Contact</h2>
<p>For questions about these Terms, contact the server owner or administrators through The Commission Discord server.</p>`;

const PRIVACY_CONTENT = `
<p class="updated">Effective and last updated: ${LEGAL_UPDATED}</p>
<p>This Privacy Policy explains how the operator of The Commission collects, uses, stores, and discloses information when you use the Discord bot, MemberBridge, and related web pages.</p>
<h2>1. Information collected</h2>
<ul>
<li><b>Discord information:</b> guild, channel, role, message, and user IDs; usernames, display names, and public avatars; account and server-join dates; command interactions; role and moderation events; and audit records.</li>
<li><b>Economy and activity information:</b> Blood Money balances and transactions, REP, leaderboard and reset history, gambling and game records, duel and heist participation, message and voice activity timestamps, voice participation duration, media fingerprints, and normalized recent message text used for duplicate/spam detection and reward calculation.</li>
<li><b>MemberBridge information:</b> the verified YouTube connection selected from your Discord account, including its permanent channel ID and display-name snapshot; membership status and level IDs; mapped Discord roles; verification attempts; grace dates; role operations; creator member-list snapshots; and security audit history.</li>
<li><b>OAuth and technical information:</b> short-lived linking sessions, OAuth state and PKCE values, requested scopes, timestamps, error and diagnostic information, and limited request metadata such as an IP-derived rate-limit counter held in memory.</li>
</ul>
<p>The Service does not request or store your Discord or Google password. Regular members do not authorize Google. Their short-lived Discord OAuth token is discarded after the verified YouTube connection is identified. A participating creator’s Google refresh token is retained in encrypted form so scheduled membership checks and the private creator portal can operate.</p>
<h2>2. How information is used</h2>
<p>Information is used to operate Discord commands; award and audit Blood Money and REP; run games, heists, leaderboards, and resets; prevent abuse and duplicate reward farming; enforce server rules and preemptive bans; create moderation records; verify YouTube channel membership; assign or remove mapped Discord roles; provide grace periods; diagnose failures; secure the Service; and maintain backups.</p>
<h2>3. Google API data</h2>
<p>Google/YouTube authorization is requested only from approved creators. It is used to identify the creator’s channel and access that creator’s official membership and membership-level endpoints. Each creator portal session is isolated to the creator source that was authorized. Information received through Google APIs is handled in accordance with the Google API Services User Data Policy, including its Limited Use requirements. It is not used for advertising or sold.</p>
<h2>4. Disclosure and service providers</h2>
<p>Information is not sold. It may be processed by Discord, Google/YouTube, Railway, and other infrastructure providers as needed to operate the Service; displayed within the Discord server where a feature is designed to be public, such as leaderboards, game panels, or moderation notices; accessed by authorized server staff for administration and safety; or disclosed when required by law or necessary to protect users, the Service, or legal rights.</p>
<h2>5. Retention</h2>
<p>Records are retained for as long as reasonably needed to provide the Service, preserve leaderboards and lifetime statistics, prevent abuse, resolve disputes, maintain security audits, and meet legal obligations. Expired OAuth link sessions are cleaned up automatically. Backups and audit records may remain after an active account link is removed. Retention may also be limited by Railway, Discord, Google, or server-owner backup practices.</p>
<h2>6. Your choices and requests</h2>
<p>Use <b>/membership-unlink</b> in Discord to disconnect MemberBridge. You may also revoke The Commission’s access from your Discord or Google account settings. To request access, correction, export, or deletion of other stored information, contact the server owner or administrators through The Commission Discord server. Some security, transaction, moderation, backup, or audit records may be retained when reasonably necessary or legally required.</p>
<h2>7. Security</h2>
<p>The Service uses HTTPS for production OAuth pages, short-lived single-use sessions, OAuth state validation, PKCE for Google OAuth, restricted scopes, encrypted creator refresh tokens, access-controlled administration, and persistent storage managed by the operator. No system is perfectly secure, so absolute security cannot be guaranteed.</p>
<h2>8. Children</h2>
<p>The Service is not intended for anyone below the minimum age required by Discord, Google, YouTube, or applicable law. If you believe a child provided information improperly, contact the server owner or administrators.</p>
<h2>9. Changes and contact</h2>
<p>This policy may be updated as the Service changes. The current version and updated date will remain posted here. For privacy questions or requests, contact the server owner or administrators through The Commission Discord server.</p>`;

function cookie(req, name) {
    const entry = String(req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith(`${name}=`));
    return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}

function send(res, status, body, type = 'text/html; charset=utf-8') {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
    res.end(body);
}

function redirect(res, url, secureCookie = false, token = '') {
    const headers = { location: url, 'cache-control': 'no-store' };
    if (token) headers['set-cookie'] = `mb_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${secureCookie ? '; Secure' : ''}`;
    res.writeHead(302, headers); res.end();
}

function redirectCreator(res, url, secureCookie, token, maxAge = 86400) {
    const cookieValue = token ? `mb_creator=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}` : `mb_creator=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureCookie ? '; Secure' : ''}`;
    res.writeHead(302, { location: url, 'cache-control': 'no-store', 'set-cookie': cookieValue });
    res.end();
}

function redirectOwner(res, url, secureCookie, token, maxAge = 43200) {
    const cookieValue = token ? `mb_owner=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}` : `mb_owner=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie ? '; Secure' : ''}`;
    res.writeHead(302, { location: url, 'cache-control': 'no-store', 'set-cookie': cookieValue });
    res.end();
}

function formTokenMatches(session, supplied) {
    if (!session?.csrf_hash || !supplied) return false;
    return constantTimeEqual(session.csrf_hash, sha256(supplied));
}

function formatDate(value) {
    if (!value) return 'Not available';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Not available' : date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/New_York' });
}

async function formBody(req, maxBytes = 16384) {
    let text = '';
    for await (const chunk of req) {
        text += chunk;
        if (Buffer.byteLength(text) > maxBytes) throw new Error('Request is too large.');
    }
    return new URLSearchParams(text);
}

async function discordJson(url, options) {
    const response = await fetch(url, options);
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { throw new Error('Discord returned malformed data.'); }
    if (!response.ok) throw new Error(body.error_description || body.message || `Discord OAuth returned HTTP ${response.status}.`);
    return body;
}

class MemberBridgeWeb {
    constructor({ store, youtube, engine, config, onLinked, guildIdProvider }) {
        this.store = store;
        this.youtube = youtube;
        this.engine = engine;
        this.config = config;
        this.onLinked = onLinked;
        this.guildIdProvider = guildIdProvider || (() => '');
        this.server = null;
        this.startedUtc = null;
        this.rate = new Map();
    }

    get baseUrl() { return String(this.config.publicBaseUrl || '').replace(/\/$/, ''); }
    get secure() { return this.baseUrl.startsWith('https://'); }

    memberUrl(token) { return `${this.baseUrl}/connect/${encodeURIComponent(token)}`; }

    creatorAuthorizationUrl(creatorId, purpose = 'connect') {
        const state = randomToken();
        const proof = pkce();
        this.store.createCreatorOAuthSession(creatorId, state, proof.verifier, new Date(Date.now() + 10 * 60000).toISOString(), purpose);
        return this.youtube.authorizationUrl({ kind: 'creator', state, challenge: proof.challenge });
    }

    creatorPortalAccessUrl(creatorId) {
        const creator = this.store.getCreator(creatorId);
        if (!creator) throw new Error('Creator source not found.');
        if (creator.youtube_channel_id) return { kind: 'login', url: `${this.baseUrl}/creator/login/${creator.id}`, expiresUtc: null };
        const token = randomToken();
        const expiresUtc = new Date(Date.now() + 24 * 3600000).toISOString();
        this.store.createCreatorInvite(creator.id, token, expiresUtc);
        return { kind: 'invite', url: `${this.baseUrl}/creator/invite/${encodeURIComponent(token)}`, expiresUtc };
    }

    creatorCsrf(token) { return sha256(`creator-csrf:${token}`); }

    ownerCsrf(token) { return sha256(`owner-csrf:${token}`); }

    creatorSession(req) {
        const token = cookie(req, 'mb_creator');
        return { token, session: this.store.findCreatorPortalSession(token) };
    }

    ownerSession(req) {
        const token = cookie(req, 'mb_owner');
        return { token, session: this.store.findOwnerPortalSession(token) };
    }

    ownerDashboardBody(token, notice = '') {
        const csrf = this.ownerCsrf(token);
        const creators = this.store.listAllCreators();
        const cards = creators.map(creator => `<tr><td><b>${escapeHtml(creator.display_name)}</b><small>Source ${creator.id} · Guild ${escapeHtml(creator.guild_id)}</small></td><td>${escapeHtml(creator.connection_status)}</td><td>${escapeHtml(creator.youtube_channel_id || 'Not connected')}</td><td><form method="post" action="/owner/creator-link"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="creatorId" value="${creator.id}"><button type="submit">${creator.youtube_channel_id ? 'Get sign-in link' : 'Create invitation'}</button></form></td></tr>`).join('');
        return `${notice ? `<p class="ok">${escapeHtml(notice)}</p>` : ''}<p>This owner page manages the live MemberBridge data on this host. Create an approved source, then generate a private link for that creator.</p>
        <form class="inline" method="post" action="/owner/creator-create"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input name="displayName" maxlength="100" required placeholder="Creator display name"><button type="submit">Add creator</button></form>
        <h2>Approved creators</h2><div class="table-wrap"><table><thead><tr><th>Creator</th><th>Status</th><th>YouTube channel ID</th><th>Portal access</th></tr></thead><tbody>${cards || '<tr><td colspan="4">No creator sources yet.</td></tr>'}</tbody></table></div>
        <div class="actions"><form method="post" action="/owner/logout"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="secondary" type="submit">Sign out</button></form></div>`;
    }

    async refreshCreatorCache(creatorId, accessToken = '') {
        const creator = this.store.getCreator(creatorId);
        if (!creator?.youtube_channel_id) throw new Error('This creator has not connected a YouTube channel yet.');
        let token = accessToken;
        if (!token) {
            const refreshToken = this.store.getCreatorRefreshToken(creator.id);
            if (!refreshToken) throw new Error('The creator authorization is missing. Reconnect the creator from The Commission owner app.');
            token = (await this.youtube.refresh(refreshToken)).access_token;
        }
        const [levels, members] = await Promise.all([this.youtube.membershipLevels(token), this.youtube.allCurrentMembers(token)]);
        const wrongCreator = members.find(member => member.creatorChannelId && member.creatorChannelId !== creator.youtube_channel_id);
        if (wrongCreator) throw new Error('YouTube returned a member list for a different creator channel. Nothing was saved.');
        this.store.saveLevels(creator.id, levels);
        const result = this.store.replaceCreatorMemberCache(creator.id, members.filter(member => member.channelId));
        this.store.audit('Creator portal member list refreshed', `Saved ${result.count} current members for ${creator.display_name}.`, { severity: 'success', guildId: creator.guild_id, creatorSourceId: creator.id });
        return result;
    }

    creatorDashboardBody(session, token, url) {
        const query = String(url.searchParams.get('q') || '').trim().slice(0, 100);
        const pageNumber = Math.max(1, Number(url.searchParams.get('page') || 1));
        const data = this.store.creatorMemberCache(session.creator_source_id, query, pageNumber, 100);
        const csrf = this.creatorCsrf(token);
        const rows = data.items.map(member => `<tr><td><b>${escapeHtml(member.display_name || member.youtube_channel_id)}</b><small>${escapeHtml(member.youtube_channel_id)}</small></td><td>${escapeHtml(member.highest_level_name || member.highest_level_id || 'Unknown')}</td><td>${escapeHtml(formatDate(member.member_since_utc))}</td><td>${Number(member.total_duration_months || 0).toLocaleString()} month(s)</td></tr>`).join('');
        const queryParam = query ? `&q=${encodeURIComponent(query)}` : '';
        const previous = data.page > 1 ? `<a class="button secondary" href="/creator/dashboard?page=${data.page - 1}${queryParam}">Previous</a>` : '<span></span>';
        const next = data.page < data.pages ? `<a class="button secondary" href="/creator/dashboard?page=${data.page + 1}${queryParam}">Next</a>` : '<span></span>';
        return `<p>Signed in to the private portal for <b>${escapeHtml(session.display_name)}</b>. This page can only read the member list belonging to YouTube channel <b>${escapeHtml(session.youtube_channel_id)}</b>.</p>
        <div class="metrics"><div class="metric"><span>Current members</span><b>${Number(data.cachedTotal).toLocaleString()}</b></div><div class="metric"><span>Matching search</span><b>${Number(data.total).toLocaleString()}</b></div><div class="metric"><span>Last refreshed</span><b style="font-size:16px">${escapeHtml(formatDate(data.fetchedUtc))}</b></div></div>
        <div class="actions"><form method="post" action="/creator/refresh"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Refresh from YouTube</button></form><form method="post" action="/creator/logout"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="secondary" type="submit">Sign out</button></form></div>
        <form class="inline" method="get" action="/creator/dashboard"><input name="q" value="${escapeHtml(query)}" placeholder="Search member, channel ID, or tier"><button type="submit">Search</button>${query ? '<a class="button secondary" href="/creator/dashboard">Clear</a>' : ''}</form>
        <h2>Member list</h2>${data.fetchedUtc ? `<div class="table-wrap"><table><thead><tr><th>Member</th><th>Current tier</th><th>Current membership started</th><th>Total duration</th></tr></thead><tbody>${rows || `<tr><td colspan="4">${query ? 'No members match this search.' : 'YouTube reports no current members.'}</td></tr>`}</tbody></table></div><div class="pager">${previous}<span>Page ${data.page} of ${data.pages}</span>${next}</div>` : '<p class="warning">No cached members yet. Select “Refresh from YouTube” to load the creator’s current list.</p>'}`;
    }

    limit(req) {
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        const minute = Math.floor(Date.now() / 60000);
        const key = `${ip}:${minute}`;
        const count = (this.rate.get(key) || 0) + 1;
        this.rate.set(key, count);
        if (this.rate.size > 2000) for (const old of this.rate.keys()) if (!old.endsWith(`:${minute}`)) this.rate.delete(old);
        return count <= 40;
    }

    async start() {
        if (!this.config.enabled) return null;
        if (!this.baseUrl) throw new Error('Set the MemberBridge public callback base URL first.');
        if (this.config.productionMode && !this.secure) throw new Error('Production MemberBridge callbacks require an HTTPS public base URL.');
        if (this.config.productionMode && this.config.simulationMode) throw new Error('Simulation mode cannot run in production mode.');
        this.server = http.createServer((req, res) => this.handle(req, res).catch(error => {
            console.error('[MemberBridge web]', error);
            if (!res.headersSent) send(res, 500, page('Connection failed', `<p class="error">${escapeHtml(error.message)}</p>`));
            else res.end();
        }));
        await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.config.callbackPort, this.config.callbackHost, resolve); });
        this.startedUtc = now();
        return this.server.address();
    }

    async stop() {
        if (!this.server) return;
        await new Promise(resolve => this.server.close(resolve));
        this.server = null;
    }

    validSession(session) { return session && !session.used_utc && session.expires_utc > now(); }

    async handle(req, res) {
        if (!this.limit(req)) return send(res, 429, page('Too many requests', '<p>Please wait a minute and try again.</p>'));
        const url = new URL(req.url, this.baseUrl);
        if (req.method === 'GET' && url.pathname === '/') return send(res, 200, page('Membership verification', HOME_CONTENT));
        if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, JSON.stringify({ status: this.server ? 'Healthy' : 'Unhealthy', database: this.store.integrityCheck(), startedUtc: this.startedUtc }), 'application/json; charset=utf-8');
        if (req.method === 'GET' && ['/terms', '/terms-of-service'].includes(url.pathname)) return send(res, 200, page('Terms of Service', TERMS_CONTENT));
        if (req.method === 'GET' && ['/privacy', '/privacy-policy'].includes(url.pathname)) return send(res, 200, page('Privacy Policy', PRIVACY_CONTENT));
        if (req.method === 'GET' && url.pathname === '/revoke') return send(res, 200, page('Disconnect MemberBridge', '<p>Return to the Discord server and use <b>/membership-unlink</b>. You will be asked to confirm before the link is removed.</p>'));

        if (req.method === 'GET' && url.pathname === '/owner') {
            if (!this.config.ownerPassword) return send(res, 503, page('Owner portal not configured', '<p class="error">Set the Railway variable <b>WEB_DASHBOARD_PASSWORD</b>, then redeploy.</p>'));
            const { token, session } = this.ownerSession(req);
            if (session) return send(res, 200, page('MemberBridge owner', this.ownerDashboardBody(token)));
            return send(res, 200, page('Owner sign in', '<p>Sign in to manage approved creators and generate access links for the live hosted MemberBridge database.</p><form method="post" action="/owner/login"><label>Owner password<input type="password" name="password" required autocomplete="current-password"></label><button type="submit">Sign in</button></form>'));
        }

        if (req.method === 'POST' && url.pathname === '/owner/login') {
            if (!this.config.ownerPassword) return send(res, 503, page('Owner portal not configured', '<p class="error">Set WEB_DASHBOARD_PASSWORD and redeploy.</p>'));
            const form = await formBody(req);
            if (!constantTimeEqual(String(form.get('password') || ''), String(this.config.ownerPassword))) return send(res, 403, page('Owner sign-in failed', '<p class="error">That password is invalid.</p><a class="button secondary" href="/owner">Try again</a>'));
            const token = randomToken();
            const csrf = this.ownerCsrf(token);
            this.store.createOwnerPortalSession(token, csrf, new Date(Date.now() + 12 * 3600000).toISOString());
            return redirectOwner(res, '/owner', this.secure, token);
        }

        if (req.method === 'POST' && url.pathname === '/owner/creator-create') {
            const { token, session } = this.ownerSession(req);
            const form = await formBody(req);
            if (!session || !formTokenMatches(session, form.get('csrf'))) return send(res, 403, page('Owner action denied', '<p class="error">Your owner session or confirmation token is invalid.</p>'));
            const displayName = String(form.get('displayName') || '').trim().slice(0, 100);
            if (!displayName) return send(res, 400, page('Creator name required', '<p>Enter a creator display name.</p>'));
            const guildId = String(this.guildIdProvider() || '');
            if (!guildId) throw new Error('The bot is not connected to a Discord server yet.');
            this.store.createCreator({ guildId, displayName, roleMode: 'highest', missingChecksBeforeGrace: this.config.missingChecksBeforeGrace, gracePeriodHours: this.config.gracePeriodHours, verificationIntervalMinutes: this.config.verificationIntervalMinutes, massAbsencePercent: this.config.massAbsencePercent, administratorUserId: 'web-owner' });
            return redirect(res, '/owner');
        }

        if (req.method === 'POST' && url.pathname === '/owner/creator-link') {
            const { token, session } = this.ownerSession(req);
            const form = await formBody(req);
            if (!session || !formTokenMatches(session, form.get('csrf'))) return send(res, 403, page('Owner action denied', '<p class="error">Your owner session or confirmation token is invalid.</p>'));
            const access = this.creatorPortalAccessUrl(Number(form.get('creatorId')));
            return send(res, 200, page(access.kind === 'invite' ? 'Creator invitation ready' : 'Creator sign-in link ready', `<p>${access.kind === 'invite' ? `This one-time invitation expires ${escapeHtml(formatDate(access.expiresUtc))}. Send it privately to the intended creator.` : 'This permanent login URL still requires Google to authorize the exact YouTube channel already bound to this creator source.'}</p><label>Access link<input readonly value="${escapeHtml(access.url)}" onclick="this.select()"></label><div class="actions"><a class="button" href="${escapeHtml(access.url)}">Open link</a><a class="button secondary" href="/owner">Back to owner page</a></div>`));
        }

        if (req.method === 'POST' && url.pathname === '/owner/logout') {
            const { token, session } = this.ownerSession(req);
            const form = await formBody(req);
            if (!session || !formTokenMatches(session, form.get('csrf'))) return send(res, 403, page('Sign-out denied', '<p class="error">Your owner session or confirmation token is invalid.</p>'));
            this.store.deleteOwnerPortalSession(token);
            return redirectOwner(res, '/owner', this.secure, '');
        }

        if (req.method === 'GET' && url.pathname === '/creator') return send(res, 200, page('Creator Portal', '<p>Approved YouTube creators can securely view their own current channel-member list, tiers, and membership duration.</p><p class="warning">Use the private access link supplied by The Commission owner. A creator can never select or view another creator’s member list.</p><p>Already connected? Open the permanent creator login link the owner gave you.</p>'));

        const creatorInvite = url.pathname.match(/^\/creator\/invite\/([^/]+)$/);
        if (req.method === 'GET' && creatorInvite) {
            const token = decodeURIComponent(creatorInvite[1]);
            const invite = this.store.findCreatorInvite(token);
            if (!invite || invite.used_utc || invite.expires_utc <= now()) return send(res, 410, page('Creator invitation expired', '<p class="error">Ask The Commission owner to generate a new creator access link.</p>'));
            const creator = this.store.getCreator(invite.creator_source_id);
            return send(res, 200, page('Connect creator channel', `<p>You were invited to connect <b>${escapeHtml(creator?.display_name || 'a creator source')}</b>. Google will ask you to authorize your YouTube identity and current channel-membership list.</p><p class="warning">Sign in with the Google account that owns the intended YouTube creator channel.</p><a class="button" href="/creator/invite/${encodeURIComponent(token)}/start">Continue with Google</a>`));
        }

        const creatorInviteStart = url.pathname.match(/^\/creator\/invite\/([^/]+)\/start$/);
        if (req.method === 'GET' && creatorInviteStart) {
            const invite = this.store.consumeCreatorInvite(decodeURIComponent(creatorInviteStart[1]));
            if (!invite) return send(res, 410, page('Creator invitation expired', '<p class="error">Ask The Commission owner to generate a new creator access link.</p>'));
            return redirect(res, this.creatorAuthorizationUrl(invite.creator_source_id, 'connect'));
        }

        const creatorLogin = url.pathname.match(/^\/creator\/login\/(\d+)$/);
        if (req.method === 'GET' && creatorLogin) {
            const creator = this.store.getCreator(Number(creatorLogin[1]));
            if (!creator?.youtube_channel_id) return send(res, 404, page('Creator not connected', '<p>Ask The Commission owner for a fresh creator invitation.</p>'));
            return redirect(res, this.creatorAuthorizationUrl(creator.id, 'login'));
        }

        if (req.method === 'GET' && url.pathname === '/creator/dashboard') {
            const { token, session } = this.creatorSession(req);
            if (!session) return send(res, 401, page('Creator sign-in required', '<p>Your private session is missing or expired. Use the creator login link supplied by The Commission owner.</p><a class="button" href="/creator">Return to Creator Portal</a>'));
            return send(res, 200, page(`${session.display_name} members`, this.creatorDashboardBody(session, token, url)));
        }

        if (req.method === 'POST' && url.pathname === '/creator/refresh') {
            const { token, session } = this.creatorSession(req);
            const form = await formBody(req);
            if (!session || !formTokenMatches(session, form.get('csrf'))) return send(res, 403, page('Refresh denied', '<p class="error">Your creator session or confirmation token is invalid.</p>'));
            await this.refreshCreatorCache(session.creator_source_id);
            return redirect(res, '/creator/dashboard');
        }

        if (req.method === 'POST' && url.pathname === '/creator/logout') {
            const { token, session } = this.creatorSession(req);
            const form = await formBody(req);
            if (!session || !formTokenMatches(session, form.get('csrf'))) return send(res, 403, page('Sign-out denied', '<p class="error">Your creator session or confirmation token is invalid.</p>'));
            this.store.deleteCreatorPortalSession(token);
            return redirectCreator(res, '/creator', this.secure, '');
        }

        const connect = url.pathname.match(/^\/connect\/([^/]+)$/);
        if (req.method === 'GET' && connect) {
            const token = decodeURIComponent(connect[1]);
            const session = this.store.findLinkSession(token);
            if (!this.validSession(session)) return send(res, 410, page('Link expired', '<p>This single-use link has expired or was already used. Run <b>/membership-link</b> again in Discord.</p>'));
            return send(res, 200, page('Verify through Discord', `<p>Discord will confirm that you are <b>${escapeHtml(session.discord_username || session.discord_user_id)}</b> and share your verified YouTube connection.</p><p class="warning">Before continuing, connect your YouTube channel in Discord under <b>User Settings → Connections</b>. The Commission never receives your Discord or Google password.</p><a class="button" href="/oauth/discord/start?token=${encodeURIComponent(token)}">Verify with Discord Connections</a>`));
        }

        if (req.method === 'GET' && url.pathname === '/oauth/discord/start') {
            const token = url.searchParams.get('token') || '';
            const session = this.store.findLinkSession(token);
            if (!this.validSession(session)) return send(res, 410, page('Link expired', '<p>Run <b>/membership-link</b> again.</p>'));
            if (!this.config.discordApplicationId || !this.config.discordClientSecret) throw new Error('The owner must save the Discord application ID and OAuth client secret in MemberBridge settings.');
            const state = randomToken();
            this.store.updateLinkSession(session.id, { state_hash: sha256(state) });
            const params = new URLSearchParams({ response_type: 'code', client_id: this.config.discordApplicationId, scope: 'identify connections', state, redirect_uri: `${this.baseUrl}/oauth/discord/callback`, prompt: 'consent' });
            return redirect(res, `https://discord.com/oauth2/authorize?${params}`, this.secure, token);
        }

        if (req.method === 'GET' && url.pathname === '/oauth/discord/callback') {
            const state = url.searchParams.get('state') || '';
            const code = url.searchParams.get('code') || '';
            const session = this.store.findLinkSessionByState(state, 'discord');
            if (!this.validSession(session) || !code) return send(res, 400, page('Discord confirmation failed', '<p class="error">The OAuth state was invalid, expired, or already used.</p>'));
            this.store.updateLinkSession(session.id, { state_hash: null });
            const token = await discordJson('https://discord.com/api/v10/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.config.discordApplicationId, client_secret: this.config.discordClientSecret, grant_type: 'authorization_code', code, redirect_uri: `${this.baseUrl}/oauth/discord/callback` }) });
            const user = await discordJson('https://discord.com/api/v10/users/@me', { headers: { authorization: `Bearer ${token.access_token}` } });
            if (user.id !== session.discord_user_id) return send(res, 403, page('Wrong Discord account', `<p class="error">Sign into the same Discord account that ran /membership-link. Expected user ID ${escapeHtml(session.discord_user_id)}.</p>`));
            const connections = await discordJson('https://discord.com/api/v10/users/@me/connections', { headers: { authorization: `Bearer ${token.access_token}` } });
            const channels = (Array.isArray(connections) ? connections : []).filter(connection => connection?.type === 'youtube' && connection.verified === true && /^UC[A-Za-z0-9_-]{22}$/.test(String(connection.id || ''))).map(connection => ({ id: String(connection.id), title: String(connection.name || connection.id) }));
            this.store.updateLinkSession(session.id, { discord_confirmed: 1 });
            if (!channels.length) return send(res, 400, page('Verified YouTube connection needed', '<p class="error">Discord did not return a verified YouTube connection.</p><p>Open Discord <b>User Settings → Connections</b>, add YouTube, finish verification, then run <b>/membership-link</b> again.</p>'));
            if (channels.length === 1) return this.finishMemberLink(res, session, { id: channels[0].id, snippet: { title: channels[0].title } });
            const csrf = randomToken();
            this.store.updateLinkSession(session.id, { channel_choices_json: JSON.stringify({ csrfHash: sha256(csrf), channels }) });
            const options = channels.map(channel => `<option value="${escapeHtml(channel.id)}">${escapeHtml(channel.title)} · ${escapeHtml(channel.id)}</option>`).join('');
            return send(res, 200, page('Choose a Discord YouTube connection', `<p>Discord returned more than one verified YouTube connection. Select the identity to link.</p><form method="post" action="/link/select"><input type="hidden" name="session" value="${session.id}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><select name="channelId" required>${options}</select><button type="submit">Link selected channel</button></form>`));
        }

        if (req.method === 'GET' && url.pathname === '/oauth/google/start') {
            return send(res, 410, page('Member Google login removed', '<p>Regular members now verify through Discord Connections. Run <b>/membership-link</b> in Discord to start the new flow.</p>'));
        }

        if (req.method === 'GET' && url.pathname === '/oauth/google/callback') {
            return send(res, 410, page('Member Google login removed', '<p>Regular members now verify through Discord Connections. Run <b>/membership-link</b> in Discord to start the new flow.</p>'));
        }

        if (req.method === 'POST' && url.pathname === '/link/select') {
            const form = await formBody(req);
            const session = this.store.db.prepare('SELECT * FROM mb_link_sessions WHERE id=?').get(Number(form.get('session')));
            if (!this.validSession(session)) return send(res, 410, page('Selection expired', '<p>Run /membership-link again.</p>'));
            let choices; try { choices = JSON.parse(session.channel_choices_json || '{}'); } catch { choices = {}; }
            if (!choices.csrfHash || choices.csrfHash !== sha256(form.get('csrf') || '')) return send(res, 403, page('Invalid selection', '<p class="error">The selection token did not match.</p>'));
            const channel = (choices.channels || []).find(item => item.id === form.get('channelId'));
            if (!channel) return send(res, 400, page('Invalid channel', '<p>The selected channel was not part of this authorization.</p>'));
            return this.finishMemberLink(res, session, { id: channel.id, snippet: { title: channel.title, thumbnails: { default: { url: channel.image } } } });
        }

        if (req.method === 'GET' && url.pathname === '/oauth/google/creator-callback') {
            const state = url.searchParams.get('state') || '';
            const code = url.searchParams.get('code') || '';
            const oauth = this.store.consumeCreatorOAuthSession(state);
            if (!oauth || !code) return send(res, 400, page('Creator connection failed', '<p class="error">The creator OAuth state was invalid, expired, or already used.</p>'));
            const tokens = await this.youtube.exchangeCode({ code, verifier: oauth.pkce_verifier, kind: 'creator' });
            const channels = await this.youtube.channelsMine(tokens.access_token);
            if (channels.length !== 1) throw new Error(`Expected one authorized creator channel, but Google returned ${channels.length}.`);
            const creator = this.store.getCreator(oauth.creator_source_id);
            if (!creator) throw new Error('The approved creator source no longer exists.');
            if (creator.youtube_channel_id && creator.youtube_channel_id !== channels[0].id) return send(res, 403, page('Wrong creator channel', `<p class="error">This portal belongs to <b>${escapeHtml(creator.display_name)}</b>. Google authorized a different YouTube channel, so access was denied.</p>`));
            const storedRefreshToken = this.store.getCreatorRefreshToken(creator.id);
            if (!tokens.refresh_token && !storedRefreshToken) throw new Error('Google did not return a creator refresh token. Reconnect and approve consent.');
            const [levels, members] = await Promise.all([this.youtube.membershipLevels(tokens.access_token), this.youtube.allCurrentMembers(tokens.access_token)]);
            const wrongCreator = members.find(member => member.creatorChannelId && member.creatorChannelId !== channels[0].id);
            if (wrongCreator) throw new Error('YouTube returned a member list for a different creator channel. Nothing was saved.');
            if (tokens.refresh_token) this.store.saveCreatorAuthorization(creator.id, channels[0], tokens.refresh_token, tokens.scope || '');
            this.store.saveLevels(oauth.creator_source_id, levels);
            this.store.replaceCreatorMemberCache(oauth.creator_source_id, members.filter(member => member.channelId));
            this.store.audit('Creator authorization connected', `Connected creator ${channels[0].snippet?.title || channels[0].id}; loaded ${levels.length} levels and ${members.length} current members.`, { severity: 'success', guildId: creator.guild_id, creatorSourceId: oauth.creator_source_id });
            const portalToken = randomToken();
            const csrf = this.creatorCsrf(portalToken);
            this.store.createCreatorPortalSession(creator.id, portalToken, csrf, new Date(Date.now() + 24 * 3600000).toISOString());
            return redirectCreator(res, '/creator/dashboard', this.secure, portalToken);
        }

        return send(res, 404, page('Not found', '<p>The requested MemberBridge page does not exist.</p>'));
    }

    async finishMemberLink(res, session, channel) {
        const link = this.store.linkAccount({ guildId: session.discord_guild_id, discordUserId: session.discord_user_id, discordUsername: session.discord_username, youtubeChannelId: channel.id, youtubeDisplayName: channel.snippet?.title || channel.id, youtubeProfileImage: channel.snippet?.thumbnails?.default?.url || '' });
        this.store.updateLinkSession(session.id, { used_utc: now(), channel_choices_json: null });
        this.store.audit('Account link completed', `Linked Discord ${session.discord_user_id} to YouTube channel ${channel.id}.`, { severity: 'success', guildId: session.discord_guild_id, discordUserId: session.discord_user_id });
        if (this.onLinked) setImmediate(() => this.onLinked(link).catch(error => console.error('[MemberBridge immediate verification]', error)));
        return send(res, 200, page('Discord connection verified', `<p class="ok"><b>${escapeHtml(channel.snippet?.title || channel.id)}</b> is now linked to your Discord account. Membership verification has been queued for every enabled creator.</p>`));
    }
}

module.exports = { MemberBridgeWeb, escapeHtml, page };
