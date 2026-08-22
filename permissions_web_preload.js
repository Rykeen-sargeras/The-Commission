'use strict';

const http = require('http');
const crypto = require('crypto');
const childProcess = require('child_process');
const path = require('path');

const BRIDGE_CHANNEL = 'commission:permissions-request';
const dashboardPassword = String(process.env.WEB_DASHBOARD_PASSWORD || '');
const cookieSecret = crypto.createHash('sha256').update(`${dashboardPassword}|${process.env.DISCORD_TOKEN || ''}|commission-permissions-v1`).digest();
const authToken = crypto.createHmac('sha256', cookieSecret).update('permission-editor').digest('hex');
let discordChild = null;
const pending = new Map();

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key) out[key] = decodeURIComponent(rest.join('='));
  }
  return out;
}

function authed(req) {
  const token = cookies(req).commission_permissions;
  return Boolean(token && safeEqual(token, authToken));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 2_000_000) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function json(res, status, value) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, ...headers });
  res.end();
}

function childRequest(action, payload = {}, timeoutMs = 30000) {
  if (!discordChild?.connected) return Promise.reject(new Error('The Commission bot is not running.'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${action} timed out.`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    discordChild.send({ channel: BRIDGE_CHANNEL, id, action, payload });
  });
}

function attachChild(child) {
  discordChild = child;
  child.on('message', message => {
    if (!message?.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.ok) request.resolve(message.data);
    else request.reject(new Error(message.error || 'Permission operation failed.'));
  });
  child.once('exit', () => {
    if (discordChild === child) discordChild = null;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('The Commission bot stopped.'));
    }
    pending.clear();
  });
}

function loginPage(error = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Permission Editor — The Commission</title><style>
  :root{color-scheme:dark;--bg:#08090b;--panel:#12151a;--line:#2c3038;--text:#f3f0e9;--muted:#969ba5;--red:#b21f38;--gold:#c7a86b}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 80% -10%,rgba(178,31,56,.22),transparent 35%),var(--bg);color:var(--text);font-family:Segoe UI,Inter,system-ui,sans-serif}.card{width:min(430px,100%);padding:38px;border:1px solid var(--line);border-radius:20px;background:linear-gradient(145deg,#181b21,#0d0f12);box-shadow:0 25px 80px #0009}.seal{width:76px;height:76px;border:1px solid #555b65;border-radius:50%;display:grid;place-items:center;margin:0 auto 18px;font:900 25px Georgia,serif}.eyebrow{color:var(--gold);font-size:11px;letter-spacing:.16em;text-transform:uppercase;text-align:center;font-weight:800}h1{text-align:center;font:700 31px Georgia,serif;margin:8px 0}p{color:var(--muted);line-height:1.55;text-align:center}input,button{width:100%;padding:12px;border-radius:9px;font:inherit}input{background:#090b0e;color:white;border:1px solid var(--line)}button{margin-top:10px;border:0;background:linear-gradient(135deg,var(--red),#86152a);color:#fff;font-weight:800;cursor:pointer}.error{color:#ff8798}</style></head><body><form class="card" method="post" action="/permissions/login"><div class="seal">TC</div><div class="eyebrow">Channel access control</div><h1>Permission Editor</h1><p>Use the same password as The Commission Railway control room.</p>${error ? `<p class="error">${String(error).replace(/[&<>]/g, '')}</p>` : ''}<input name="password" type="password" placeholder="Dashboard password" required autofocus><button>Open Permission Editor</button></form></body></html>`;
}

function editorPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Permission Editor — The Commission</title><style>
  :root{color-scheme:dark;--bg:#07080a;--panel:#111318;--panel2:#171a20;--line:#2c3038;--text:#f1eee7;--muted:#9297a1;--red:#b21f38;--red2:#d52e4a;--gold:#c7a86b;--green:#4bb886;--amber:#d29b4b}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 88% -8%,rgba(178,31,56,.22),transparent 32%),var(--bg);color:var(--text);font-family:Segoe UI,Inter,system-ui,sans-serif}.wrap{max-width:1800px;margin:auto;padding:24px}.top{display:flex;justify-content:space-between;gap:18px;align-items:center;margin-bottom:20px}.brand{display:flex;gap:12px;align-items:center}.seal{width:50px;height:50px;border:1px solid #555b65;border-radius:50%;display:grid;place-items:center;font:900 18px Georgia,serif}.eyebrow{color:var(--gold);font-size:10px;letter-spacing:.16em;text-transform:uppercase;font-weight:800}h1{font:700 clamp(26px,4vw,40px) Georgia,serif;margin:3px 0}.muted{color:var(--muted)}.toolbar{display:grid;grid-template-columns:minmax(220px,1fr) minmax(220px,1fr) minmax(240px,1.2fr) auto;gap:10px;align-items:end;padding:16px;border:1px solid var(--line);border-radius:14px;background:var(--panel);position:sticky;top:0;z-index:20}.field{display:grid;gap:6px}.field span{font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:#b3b7bf;font-weight:800}select,input[type=search]{width:100%;padding:10px 11px;border:1px solid #343943;border-radius:8px;background:#0a0c0f;color:white}.btn{border:1px solid transparent;border-radius:8px;padding:10px 14px;background:linear-gradient(135deg,var(--red),#86152a);color:white;font-weight:800;cursor:pointer;white-space:nowrap}.btn:disabled{opacity:.45;cursor:not-allowed}.ghost{background:#20242a;border-color:#383d46}.status{margin:12px 0;color:var(--muted);font-size:13px}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:14px;background:#0c0e11;max-height:calc(100vh - 230px)}table{border-collapse:separate;border-spacing:0;min-width:2100px;width:100%}th,td{border-bottom:1px solid #242830;border-right:1px solid #20242a;padding:9px 7px;text-align:center}th{position:sticky;top:0;z-index:8;background:#171a20;color:#d7d3cb;font-size:10px;text-transform:uppercase;letter-spacing:.04em}th:first-child,td:first-child{position:sticky;left:0;z-index:7;background:#111318;text-align:left;min-width:250px;max-width:250px}th:first-child{z-index:10;background:#171a20}.channel{display:flex;gap:8px;align-items:center}.kind{display:inline-block;font-size:9px;padding:3px 6px;border-radius:999px;border:1px solid #3a3f48;color:#aeb3bc}.channel-name{font-weight:750;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.child-channel .channel{padding-left:22px}.child-channel .channel:before{content:'↳';color:#5d626c;margin-right:-2px}.check{width:18px;height:18px;accent-color:var(--red2);cursor:pointer}.inherited{outline:1px dashed #555b65;outline-offset:2px}.changed{background:rgba(178,31,56,.13)}.category td{background:#15181d;border-top:3px solid #08090b}.category td:first-child{background:#1a1d22}.category .channel-name{color:var(--gold);font-size:13px;text-transform:uppercase;letter-spacing:.06em}.category .kind{border-color:#67593e;color:#d5ba7e}.uncategorized-label td{background:#0b0d10;border-top:3px solid #08090b;padding:7px 10px;color:#707680;font-size:10px;text-transform:uppercase;letter-spacing:.11em;font-weight:800;text-align:left}.uncategorized-label td:first-child{background:#0b0d10}.footer{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:15px 0}.dirty{color:var(--amber);font-weight:800}.ok{color:var(--green);font-weight:800}@media(max-width:900px){.toolbar{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column}.table-wrap{max-height:none}}</style></head><body><main class="wrap"><div class="top"><div class="brand"><div class="seal">TC</div><div><div class="eyebrow">The Commission</div><h1>Channel Permission Editor</h1><div class="muted">Channels are grouped exactly under their Discord categories. Pick a role, click permissions, then push only the changes you made.</div></div></div><div><a href="/" class="btn ghost" style="text-decoration:none;display:inline-block">Control Room</a> <form method="post" action="/permissions/logout" style="display:inline"><button class="btn ghost">Lock</button></form></div></div><section class="toolbar"><label class="field"><span>Server</span><select id="guild"><option>Loading…</option></select></label><label class="field"><span>Role</span><select id="role" disabled><option>Select server first</option></select></label><label class="field"><span>Find channel</span><input id="search" type="search" placeholder="Search channels or categories…"></label><button id="reload" class="btn ghost">Refresh</button></section><div id="status" class="status">Connecting to Discord…</div><div class="table-wrap"><table><thead id="head"></thead><tbody id="rows"></tbody></table></div><div class="footer"><div id="dirtyText" class="muted">No changes pending.</div><button id="push" class="btn" disabled>Push Changes</button></div></main><script>
  const guildEl=document.getElementById('guild'),roleEl=document.getElementById('role'),rowsEl=document.getElementById('rows'),headEl=document.getElementById('head'),statusEl=document.getElementById('status'),pushEl=document.getElementById('push'),dirtyText=document.getElementById('dirtyText'),searchEl=document.getElementById('search');
  let info=null,state=null,dirty=new Map(),pushQueue=Promise.resolve(),queuedPushes=0;
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function api(url,opt={}){const r=await fetch(url,{...opt,headers:{'Content-Type':'application/json',...(opt.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Request failed');return d;}
  function setStatus(text,good=false){statusEl.textContent=text;statusEl.className='status '+(good?'ok':'');}
  function dirtyKey(channelId,permission){return channelId+'|'+permission;}
  function updateDirty(){pushEl.disabled=!dirty.size;const pendingText=dirty.size?dirty.size+' permission change'+(dirty.size===1?'':'s')+' pending':'No changes pending';const queueText=queuedPushes?' · '+queuedPushes+' update batch'+(queuedPushes===1?'':'es')+' syncing in background':'';dirtyText.textContent=pendingText+queueText+'.';dirtyText.className=dirty.size||queuedPushes?'dirty':'muted';}
  function applyBatchLocally(changes){if(!state)return;const rows=new Map(state.channels.map(c=>[c.id,c]));for(const change of changes){const row=rows.get(change.channelId);const perm=row?.permissions?.[change.permission];if(!perm)continue;perm.allowed=Boolean(change.value);perm.explicit=change.value?'allow':'deny';}}
  async function loadGuilds(){try{const guilds=await api('/api/permissions/guilds');guildEl.innerHTML='<option value="">Choose a server</option>'+guilds.map(g=>'<option value="'+g.id+'">'+esc(g.name)+'</option>').join('');if(guilds.length===1){guildEl.value=guilds[0].id;await loadGuild();}setStatus('Ready.',true);}catch(e){setStatus(e.message);guildEl.innerHTML='<option>Bot offline</option>';}}
  async function loadGuild(){if(dirty.size&&!confirm('Discard your unpushed permission changes?')){return;}dirty.clear();updateDirty();const guildId=guildEl.value;if(!guildId)return;roleEl.disabled=true;setStatus('Loading roles, categories and channels…');try{info=await api('/api/permissions/guild?guildId='+encodeURIComponent(guildId));roleEl.innerHTML='<option value="">Choose a role</option>'+info.roles.map(r=>'<option value="'+r.id+'">'+esc(r.name)+(r.managed?' [managed]':'')+'</option>').join('');roleEl.disabled=false;headEl.innerHTML='<tr><th>Discord Category / Channel</th>'+info.permissions.map(p=>'<th title="'+esc(p.key)+'">'+esc(p.label)+'</th>').join('')+'</tr>';rowsEl.innerHTML='';setStatus(info.channels.length+' channels · '+info.roles.length+' roles loaded.',true);}catch(e){setStatus(e.message);}}
  async function loadRole(){if(dirty.size&&!confirm('Discard your unpushed permission changes?')){return;}dirty.clear();updateDirty();const roleId=roleEl.value;if(!roleId||!info)return;setStatus('Loading permission state…');try{state=await api('/api/permissions/role-state?guildId='+encodeURIComponent(guildEl.value)+'&roleId='+encodeURIComponent(roleId));renderRows();setStatus(queuedPushes?'Loaded. '+queuedPushes+' earlier update batch'+(queuedPushes===1?' is':'es are')+' still syncing in the background.':'Category checkboxes apply to every channel underneath. You can still override individual channels before pushing.',true);}catch(e){setStatus(e.message);}}
  function renderRows(){
    const stateMap=new Map(state.channels.map(c=>[c.id,c.permissions]));
    const q=searchEl.value.trim().toLowerCase();
    const categories=info.channels.filter(c=>c.typeLabel==='Category').sort((a,b)=>a.position-b.position||a.name.localeCompare(b.name));
    const regular=info.channels.filter(c=>c.typeLabel!=='Category');
    const matches=c=>!q||c.name.toLowerCase().includes(q)||c.typeLabel.toLowerCase().includes(q);
    const rowHtml=(c,child=false)=>{const perms=stateMap.get(c.id)||{};return '<tr class="'+(c.typeLabel==='Category'?'category':(child?'child-channel':''))+'"><td><div class="channel"><span class="kind">'+esc(c.typeLabel)+'</span><span class="channel-name">'+esc(c.name)+'</span></div></td>'+info.permissions.map(p=>{const s=perms[p.key]||{allowed:false,explicit:'inherit'};const pendingChange=dirty.get(dirtyKey(c.id,p.key));const allowed=pendingChange?pendingChange.value:s.allowed;const inherited=!pendingChange&&s.explicit==='inherit';return '<td data-cell="'+c.id+'|'+p.key+'" class="'+(pendingChange?'changed':'')+'"><input class="check '+(inherited?'inherited':'')+'" type="checkbox" '+(allowed?'checked':'')+' data-channel="'+c.id+'" data-perm="'+p.key+'" title="'+esc(pendingChange?'pending change':s.explicit)+'"></td>';}).join('')+'</tr>';};
    let html='';
    const uncategorized=regular.filter(c=>!c.parentId&&matches(c));
    if(uncategorized.length){html+='<tr class="uncategorized-label"><td colspan="'+(info.permissions.length+1)+'">Uncategorized Channels</td></tr>'+uncategorized.sort((a,b)=>a.position-b.position||a.name.localeCompare(b.name)).map(c=>rowHtml(c,false)).join('');}
    for(const category of categories){
      const children=regular.filter(c=>c.parentId===category.id).sort((a,b)=>a.position-b.position||a.name.localeCompare(b.name));
      const categoryMatches=matches(category);
      const visibleChildren=categoryMatches&&!q?children:children.filter(matches);
      if(q&&!categoryMatches&&!visibleChildren.length)continue;
      html+=rowHtml(category,false);
      const rows=q&&categoryMatches?children:visibleChildren;
      html+=rows.map(c=>rowHtml(c,true)).join('');
    }
    rowsEl.innerHTML=html||'<tr><td colspan="'+(info.permissions.length+1)+'" style="padding:28px;color:#777;text-align:center">No matching channels.</td></tr>';
    document.querySelectorAll('.check').forEach(box=>box.onchange=()=>{
      const channel=info.channels.find(c=>c.id===box.dataset.channel);
      const permission=box.dataset.perm;
      const value=box.checked;
      const setPending=(channelId,checked)=>{
        const key=dirtyKey(channelId,permission);
        dirty.set(key,{channelId,permission,value:checked});
        const visible=document.querySelector('.check[data-channel="'+channelId+'"][data-perm="'+permission+'"]');
        if(visible){visible.checked=checked;visible.classList.remove('inherited');visible.closest('td')?.classList.add('changed');}
      };
      setPending(box.dataset.channel,value);
      if(channel?.typeLabel==='Category'){
        info.channels.filter(c=>c.parentId===channel.id).forEach(child=>setPending(child.id,value));
        setStatus((value?'Enabled ':'Disabled ')+permission+' for '+channel.name+' and all channels underneath. Individual channel overrides are still allowed.',true);
      }
      updateDirty();
    });
  }
  function push(){
    if(!dirty.size||!info)return;
    const batch=[...dirty.values()];
    const payload={guildId:guildEl.value,roleId:roleEl.value,changes:batch};
    if(!confirm('Push '+batch.length+' permission change'+(batch.length===1?'':'s')+' to Discord now? You can keep editing while it syncs.'))return;
    dirty.clear();
    applyBatchLocally(batch);
    queuedPushes++;
    updateDirty();
    renderRows();
    setStatus('Queued '+batch.length+' permission change'+(batch.length===1?'':'s')+'. Keep editing — this batch will sync in the background.',true);
    pushQueue=pushQueue
      .then(()=>api('/api/permissions/push',{method:'POST',body:JSON.stringify(payload)}))
      .then(d=>setStatus('Discord confirmed '+d.changedPermissions+' permissions across '+d.changedChannels+' channels for '+(d.roleNames?.join(', ')||d.changedRoles+' role'+(d.changedRoles===1?'':'s'))+'.',true))
      .catch(e=>setStatus('Background permission update failed: '+e.message))
      .finally(()=>{queuedPushes=Math.max(0,queuedPushes-1);updateDirty();});
  }
  guildEl.onchange=loadGuild;roleEl.onchange=loadRole;searchEl.oninput=()=>{if(state)renderRows();};document.getElementById('reload').onclick=()=>{if(guildEl.value)loadGuild();else loadGuilds();};pushEl.onclick=push;window.addEventListener('beforeunload',e=>{if(dirty.size||queuedPushes){e.preventDefault();e.returnValue='';}});loadGuilds();
  </script></body></html>`;
}

const originalFork = childProcess.fork;
childProcess.fork = function patchedPermissionsFork(modulePath, args, options) {
  const child = originalFork.call(childProcess, modulePath, args, options);
  const base = path.basename(String(modulePath));
  if (base === 'discord_bootstrap.js' || base === 'discord_bot.js') attachChild(child);
  return child;
};

const originalCreateServer = http.createServer;
http.createServer = function patchedPermissionsServer(...args) {
  const listenerIndex = typeof args[0] === 'function' ? 0 : (typeof args[1] === 'function' ? 1 : -1);
  if (listenerIndex < 0) return originalCreateServer.apply(http, args);
  const listener = args[listenerIndex];
  args[listenerIndex] = async function permissionRoutes(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname === '/permissions/login' && req.method === 'POST') {
        const raw = await readBody(req);
        const supplied = new URLSearchParams(raw).get('password') || '';
        if (!dashboardPassword) return send(res, 500, 'text/html; charset=utf-8', loginPage('WEB_DASHBOARD_PASSWORD is not configured.'));
        if (!safeEqual(supplied, dashboardPassword)) return send(res, 401, 'text/html; charset=utf-8', loginPage('Wrong password.'));
        return redirect(res, '/permissions', { 'Set-Cookie': `commission_permissions=${authToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200` });
      }
      if (url.pathname === '/permissions/logout' && req.method === 'POST') {
        return redirect(res, '/permissions', { 'Set-Cookie': 'commission_permissions=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
      }
      if ((url.pathname === '/permissions' || url.pathname === '/permission-editor') && req.method === 'GET') {
        return send(res, 200, 'text/html; charset=utf-8', authed(req) ? editorPage() : loginPage());
      }
      if (url.pathname.startsWith('/api/permissions/')) {
        if (!authed(req)) return json(res, 401, { error: 'Not authenticated' });
        if (url.pathname === '/api/permissions/guilds' && req.method === 'GET') return json(res, 200, await childRequest('list-guilds'));
        if (url.pathname === '/api/permissions/guild' && req.method === 'GET') return json(res, 200, await childRequest('guild-info', { guildId: url.searchParams.get('guildId') || '' }));
        if (url.pathname === '/api/permissions/role-state' && req.method === 'GET') return json(res, 200, await childRequest('role-state', { guildId: url.searchParams.get('guildId') || '', roleId: url.searchParams.get('roleId') || '' }));
        if (url.pathname === '/api/permissions/push' && req.method === 'POST') {
          const payload = JSON.parse(await readBody(req) || '{}');
          return json(res, 200, await childRequest('push', payload, 120000));
        }
        return json(res, 404, { error: 'Permission editor endpoint not found' });
      }
      return listener(req, res);
    } catch (error) {
      if (!res.headersSent) return json(res, 500, { error: error?.message || String(error) });
      res.end();
    }
  };
  return originalCreateServer.apply(http, args);
};
