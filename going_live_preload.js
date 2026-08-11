'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const childProcess = require('child_process');
const {
  ZONE,
  RESET_HOUR,
  operationalDate,
  pruneForDailyReset,
  normalizeLink,
} = require('./going_live_time');

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const scheduleFile = path.join(dataDir, 'going-live-schedule.json');
const resetFile = path.join(dataDir, 'going-live-reset.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function dailyReset() {
  const now = new Date();
  const scheduleDate = operationalDate(now);
  const reset = readJson(resetFile, {});
  if (reset.lastReset === scheduleDate) return false;
  const store = readJson(scheduleFile, { entries: [], boardMessageId: '' });
  store.entries = pruneForDailyReset(store.entries, now);
  writeJson(scheduleFile, store);
  writeJson(resetFile, { lastReset: scheduleDate, resetAt: now.toISOString(), zone: ZONE });
  console.log(`[Going Live] Daily ${RESET_HOUR}:00 AM ET board reset completed for ${scheduleDate}.`);
  return true;
}

function scheduleEntries() {
  dailyReset();
  const store = readJson(scheduleFile, { entries: [] });
  return (store.entries || [])
    .filter(e => e.status === 'active')
    .sort((a, b) => `${a.date} ${a.hm} ${a.createdAt || ''}`.localeCompare(`${b.date} ${b.hm} ${b.createdAt || ''}`));
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function safeLink(value) {
  try { return normalizeLink(value); } catch { return ''; }
}

function schedulePage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Misfit Mafia — Going Live</title><style>
  :root{color-scheme:dark;--bg:#07080a;--panel:#111318;--line:#2d3037;--text:#f1eee7;--muted:#9a9ea6;--red:#b21f38;--silver:#c7c9ce;--gold:#c7a86b}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% -10%,rgba(178,31,56,.22),transparent 35%),#07080a;color:var(--text);font-family:Segoe UI,Inter,system-ui,sans-serif;min-height:100vh}.wrap{max-width:980px;margin:auto;padding:30px 18px 60px}.top{display:flex;justify-content:space-between;gap:18px;align-items:center;margin-bottom:28px}.brand{display:flex;align-items:center;gap:12px}.seal{width:52px;height:52px;border:1px solid #555;border-radius:50%;display:grid;place-items:center;font-family:Georgia,serif;font-weight:900;background:#0d0f12;box-shadow:inset 0 0 0 5px #15171b}.eyebrow{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--gold);font-weight:800}h1{font-family:Georgia,serif;margin:5px 0 0;font-size:clamp(30px,6vw,54px)}.sub{color:var(--muted);max-width:680px;line-height:1.55}.status{border:1px solid var(--line);border-radius:999px;padding:8px 12px;color:var(--silver);font-size:13px}.grid{display:grid;gap:12px;margin-top:24px}.day{border:1px solid var(--line);border-radius:17px;background:#111318;padding:18px}.day h2{margin:0 0 13px;font-size:17px;color:var(--silver)}.slot{display:grid;grid-template-columns:150px 1fr auto;gap:14px;align-items:center;padding:13px 0;border-top:1px solid #24272d}.slot:first-of-type{border-top:0}.time{font-weight:800;color:#fff}.who{font-weight:700}.title{color:var(--muted);font-size:14px;margin-top:3px}.watch{color:white;text-decoration:none;border:1px solid #79303a;background:#781828;border-radius:9px;padding:8px 11px;font-weight:700}.empty{padding:36px 20px;border:1px dashed #333842;border-radius:16px;text-align:center;color:var(--muted);margin-top:24px}.foot{margin-top:28px;color:#696e77;font-size:12px}.conflict{color:#e4b462;font-size:12px;margin-left:7px}@media(max-width:650px){.top{align-items:flex-start;flex-direction:column}.slot{grid-template-columns:1fr}.watch{width:max-content}}
  </style></head><body><main class="wrap"><div class="top"><div><div class="brand"><div class="seal">MM</div><div><div class="eyebrow">Misfit Mafia Schedule</div><h1>Who’s Going Live</h1></div></div><p class="sub">Upcoming community streams. All times are Eastern Time. The board rolls over automatically every day at 5:00 AM ET.</p></div><div class="status" id="updated">Loading schedule…</div></div><section id="schedule"></section><div class="foot">Schedule is managed through The Commission using /goinglive in Discord.</div></main><script>
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function render(data){const root=document.getElementById('schedule');document.getElementById('updated').textContent='Updated '+new Date(data.generatedAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});if(!data.entries.length){root.innerHTML='<div class="empty">No streams are scheduled yet. Use <b>/goinglive</b> in Discord to add one.</div>';return;}const groups={};for(const e of data.entries)(groups[e.date]??=[]).push(e);root.innerHTML='<div class="grid">'+Object.entries(groups).map(([date,rows])=>'<article class="day"><h2>'+esc(rows[0].prettyDate||date)+'</h2>'+rows.map((e,i)=>{const conflict=rows.some((x,j)=>i!==j&&x.hm===e.hm);return '<div class="slot"><div class="time">'+esc(e.displayTime)+' ET'+(conflict?'<span class="conflict">CONFLICT</span>':'')+'</div><div><div class="who">'+esc(e.username||'Streamer')+'</div><div class="title">'+esc(e.title||'Scheduled stream')+'</div></div>'+(e.link?'<a class="watch" href="'+esc(e.link)+'" target="_blank" rel="noopener">Watch</a>':'<span></span>')+'</div>'}).join('')+'</article>').join('')+'</div>';}
  async function load(){try{const r=await fetch('/api/going-live',{cache:'no-store'});render(await r.json());}catch(e){document.getElementById('schedule').innerHTML='<div class="empty">Schedule temporarily unavailable.</div>';}}
  load();setInterval(load,30000);
  </script></body></html>`;
}

function apiPayload() {
  const entries = scheduleEntries().map(e => ({
    id: e.id, userId: e.userId, username: e.username, date: e.date, hm: e.hm,
    displayTime: e.displayTime, title: e.title || '', link: safeLink(e.link),
    prettyDate: (() => { try { const [y,m,d]=e.date.split('-').map(Number); return new Intl.DateTimeFormat('en-US',{weekday:'long',month:'long',day:'numeric',timeZone:'UTC'}).format(new Date(Date.UTC(y,m-1,d))); } catch { return e.date; } })()
  }));
  return { ok: true, timeZone: ZONE, resetHour: RESET_HOUR, generatedAt: new Date().toISOString(), entries };
}

const originalCreateServer = http.createServer;
http.createServer = function(...args) {
  const listener = typeof args[0] === 'function' ? args[0] : typeof args[1] === 'function' ? args[1] : null;
  const wrapped = listener ? function(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && (url.pathname === '/going-live' || url.pathname === '/goinglive')) {
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); res.end(schedulePage()); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/going-live') {
      res.writeHead(200, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(apiPayload())); return;
    }
    return listener(req, res);
  } : listener;
  if (typeof args[0] === 'function') args[0] = wrapped;
  else if (typeof args[1] === 'function') args[1] = wrapped;
  return originalCreateServer.apply(http, args);
};

const originalFork = childProcess.fork;
childProcess.fork = function(modulePath, args, options) {
  let target = modulePath;
  if (path.basename(String(modulePath)) === 'discord_bot.js') target = path.join(path.dirname(String(modulePath)), 'discord_bootstrap.js');
  return originalFork.call(childProcess, target, args, options);
};

setInterval(dailyReset, 60 * 1000).unref?.();
dailyReset();
