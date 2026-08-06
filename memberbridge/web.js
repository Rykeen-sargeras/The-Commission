'use strict';

const http = require('http');
const { pkce, randomToken, sha256 } = require('./crypto');
const { now } = require('./store');

function escapeHtml(value) {
    return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
}

function page(title, body, options = {}) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · The Commission</title><style>
    :root{color-scheme:dark;font-family:Inter,Segoe UI,sans-serif;background:#090b10;color:#f4f1e8}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at top,#2b1520,#090b10 56%);padding:28px 0}main{width:min(760px,calc(100% - 40px));box-sizing:border-box;background:#11141b;border:1px solid #313640;border-radius:18px;padding:32px;box-shadow:0 28px 80px #0009}h1{font-family:Georgia,serif;font-size:34px;margin:8px 0 12px}h2{font-family:Georgia,serif;font-size:22px;margin:30px 0 8px;color:#f4f1e8}.eyebrow{color:#d4ad61;text-transform:uppercase;letter-spacing:.16em;font-size:12px;font-weight:800}p,li{color:#b7bdc8;line-height:1.65}ul{padding-left:22px}a{color:#e4bd72}.button,button{display:inline-block;border:0;border-radius:10px;padding:13px 18px;background:#b8203b;color:white;text-decoration:none;font-weight:750;cursor:pointer}.legal-links{display:flex;flex-wrap:wrap;gap:10px;margin:24px 0}.legal-links a{display:inline-block;border:1px solid #444b57;border-radius:9px;padding:10px 13px;text-decoration:none}.legal-nav{display:flex;flex-wrap:wrap;gap:16px;border-top:1px solid #2b3039;margin-top:30px;padding-top:18px;font-size:13px}.updated{color:#858d9a;font-size:13px}select{width:100%;box-sizing:border-box;background:#090c11;color:#fff;border:1px solid #3a414c;border-radius:10px;padding:12px;margin:10px 0 18px}.warning{padding:12px;border-left:3px solid #d4ad61;background:#1d1920;color:#dfd6c2}.ok{color:#79d6a5}.error{color:#ff7c8f}small{display:block;color:#858d9a;margin-top:18px}</style></head><body><main><div class="eyebrow">The Commission · MemberBridge</div><h1>${escapeHtml(title)}</h1>${body}${options.footer === false ? '' : '<nav class="legal-nav" aria-label="Legal"><a href="/">Home</a><a href="/terms">Terms of Service</a><a href="/privacy-policy">Privacy Policy</a><a href="/revoke">Disconnect</a></nav><small>You can close this page and return to Discord when finished.</small>'}</main></body></html>`;
}

const LEGAL_UPDATED = 'August 6, 2026';

const HOME_CONTENT = `
<p>The Commission is a Discord community-management bot with moderation, virtual Blood Money, REP, games, heists, activity leaderboards, and optional YouTube channel-membership verification through MemberBridge.</p>
<p>MemberBridge uses Discord OAuth to confirm your Discord identity and Google OAuth to let you select a YouTube channel identity. It then uses the official YouTube API to verify eligible channel memberships and manage mapped Discord roles.</p>
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
<p>MemberBridge depends on Discord, Google, YouTube, Railway, and their APIs. Their own terms and privacy policies also apply. Authorizing MemberBridge permits only the scopes shown on the provider’s consent screen. You may disconnect MemberBridge with <b>/membership-unlink</b> and may separately revoke access in your Discord or Google account settings.</p>
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
<li><b>MemberBridge information:</b> the YouTube channel identity you select, including its permanent channel ID, display-name snapshot, and optional public thumbnail; membership status and level IDs; mapped Discord roles; verification attempts; grace dates; role operations; and security audit history.</li>
<li><b>OAuth and technical information:</b> short-lived linking sessions, OAuth state and PKCE values, requested scopes, timestamps, error and diagnostic information, and limited request metadata such as an IP-derived rate-limit counter held in memory.</li>
</ul>
<p>The Service does not request or store your Google password. It does not request or store a member’s Google email address. Member Google OAuth tokens are discarded after the selected YouTube channel is identified. A participating creator’s Google refresh token is retained in encrypted form so scheduled membership checks can run.</p>
<h2>2. How information is used</h2>
<p>Information is used to operate Discord commands; award and audit Blood Money and REP; run games, heists, leaderboards, and resets; prevent abuse and duplicate reward farming; enforce server rules and preemptive bans; create moderation records; verify YouTube channel membership; assign or remove mapped Discord roles; provide grace periods; diagnose failures; secure the Service; and maintain backups.</p>
<h2>3. Google API data</h2>
<p>MemberBridge requests only the Google/YouTube access shown on the OAuth consent screen. Member authorization is used to identify the YouTube channel selected by that member. Creator authorization is used to access the creator’s official YouTube membership and membership-level endpoints for verification. Information received through Google APIs is handled in accordance with the Google API Services User Data Policy, including its Limited Use requirements. It is not used for advertising or sold.</p>
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
    constructor({ store, youtube, engine, config, onLinked }) {
        this.store = store;
        this.youtube = youtube;
        this.engine = engine;
        this.config = config;
        this.onLinked = onLinked;
        this.server = null;
        this.startedUtc = null;
        this.rate = new Map();
    }

    get baseUrl() { return String(this.config.publicBaseUrl || '').replace(/\/$/, ''); }
    get secure() { return this.baseUrl.startsWith('https://'); }

    memberUrl(token) { return `${this.baseUrl}/connect/${encodeURIComponent(token)}`; }

    creatorAuthorizationUrl(creatorId) {
        const state = randomToken();
        const proof = pkce();
        this.store.createCreatorOAuthSession(creatorId, state, proof.verifier, new Date(Date.now() + 10 * 60000).toISOString());
        return this.youtube.authorizationUrl({ kind: 'creator', state, challenge: proof.challenge });
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

        const connect = url.pathname.match(/^\/connect\/([^/]+)$/);
        if (req.method === 'GET' && connect) {
            const token = decodeURIComponent(connect[1]);
            const session = this.store.findLinkSession(token);
            if (!this.validSession(session)) return send(res, 410, page('Link expired', '<p>This single-use link has expired or was already used. Run <b>/membership-link</b> again in Discord.</p>'));
            return send(res, 200, page('Connect YouTube membership', `<p>First, Discord confirms that you are <b>${escapeHtml(session.discord_username || session.discord_user_id)}</b>. Then Google lets you choose the YouTube channel identity to link. Your Google password is never shared with The Commission.</p><p class="warning">Connecting your identity does not give this server access to private Google data. The creator separately authorizes YouTube's official membership endpoint.</p><a class="button" href="/oauth/discord/start?token=${encodeURIComponent(token)}">Confirm Discord and continue</a>`));
        }

        if (req.method === 'GET' && url.pathname === '/oauth/discord/start') {
            const token = url.searchParams.get('token') || '';
            const session = this.store.findLinkSession(token);
            if (!this.validSession(session)) return send(res, 410, page('Link expired', '<p>Run <b>/membership-link</b> again.</p>'));
            if (!this.config.discordApplicationId || !this.config.discordClientSecret) throw new Error('The owner must save the Discord application ID and OAuth client secret in MemberBridge settings.');
            const state = randomToken();
            this.store.updateLinkSession(session.id, { state_hash: sha256(state) });
            const params = new URLSearchParams({ response_type: 'code', client_id: this.config.discordApplicationId, scope: 'identify', state, redirect_uri: `${this.baseUrl}/oauth/discord/callback`, prompt: 'consent' });
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
            const proof = pkce();
            const googleState = randomToken();
            this.store.updateLinkSession(session.id, { discord_confirmed: 1, google_state_hash: sha256(googleState), pkce_verifier: proof.verifier });
            return redirect(res, this.youtube.authorizationUrl({ kind: 'member', state: googleState, challenge: proof.challenge }));
        }

        if (req.method === 'GET' && url.pathname === '/oauth/google/start') {
            const token = cookie(req, 'mb_session');
            const session = this.store.findLinkSession(token);
            if (!this.validSession(session) || !session.discord_confirmed) return send(res, 403, page('Discord confirmation required', '<p>Start again from the private link Discord gave you.</p>'));
            const proof = pkce(); const state = randomToken();
            this.store.updateLinkSession(session.id, { google_state_hash: sha256(state), pkce_verifier: proof.verifier });
            return redirect(res, this.youtube.authorizationUrl({ kind: 'member', state, challenge: proof.challenge }));
        }

        if (req.method === 'GET' && url.pathname === '/oauth/google/callback') {
            const state = url.searchParams.get('state') || '';
            const code = url.searchParams.get('code') || '';
            const session = this.store.findLinkSessionByState(state, 'google');
            if (!this.validSession(session) || !session.discord_confirmed || !code) return send(res, 400, page('YouTube connection failed', '<p class="error">The Google OAuth state was invalid or expired.</p>'));
            this.store.updateLinkSession(session.id, { google_state_hash: null });
            const tokens = await this.youtube.exchangeCode({ code, verifier: session.pkce_verifier, kind: 'member' });
            const channels = await this.youtube.channelsMine(tokens.access_token);
            if (!channels.length) return send(res, 400, page('No YouTube channel found', '<p>This Google account did not return a YouTube channel identity. Create/select a YouTube channel and try again.</p>'));
            if (channels.length === 1) return this.finishMemberLink(res, session, channels[0]);
            const csrf = randomToken();
            const choices = channels.map(channel => ({ id: channel.id, title: channel.snippet?.title || channel.id, image: channel.snippet?.thumbnails?.default?.url || '' }));
            this.store.updateLinkSession(session.id, { channel_choices_json: JSON.stringify({ csrfHash: sha256(csrf), channels: choices }) });
            const options = choices.map(channel => `<option value="${escapeHtml(channel.id)}">${escapeHtml(channel.title)} · ${escapeHtml(channel.id)}</option>`).join('');
            return send(res, 200, page('Choose a YouTube identity', `<p>This Google account controls more than one YouTube identity. Select the permanent channel to link.</p><form method="post" action="/link/select"><input type="hidden" name="session" value="${session.id}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><select name="channelId" required>${options}</select><button type="submit">Link selected channel</button></form>`));
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
            if (!tokens.refresh_token) throw new Error('Google did not return a creator refresh token. Reconnect and approve consent.');
            const channels = await this.youtube.channelsMine(tokens.access_token);
            if (channels.length !== 1) throw new Error(`Expected one authorized creator channel, but Google returned ${channels.length}.`);
            const levels = await this.youtube.membershipLevels(tokens.access_token);
            await this.youtube.members(tokens.access_token, [channels[0].id]);
            this.store.saveCreatorAuthorization(oauth.creator_source_id, channels[0], tokens.refresh_token, tokens.scope || '');
            this.store.saveLevels(oauth.creator_source_id, levels);
            this.store.audit('Creator authorization connected', `Connected creator ${channels[0].snippet?.title || channels[0].id} and verified both membership endpoints.`, { severity: 'success', creatorSourceId: oauth.creator_source_id });
            return send(res, 200, page('Creator connected', `<p class="ok">The creator channel <b>${escapeHtml(channels[0].snippet?.title || channels[0].id)}</b> is authorized. YouTube returned ${levels.length} membership level(s). Return to The Commission to map each level to a Discord role.</p>`));
        }

        return send(res, 404, page('Not found', '<p>The requested MemberBridge page does not exist.</p>'));
    }

    async finishMemberLink(res, session, channel) {
        const link = this.store.linkAccount({ guildId: session.discord_guild_id, discordUserId: session.discord_user_id, discordUsername: session.discord_username, youtubeChannelId: channel.id, youtubeDisplayName: channel.snippet?.title || channel.id, youtubeProfileImage: channel.snippet?.thumbnails?.default?.url || '' });
        this.store.updateLinkSession(session.id, { used_utc: now(), channel_choices_json: null });
        this.store.audit('Account link completed', `Linked Discord ${session.discord_user_id} to YouTube channel ${channel.id}.`, { severity: 'success', guildId: session.discord_guild_id, discordUserId: session.discord_user_id });
        if (this.onLinked) setImmediate(() => this.onLinked(link).catch(error => console.error('[MemberBridge immediate verification]', error)));
        return send(res, 200, page('YouTube account linked', `<p class="ok"><b>${escapeHtml(channel.snippet?.title || channel.id)}</b> is now linked to your Discord account. Verification has been queued for every enabled creator.</p>`));
    }
}

module.exports = { MemberBridgeWeb, escapeHtml, page };
