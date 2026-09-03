'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const path = require('path');
const ytdl = require('@distube/ytdl-core');
const ffmpegPath = require('ffmpeg-static');

const DISCORD_CHANNEL_ID = '1543329276735266926';
const MAX_CLIP_SECONDS = 120;
const MAX_BODY_BYTES = 64 * 1024;
const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const clipDir = process.env.CLIP_STORAGE_DIR || path.join(dataDir, 'youtube-clips');
const dashboardPassword = String(process.env.WEB_DASHBOARD_PASSWORD || '');
const cookieSecret = crypto.createHash('sha256')
  .update(dashboardPassword + '|' + (process.env.DISCORD_TOKEN || '') + '|commission-clipper-v1')
  .digest();
const authToken = crypto.createHmac('sha256', cookieSecret).update('youtube-clipper').digest('hex');
const jobs = new Map();
const pending = new Map();
let queue = Promise.resolve();
let discordChild = null;

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function cookies(req) {
  const values = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key) values[key] = decodeURIComponent(rest.join('='));
  }
  return values;
}

function authed(req) {
  const token = cookies(req).commission_clipper;
  return Boolean(token && safeEqual(token, authToken));
}

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function json(res, status, value) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, ...headers });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error('Request is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value ?? '').trim();
  if (!text) throw new Error('Enter a timestamp.');
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const pieces = text.split(':');
  if (pieces.length < 2 || pieces.length > 3 || pieces.some(piece => !/^\d+(\.\d+)?$/.test(piece))) {
    throw new Error('Use seconds, MM:SS, or HH:MM:SS.');
  }
  return pieces.reduce((seconds, piece) => seconds * 60 + Number(piece), 0);
}

function parseYouTubeVideoId(value) {
  let url;
  try { url = new URL(String(value || '').trim()); }
  catch { throw new Error('Enter a valid YouTube URL.'); }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let id = '';
  if (host === 'youtu.be') id = url.pathname.split('/').filter(Boolean)[0] || '';
  if (['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
    if (url.pathname === '/watch') id = url.searchParams.get('v') || '';
    else id = url.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/)?.[1] || '';
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('The URL does not contain a valid YouTube video ID.');
  return id;
}

function safeFilename(value) {
  const clean = String(value || 'youtube-clip')
    .normalize('NFKD')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return clean || 'youtube-clip';
}

function formatTimestamp(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  return hours
    ? hours + ':' + String(minutes).padStart(2, '0') + ':' + String(secs).padStart(2, '0')
    : minutes + ':' + String(secs).padStart(2, '0');
}

function publicBaseUrl(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const railwayDomain = String(process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
  if (railwayDomain) return 'https://' + railwayDomain;
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return proto + '://' + req.headers.host;
}

function runFfmpegFromStream(stream, outputFile, start, duration, job) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'warning',
      '-i', 'pipe:0',
      '-ss', String(start),
      '-t', String(duration),
      '-map_metadata', '-1',
      '-vf', 'scale=w=min(960\\,iw):h=-2',
      '-c:v', 'libx264', '-preset', 'veryfast',
      '-b:v', '500k', '-maxrate', '650k', '-bufsize', '1300k',
      '-c:a', 'aac', '-b:a', '64k',
      '-movflags', '+faststart',
      '-y', outputFile,
    ], { windowsHide: true });
    let stderr = '';
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      stream.destroy();
      error ? reject(error) : resolve();
    };
    stream.on('progress', (_chunk, downloaded, total) => {
      if (total > 0) job.progress = Math.min(75, Math.round(downloaded / total * 75));
    });
    stream.once('error', error => finish(new Error('YouTube download failed: ' + error.message)));
    child.stdin.once('error', error => {
      if (error.code !== 'EPIPE') finish(error);
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
    child.once('error', finish);
    child.once('close', code => {
      if (code === 0) finish();
      else finish(new Error('FFmpeg failed: ' + (stderr.trim() || 'exit code ' + code)));
    });
    stream.pipe(child.stdin);
  });
}

function childRequest(payload, timeoutMs = 30000) {
  if (!discordChild?.connected) return Promise.reject(new Error('The Discord bot is not running.'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Discord posting timed out.'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    discordChild.send({ channel: 'commission:clipper-post', id, payload });
  });
}

async function createClip(job, request) {
  const videoId = parseYouTubeVideoId(request.url);
  const sourceUrl = 'https://www.youtube.com/watch?v=' + videoId;
  const start = parseTimestamp(request.start);
  const end = parseTimestamp(request.end);
  if (start < 0 || end <= start) throw new Error('The ending timestamp must be after the starting timestamp.');
  if (end - start > MAX_CLIP_SECONDS) {
    throw new Error('Clips are limited to ' + MAX_CLIP_SECONDS + ' seconds.');
  }
  await fsp.mkdir(clipDir, { recursive: true });
  const info = await ytdl.getInfo(sourceUrl);
  const format = ytdl.chooseFormat(info.formats, {
    quality: 'highest',
    filter: candidate => candidate.hasAudio && candidate.hasVideo && candidate.container === 'mp4',
  });
  if (!format?.url) throw new Error('YouTube did not provide a combined MP4 stream for this video.');
  const name = safeFilename(request.name || info.videoDetails?.title || 'youtube-clip');
  const fileName = name + '-' + Date.now() + '-' + crypto.randomBytes(6).toString('hex') + '.mp4';
  const finalFile = path.join(clipDir, fileName);
  const partialFile = finalFile.replace(/\.mp4$/i, '.part.mp4');
  try {
    job.stage = 'Streaming and encoding';
    const stream = ytdl.downloadFromInfo(info, { format });
    await runFfmpegFromStream(stream, partialFile, start, end - start, job);
    await fsp.rename(partialFile, finalFile);
    job.progress = 90;
    job.stage = 'Posting to Discord';
    const clipUrl = request.publicBaseUrl + '/clips/' + encodeURIComponent(fileName);
    await childRequest({
      channelId: DISCORD_CHANNEL_ID,
      clipUrl,
      sourceUrl,
      title: String(request.name || info.videoDetails?.title || 'YouTube clip').trim().slice(0, 100),
      start: formatTimestamp(start),
      end: formatTimestamp(end),
    });
    job.status = 'complete';
    job.stage = 'Hosted on Railway and posted to Discord';
    job.progress = 100;
    job.clipUrl = clipUrl;
  } catch (error) {
    await fsp.rm(partialFile, { force: true }).catch(() => null);
    throw error;
  }
}

function enqueue(request) {
  const id = Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  const job = { id, status: 'queued', stage: 'Waiting', progress: 0, error: '', clipUrl: '' };
  jobs.set(id, job);
  queue = queue.catch(() => null).then(async () => {
    job.status = 'running';
    try { await createClip(job, request); }
    catch (error) {
      job.status = 'failed';
      job.stage = 'Failed';
      job.error = error.message;
    }
  });
  return job;
}

function attachChild(child) {
  discordChild = child;
  child.on('message', message => {
    if (message?.channel !== 'commission:clipper-response' || !message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    message.ok ? request.resolve(message.data) : request.reject(new Error(message.error || 'Discord post failed.'));
  });
  child.once('exit', () => {
    if (discordChild === child) discordChild = null;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('The Discord bot stopped.'));
    }
    pending.clear();
  });
}

function loginPage(error = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Clipper — The Commission</title><style>
  :root{color-scheme:dark;font-family:Segoe UI,Inter,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#090a0d;color:#f4f1eb}.card{width:min(420px,92vw);padding:34px;border:1px solid #30343c;border-radius:18px;background:#12151a}h1{font:700 34px Georgia,serif}input,button{width:100%;box-sizing:border-box;padding:12px;border-radius:9px;font:inherit}input{background:#090b0e;color:#fff;border:1px solid #343943}button{margin-top:10px;border:0;background:#9d1d35;color:#fff;font-weight:800}.err{color:#ff8b9b}</style></head><body><form class="card" method="post" action="/clipper/login"><div>THE COMMISSION</div><h1>YouTube Clipper</h1><p>Use the control-room password.</p>${error ? '<p class="err">' + String(error).replace(/[&<>]/g, '') + '</p>' : ''}<input type="password" name="password" required autofocus><button>Open Clipper</button></form></body></html>`;
}

function clipperPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Clipper — The Commission</title><style>
  :root{color-scheme:dark;--bg:#08090c;--panel:#12151a;--line:#30343c;--red:#a91f39;--gold:#d1ae6d;font-family:Segoe UI,Inter,sans-serif}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,#301219,transparent 38%),var(--bg);color:#f4f1eb}main{width:min(1050px,94vw);margin:30px auto}.eyebrow{color:var(--gold);letter-spacing:.16em;font-size:11px}h1{font:700 clamp(38px,7vw,65px) Georgia,serif;margin:7px 0 22px}.card{background:var(--panel);border:1px solid var(--line);padding:20px;border-radius:17px}#player{width:100%;aspect-ratio:16/9;background:#050505;border-radius:11px}.row{display:flex;gap:10px;flex-wrap:wrap;margin:11px 0}label{display:block;color:#bbb;font-size:12px;margin:12px 0 6px}input,button{padding:11px;border:1px solid #3a3f48;border-radius:8px;background:#181b21;color:#fff;font:inherit}input{flex:1;min-width:150px}button{background:var(--red);font-weight:800;cursor:pointer}.alt{background:#22262d}.status{margin-top:13px;padding:13px;background:#090b0e;border-radius:9px;white-space:pre-wrap}.bar{height:8px;background:#292d35;border-radius:6px;overflow:hidden;margin-top:10px}.bar span{height:100%;display:block;background:#cf2c4b;width:0}.link{color:#e1bd77}a{color:#e1bd77}</style></head><body><main><div class="eyebrow">THE COMMISSION · RAILWAY</div><h1>YouTube Clipper</h1><section class="card"><label>YouTube URL</label><div class="row"><input id="url" placeholder="https://youtube.com/watch?v=..."><button id="load">Load video</button></div><div id="player"></div><div class="row"><button class="alt" id="markStart">Use current time as start</button><button class="alt" id="markEnd">Use current time as end</button></div><div class="row"><div style="flex:1"><label>Start</label><input id="start" value="0:00"></div><div style="flex:1"><label>End</label><input id="end" value="0:30"></div></div><label>Clip name</label><input id="name" placeholder="Highlight name"><div class="row"><button id="create">Create and post clip</button><a href="/" style="padding:11px">Back to control room</a></div><div id="status" class="status">Ready. Finished clips are stored on Railway only.</div><div class="bar"><span id="progress"></span></div></section></main><script src="https://www.youtube.com/iframe_api"></script><script>
  let player=null,jobId='';
  const q=s=>document.querySelector(s);
  function videoId(v){try{const u=new URL(v),h=u.hostname.replace(/^www\\./,'');if(h==='youtu.be')return u.pathname.split('/').filter(Boolean)[0];if(u.pathname==='/watch')return u.searchParams.get('v');return u.pathname.match(/^\\/(?:shorts|live|embed)\\/([^/?#]+)/)?.[1]}catch{return''}}
  function stamp(s){s=Math.max(0,Math.floor(Number(s)||0));const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),x=s%60;return h?h+':'+String(m).padStart(2,'0')+':'+String(x).padStart(2,'0'):m+':'+String(x).padStart(2,'0')}
  q('#load').onclick=()=>{const id=videoId(q('#url').value);if(!id)return alert('Enter a valid YouTube URL.');if(player?.destroy)player.destroy();player=new YT.Player('player',{videoId:id,playerVars:{playsinline:1}})};
  q('#markStart').onclick=()=>{if(player?.getCurrentTime)q('#start').value=stamp(player.getCurrentTime())};
  q('#markEnd').onclick=()=>{if(player?.getCurrentTime)q('#end').value=stamp(player.getCurrentTime())};
  async function api(url,opt={}){const r=await fetch(url,{...opt,headers:{'Content-Type':'application/json',...(opt.headers||{})}});const d=await r.json();if(!r.ok)throw new Error(d.error||'Request failed');return d}
  q('#create').onclick=async()=>{try{const j=await api('/api/clipper/jobs',{method:'POST',body:JSON.stringify({url:q('#url').value,start:q('#start').value,end:q('#end').value,name:q('#name').value})});jobId=j.id;poll()}catch(e){q('#status').textContent=e.message}};
  async function poll(){try{const j=await api('/api/clipper/jobs/'+jobId);q('#progress').style.width=(j.progress||0)+'%';q('#status').innerHTML=j.stage+(j.error?'\\n'+j.error:'')+(j.clipUrl?'\\n<a class="link" href="'+j.clipUrl+'" target="_blank">Open hosted clip</a>':'');if(j.status==='queued'||j.status==='running')setTimeout(poll,900)}catch(e){q('#status').textContent=e.message}}
  </script></body></html>`;
}

async function serveClip(req, res, fileName) {
  const decoded = decodeURIComponent(fileName);
  if (path.basename(decoded) !== decoded || !decoded.toLowerCase().endsWith('.mp4')) return json(res, 400, { error: 'Invalid clip path.' });
  const file = path.join(clipDir, decoded);
  let stat;
  try { stat = await fsp.stat(file); } catch { return json(res, 404, { error: 'Clip not found.' }); }
  const range = String(req.headers.range || '');
  if (range) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (!match) return send(res, 416, 'text/plain', 'Invalid range');
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
    if (start > end || start >= stat.size) return send(res, 416, 'text/plain', 'Range not satisfiable', { 'Content-Range': 'bytes */' + stat.size });
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size, 'Cache-Control': 'public, max-age=31536000, immutable' });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=31536000, immutable' });
  fs.createReadStream(file).pipe(res);
}

const originalFork = childProcess.fork;
childProcess.fork = function patchedClipperFork(modulePath, args, options) {
  const child = originalFork.call(childProcess, modulePath, args, options);
  const base = path.basename(String(modulePath));
  if (base === 'discord_bootstrap.js' || base === 'discord_bot.js') attachChild(child);
  return child;
};

const originalCreateServer = http.createServer;
http.createServer = function patchedClipperServer(...args) {
  const listenerIndex = typeof args[0] === 'function' ? 0 : (typeof args[1] === 'function' ? 1 : -1);
  if (listenerIndex < 0) return originalCreateServer.apply(http, args);
  const listener = args[listenerIndex];
  args[listenerIndex] = async function clipperRoutes(req, res) {
    try {
      const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
      if (req.method === 'GET' && url.pathname.startsWith('/clips/')) {
        return serveClip(req, res, url.pathname.slice('/clips/'.length));
      }
      if (url.pathname === '/clipper/login' && req.method === 'POST') {
        const supplied = new URLSearchParams(await readBody(req)).get('password') || '';
        if (!dashboardPassword) return send(res, 500, 'text/html; charset=utf-8', loginPage('WEB_DASHBOARD_PASSWORD is not configured.'));
        if (!safeEqual(supplied, dashboardPassword)) return send(res, 401, 'text/html; charset=utf-8', loginPage('Wrong password.'));
        return redirect(res, '/clipper', { 'Set-Cookie': 'commission_clipper=' + authToken + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200' });
      }
      if (url.pathname === '/clipper/logout' && req.method === 'POST') {
        return redirect(res, '/clipper', { 'Set-Cookie': 'commission_clipper=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
      }
      if (url.pathname === '/clipper' && req.method === 'GET') {
        return send(res, 200, 'text/html; charset=utf-8', authed(req) ? clipperPage() : loginPage());
      }
      if (url.pathname.startsWith('/api/clipper/')) {
        if (!authed(req)) return json(res, 401, { error: 'Not authenticated.' });
        if (url.pathname === '/api/clipper/jobs' && req.method === 'POST') {
          const payload = JSON.parse(await readBody(req) || '{}');
          parseYouTubeVideoId(payload.url);
          const start = parseTimestamp(payload.start);
          const end = parseTimestamp(payload.end);
          if (end <= start) return json(res, 400, { error: 'The ending timestamp must be after the starting timestamp.' });
          if (end - start > MAX_CLIP_SECONDS) return json(res, 400, { error: 'Clips are limited to ' + MAX_CLIP_SECONDS + ' seconds.' });
          return json(res, 202, enqueue({ ...payload, publicBaseUrl: publicBaseUrl(req) }));
        }
        if (req.method === 'GET' && url.pathname.startsWith('/api/clipper/jobs/')) {
          const job = jobs.get(url.pathname.slice('/api/clipper/jobs/'.length));
          return job ? json(res, 200, job) : json(res, 404, { error: 'Clip job not found.' });
        }
        return json(res, 404, { error: 'Clipper endpoint not found.' });
      }
      return listener(req, res);
    } catch (error) {
      if (!res.headersSent) return json(res, 500, { error: error.message });
      res.end();
    }
  };
  return originalCreateServer.apply(http, args);
};

module.exports = {
  DISCORD_CHANNEL_ID,
  MAX_CLIP_SECONDS,
  formatTimestamp,
  parseTimestamp,
  parseYouTubeVideoId,
  publicBaseUrl,
  safeFilename,
};

