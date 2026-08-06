'use strict';

const http = require('http');
const { pkce, randomToken, sha256 } = require('./crypto');
const { now } = require('./store');

function escapeHtml(value) {
    return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
}

function page(title, body, options = {}) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · The Commission</title><style>
    :root{color-scheme:dark;font-family:Inter,Segoe UI,sans-serif;background:#090b10;color:#f4f1e8}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at top,#2b1520,#090b10 56%)}main{width:min(620px,calc(100% - 40px));background:#11141b;border:1px solid #313640;border-radius:18px;padding:32px;box-shadow:0 28px 80px #0009}h1{font-family:Georgia,serif;font-size:34px;margin:8px 0 12px}.eyebrow{color:#d4ad61;text-transform:uppercase;letter-spacing:.16em;font-size:12px;font-weight:800}p{color:#b7bdc8;line-height:1.6}.button,button{display:inline-block;border:0;border-radius:10px;padding:13px 18px;background:#b8203b;color:white;text-decoration:none;font-weight:750;cursor:pointer}select{width:100%;box-sizing:border-box;background:#090c11;color:#fff;border:1px solid #3a414c;border-radius:10px;padding:12px;margin:10px 0 18px}.warning{padding:12px;border-left:3px solid #d4ad61;background:#1d1920;color:#dfd6c2}.ok{color:#79d6a5}.error{color:#ff7c8f}small{display:block;color:#858d9a;margin-top:18px}</style></head><body><main><div class="eyebrow">The Commission · MemberBridge</div><h1>${escapeHtml(title)}</h1>${body}${options.footer === false ? '' : '<small>You can close this page and return to Discord when finished.</small>'}</main></body></html>`;
}

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
        if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, JSON.stringify({ status: this.server ? 'Healthy' : 'Unhealthy', database: this.store.integrityCheck(), startedUtc: this.startedUtc }), 'application/json; charset=utf-8');
        if (req.method === 'GET' && url.pathname === '/privacy') return send(res, 200, page('Privacy', '<p>MemberBridge stores your Discord user ID, the permanent YouTube channel ID you select, display-name snapshots, membership status, mapped roles, verification history, and grace-period dates. It does not store your Google password or email address. Member identity OAuth tokens are discarded after your channel is identified.</p><p>Use <b>/membership-unlink</b> in Discord to disconnect your account.</p>'));
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
