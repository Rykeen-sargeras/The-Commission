'use strict';

const { MembershipStore, signState, verifyState } = require('./membership_store');
const { exchangeGoogleCode, creatorChannel, membershipLevels } = require('./membership_youtube');

function esc(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function send(res, status, type, body, headers = {}) { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers }); res.end(body); }
function json(res, status, value) { send(res, status, 'application/json; charset=utf-8', JSON.stringify(value)); }
function redirect(res, location) { res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' }); res.end(); }
function readBody(req) { return new Promise((resolve, reject) => { let raw = ''; req.on('data', chunk => { raw += chunk; if (raw.length > 1_000_000) { reject(new Error('Request too large.')); req.destroy(); } }); req.on('end', () => resolve(raw)); req.on('error', reject); }); }

function messagePage(title, message, good = false) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:radial-gradient(circle at 80% 0,#49101b,#08090b 42%);font-family:Segoe UI,system-ui;color:#f4f0e8}.card{width:min(560px,100%);padding:34px;border:1px solid #30343d;border-radius:18px;background:#12151a;box-shadow:0 25px 80px #0009}.mark{width:60px;height:60px;border:1px solid #555;border-radius:50%;display:grid;place-items:center;font:900 22px Georgia;margin-bottom:18px}.good{color:#61d49e}.bad{color:#ff8a98}p{color:#b8bbc2;line-height:1.6}</style></head><body><main class="card"><div class="mark">TC</div><h1 class="${good ? 'good' : 'bad'}">${esc(title)}</h1><p>${esc(message)}</p><p>You can close this window and return to Discord.</p></main></body></html>`;
}

async function discordExchange(code, redirectUri, cfg, fetchImpl) {
    const response = await fetchImpl('https://discord.com/api/v10/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: cfg.MEMBERSHIP_DISCORD_CLIENT_ID || cfg.DISCORD_APPLICATION_ID, client_secret: cfg.MEMBERSHIP_DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: redirectUri }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error_description || data.message || 'Discord authorization failed.');
    return data;
}

async function discordGet(path, accessToken, fetchImpl) {
    const response = await fetchImpl(`https://discord.com/api/v10${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || 'Discord could not read your connected accounts.');
    return data;
}

function adminPage() {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>YouTube Memberships · The Commission</title><style>:root{color-scheme:dark;--bg:#08090b;--panel:#12151a;--line:#2c3038;--text:#f1eee7;--muted:#969aa3;--red:#b21f38;--green:#4bb886}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 85% -10%,#42101a,transparent 32%),var(--bg);color:var(--text);font-family:Segoe UI,system-ui}.wrap{width:min(1160px,calc(100% - 30px));margin:auto;padding:25px 0 70px}header{display:flex;justify-content:space-between;gap:15px;align-items:center;margin-bottom:22px}a{color:#ef8798}.btn,button{border:0;border-radius:9px;padding:10px 14px;background:linear-gradient(135deg,var(--red),#86152a);color:#fff;font-weight:750;cursor:pointer}.secondary{background:#23272e;border:1px solid #3b4049}.danger{background:#681723}.panel,.card{border:1px solid var(--line);border-radius:14px;background:linear-gradient(145deg,#15181e,#0e1014);padding:20px;margin-bottom:15px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.fields{display:grid;grid-template-columns:2fr 2fr 1fr auto;gap:10px;align-items:end}label{display:grid;gap:6px;font-size:12px;color:#d2d0cb}input,select{width:100%;background:#090b0e;color:#fff;border:1px solid #343841;border-radius:8px;padding:10px}.head{display:flex;justify-content:space-between;gap:15px;align-items:start}.muted{color:var(--muted)}.status{font-size:12px;border:1px solid #354038;border-radius:999px;padding:5px 9px;color:#80d9ae}.bad{color:#ff8998}.tiers{display:grid;gap:8px;margin:14px 0}.tier{display:grid;grid-template-columns:1fr 2fr auto;gap:8px;align-items:center;padding-top:8px;border-top:1px solid #292d34}.buttons{display:flex;gap:7px;flex-wrap:wrap}.audit{font:12px/1.5 Consolas,monospace;border-top:1px solid #262a31;padding:7px 0}.empty{text-align:center;color:var(--muted);padding:25px}@media(max-width:800px){.grid,.fields{grid-template-columns:1fr}.tier{grid-template-columns:1fr}.head{display:block}.buttons{margin-top:10px}header{align-items:flex-start}}</style></head><body><main class="wrap"><header><div><small class="muted">THE COMMISSION CONTROL ROOM</small><h1>YouTube memberships</h1><p class="muted">Creators connect once. Members use <b>/verify</b> and their existing Discord YouTube connection.</p></div><a class="btn secondary" href="/">Back to dashboard</a></header><section class="panel"><h2>Add a supported streamer</h2><div class="fields"><label>Streamer / show name<input id="name" placeholder="Roxy"></label><label>YouTube channel ID (recommended)<input id="channel" placeholder="UC..."></label><label>Grace period (days)<input id="grace" type="number" min="0" max="365" value="7"></label><button id="add">Add streamer</button></div></section><section class="grid"><div class="card"><small class="muted">SUPPORTED STREAMERS</small><h2 id="streamerCount">—</h2></div><div class="card"><small class="muted">LINKED DISCORD MEMBERS</small><h2 id="memberCount">—</h2></div><div class="card"><small class="muted">LAST SYNC</small><h2 id="lastSync">—</h2></div></section><div id="streamers"></div><section class="panel"><div class="head"><div><h2>Recent activity</h2><p class="muted">Connections, role mappings, syncs, and errors.</p></div><button class="secondary" onclick="load()">Refresh</button></div><div id="audit"></div></section></main><script>
const h=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(url,opt={}){const r=await fetch(url,{...opt,headers:{'Content-Type':'application/json',...(opt.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Request failed');return d}
async function load(){try{const d=await api('/api/memberships');streamerCount.textContent=d.streamers.length;memberCount.textContent=d.linkCount;const dates=d.streamers.map(x=>x.lastSyncAt).filter(Boolean).sort();lastSync.textContent=dates.length?new Date(dates.at(-1)).toLocaleString():'Never';streamers.innerHTML=d.streamers.length?d.streamers.map(s=>card(s,d.roles)).join(''):'<div class="panel empty">Add the first supported streamer above.</div>';audit.innerHTML=d.audit.length?d.audit.map(a=>'<div class="audit"><b>'+h(a.event)+'</b> · '+new Date(a.at).toLocaleString()+'<br><span class="muted">'+h(a.details)+'</span></div>').join(''):'<p class="muted">No membership activity yet.</p>'}catch(e){alert(e.message)}}
function card(s,roles){const tierHtml=s.tiers.length?s.tiers.map(t=>'<div class="tier"><b>'+h(t.displayName)+'</b><select data-tier="'+h(t.youtubeLevelId)+'"><option value="">No Discord role</option>'+roles.map(r=>'<option value="'+r.id+'" '+(r.id===t.discordRoleId?'selected':'')+'>'+h(r.name)+'</option>').join('')+'</select><button onclick="mapTier(\\''+s.id+'\\',this)">Save role</button></div>').join(''):'<p class="muted">Tiers appear after the creator connects YouTube.</p>';return '<section class="panel" data-id="'+s.id+'"><div class="head"><div><h2>'+h(s.displayName)+'</h2><div class="'+(s.connected?'status':'bad')+'">'+(s.connected?'Connected: '+h(s.channelTitle||s.channelId):'Waiting for creator connection')+'</div><p class="muted">Grace period: '+s.graceDays+' days · '+(s.enabled?'sync enabled':'sync paused')+(s.lastError?'<br><span class="bad">'+h(s.lastError)+'</span>':'')+'</p></div><div class="buttons"><button onclick="invite(\\''+s.id+'\\')">Creator link</button><button class="secondary" onclick="syncOne(\\''+s.id+'\\')">Sync now</button><button class="secondary" onclick="edit(\\''+s.id+'\\','+s.graceDays+','+s.enabled+')">Edit</button><button class="danger" onclick="removeOne(\\''+s.id+'\\')">Delete</button></div></div><div class="tiers">'+tierHtml+'</div></section>'}
add.onclick=async()=>{try{await api('/api/memberships',{method:'POST',body:JSON.stringify({displayName:name.value,expectedChannelId:channel.value,graceDays:grace.value})});name.value='';channel.value='';await load()}catch(e){alert(e.message)}};
async function invite(id){try{const d=await api('/api/memberships/'+id+'/invite',{method:'POST'});prompt('Send this private one-time setup link to the streamer. It expires in 7 days:',d.url)}catch(e){alert(e.message)}}
async function syncOne(id){try{const d=await api('/api/memberships/'+id+'/sync',{method:'POST'});alert('Sync finished. Checked '+d.membersChecked+' linked members. Roles added: '+d.rolesAdded+'. Roles removed: '+d.rolesRemoved+'.'+(d.errors.length?'\\n'+d.errors.join('\\n'):''));load()}catch(e){alert(e.message)}}
async function mapTier(id,b){const row=b.closest('.tier');try{await api('/api/memberships/'+id+'/tier',{method:'POST',body:JSON.stringify({youtubeLevelId:row.querySelector('[data-tier]').dataset.tier,discordRoleId:row.querySelector('select').value})});alert('Role mapping saved.')}catch(e){alert(e.message)}}
async function edit(id,days,enabled){const grace=prompt('Grace period in days (0 removes roles on the first successful check after a lapse):',days);if(grace===null)return;try{await api('/api/memberships/'+id,{method:'PATCH',body:JSON.stringify({graceDays:Number(grace),enabled:confirm('Press OK to keep automatic syncing enabled. Press Cancel to pause this streamer.')})});load()}catch(e){alert(e.message)}}
async function removeOne(id){if(!confirm('Delete this streamer, tier mappings, and verification history? Discord roles are not changed by this deletion.'))return;try{await api('/api/memberships/'+id,{method:'DELETE'});load()}catch(e){alert(e.message)}}load();
</script></body></html>`;
}

class MembershipWeb {
    constructor(options = {}) { this.store = options.store || new MembershipStore({ dataDir: options.dataDir }); this.configProvider = options.configProvider || (() => process.env); this.botRequest = options.botRequest; this.fetch = options.fetch || fetch; }
    cfg() { return this.configProvider() || {}; }
    root(req) { const cfg = this.cfg(); return String(cfg.MEMBERSHIP_PUBLIC_BASE_URL || cfg.PUBLIC_BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host'] || req.headers.host}`)).replace(/\/$/, ''); }
    requireConfig(keys) { const cfg = this.cfg(); for (const key of keys) if (!String(cfg[key] || '').trim()) throw new Error(`${key} is not configured in the dashboard.`); return cfg; }

    async handle(req, res, url, isAuthed) {
        if (url.pathname === '/memberships' && req.method === 'GET') { if (!isAuthed) return false; send(res, 200, 'text/html; charset=utf-8', adminPage()); return true; }
        if (url.pathname.startsWith('/api/memberships')) { if (!isAuthed) { json(res, 401, { error: 'Not authenticated' }); return true; } await this.handleApi(req, res, url); return true; }
        const connect = url.pathname.match(/^\/membership\/connect\/([^/]+)$/);
        if (connect && req.method === 'GET') {
            const cfg = this.requireConfig(['MEMBERSHIP_GOOGLE_CLIENT_ID', 'MEMBERSHIP_GOOGLE_CLIENT_SECRET', 'MEMBERSHIP_ENCRYPTION_KEY']);
            const invite = verifyState(url.searchParams.get('invite'), cfg, 'creator-invite');
            if (invite.streamerId !== connect[1]) throw new Error('This creator link does not match the selected streamer.');
            this.store.consumeInvite(invite.streamerId, invite.nonce);
            const state = signState({ purpose: 'google-state', streamerId: invite.streamerId }, cfg, 900);
            const redirectUri = `${this.root(req)}/membership/google/callback`;
            const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
            auth.search = new URLSearchParams({
                client_id: cfg.MEMBERSHIP_GOOGLE_CLIENT_ID,
                redirect_uri: redirectUri,
                response_type: 'code',
                access_type: 'offline',
                prompt: 'consent',
                state,
                scope: [
                    'https://www.googleapis.com/auth/youtube.channel-memberships.creator',
                    'https://www.googleapis.com/auth/youtube.readonly',
                ].join(' '),
            }).toString();
            redirect(res, auth.toString()); return true;
        }
        if (url.pathname === '/membership/google/callback' && req.method === 'GET') {
            try {
                const cfg = this.requireConfig(['MEMBERSHIP_GOOGLE_CLIENT_ID', 'MEMBERSHIP_GOOGLE_CLIENT_SECRET', 'MEMBERSHIP_ENCRYPTION_KEY']);
                const state = verifyState(url.searchParams.get('state'), cfg, 'google-state');
                if (url.searchParams.get('error')) throw new Error('YouTube connection was cancelled.');
                const redirectUri = `${this.root(req)}/membership/google/callback`;
                const tokens = await exchangeGoogleCode(url.searchParams.get('code'), redirectUri, cfg, this.fetch);
                const streamer = this.store.getStreamer(state.streamerId);
                const [channel, tiers] = await Promise.all([
                    creatorChannel(tokens.access_token, this.fetch),
                    membershipLevels(tokens.access_token, this.fetch),
                ]);
                if (streamer?.expectedChannelId && channel.id !== streamer.expectedChannelId) {
                    throw new Error(`The selected Google account authorized ${channel.title} (${channel.id}), but this invitation is for ${streamer.expectedChannelId}. Select the correct creator channel and try again.`);
                }
                this.store.saveCreatorConnection(state.streamerId, channel, tokens, cfg.MEMBERSHIP_ENCRYPTION_KEY);
                this.store.replaceTiers(state.streamerId, tiers);
                send(res, 200, 'text/html; charset=utf-8', messagePage('YouTube connected', `${channel.title} is connected. The server owner can now map your membership tiers to Discord roles.`, true));
            } catch (error) { send(res, 400, 'text/html; charset=utf-8', messagePage('Connection failed', error.message)); }
            return true;
        }
        if (url.pathname === '/membership/verify' && req.method === 'GET') {
            const cfg = this.requireConfig(['MEMBERSHIP_DISCORD_CLIENT_SECRET', 'MEMBERSHIP_ENCRYPTION_KEY']);
            const incoming = verifyState(url.searchParams.get('token'), cfg, 'member-verify');
            const state = signState({ purpose: 'discord-state', discordUserId: incoming.discordUserId }, cfg, 900);
            const redirectUri = `${this.root(req)}/membership/discord/callback`;
            const auth = new URL('https://discord.com/oauth2/authorize');
            auth.search = new URLSearchParams({ client_id: cfg.MEMBERSHIP_DISCORD_CLIENT_ID || cfg.DISCORD_APPLICATION_ID, redirect_uri: redirectUri, response_type: 'code', scope: 'identify connections', state }).toString();
            redirect(res, auth.toString()); return true;
        }
        if (url.pathname === '/membership/discord/callback' && req.method === 'GET') {
            try {
                const cfg = this.requireConfig(['MEMBERSHIP_DISCORD_CLIENT_SECRET', 'MEMBERSHIP_ENCRYPTION_KEY']);
                const state = verifyState(url.searchParams.get('state'), cfg, 'discord-state');
                if (url.searchParams.get('error')) throw new Error('Discord verification was cancelled.');
                const redirectUri = `${this.root(req)}/membership/discord/callback`;
                const tokens = await discordExchange(url.searchParams.get('code'), redirectUri, cfg, this.fetch);
                const [user, connections] = await Promise.all([discordGet('/users/@me', tokens.access_token, this.fetch), discordGet('/users/@me/connections', tokens.access_token, this.fetch)]);
                if (user.id !== state.discordUserId) throw new Error('Please authorize with the same Discord account that ran /verify.');
                const youtube = connections.find(connection => connection.type === 'youtube' && connection.verified !== false);
                if (!youtube?.id) throw new Error('No verified YouTube connection was found. In Discord, open User Settings → Connections, connect YouTube, then run /verify again.');
                this.store.upsertLink(user.id, youtube.id, youtube.name || 'YouTube account');
                let syncNote = '';
                try { await this.botRequest?.('commission:membership-request', 'sync', { discordUserId: user.id }, 180000); } catch { syncNote = ' Your account is linked; roles will update during the next automatic sync.'; }
                send(res, 200, 'text/html; charset=utf-8', messagePage('Membership verified', `Discord found your connected YouTube account.${syncNote}`, true));
            } catch (error) { send(res, 400, 'text/html; charset=utf-8', messagePage('Verification failed', error.message)); }
            return true;
        }
        return false;
    }

    async handleApi(req, res, url) {
        const match = url.pathname.match(/^\/api\/memberships\/([^/]+)(?:\/(invite|sync|tier|disconnect))?$/);
        if (url.pathname === '/api/memberships' && req.method === 'GET') {
            let roles = []; try { roles = await this.botRequest?.('commission:membership-request', 'roles', {}, 20000) || []; } catch {}
            json(res, 200, { streamers: this.store.listStreamers(), linkCount: this.store.listLinks().length, statuses: this.store.listStatuses(), audit: this.store.auditRows(), roles }); return;
        }
        if (url.pathname === '/api/memberships' && req.method === 'POST') { json(res, 201, this.store.addStreamer(JSON.parse(await readBody(req) || '{}'))); return; }
        if (!match) { json(res, 404, { error: 'Membership route not found.' }); return; }
        const [, id, action] = match;
        if (!this.store.getStreamer(id)) { json(res, 404, { error: 'Streamer not found.' }); return; }
        if (!action && req.method === 'PATCH') { json(res, 200, this.store.updateStreamer(id, JSON.parse(await readBody(req) || '{}'))); return; }
        if (!action && req.method === 'DELETE') { this.store.deleteStreamer(id); json(res, 200, { ok: true }); return; }
        if (action === 'invite' && req.method === 'POST') { const nonce = require('crypto').randomBytes(24).toString('base64url'); this.store.createInvite(id, nonce); const token = signState({ purpose: 'creator-invite', streamerId: id, nonce }, this.cfg(), 7 * 86400); json(res, 200, { url: `${this.root(req)}/membership/connect/${id}?invite=${encodeURIComponent(token)}` }); return; }
        if (action === 'sync' && req.method === 'POST') { json(res, 200, await this.botRequest('commission:membership-request', 'sync', { streamerId: id }, 180000)); return; }
        if (action === 'tier' && req.method === 'POST') { const payload = JSON.parse(await readBody(req) || '{}'); this.store.mapTier(id, payload.youtubeLevelId, payload.discordRoleId); json(res, 200, { ok: true }); return; }
        if (action === 'disconnect' && req.method === 'POST') { this.store.disconnect(id); json(res, 200, { ok: true }); return; }
        json(res, 405, { error: 'Method not allowed.' });
    }
}

module.exports = { MembershipWeb, adminPage, messagePage, discordExchange };
