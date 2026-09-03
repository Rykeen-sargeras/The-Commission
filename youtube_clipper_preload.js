'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const dns = require('dns');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const path = require('path');
const ytdl = require('@distube/ytdl-core');
const ffmpegPath = require('ffmpeg-static');

const DISCORD_CHANNEL_ID = '1543329276735266926';
const MAX_CLIP_MINUTES = Math.max(1, Math.min(60, Number(process.env.MAX_CLIP_MINUTES) || 15));
const MAX_CLIP_SECONDS = MAX_CLIP_MINUTES * 60;
const MAX_BODY_BYTES = 64 * 1024;
const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const clipDir = process.env.CLIP_STORAGE_DIR || path.join(dataDir, 'youtube-clips');
const jobs = new Map();
let queue = Promise.resolve();
let cachedIpv6Agent = null;

function clipperPassword() {
  const environmentPassword = String(process.env.CLIPPER_PASSWORD || '').trim();
  if (environmentPassword) return environmentPassword;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'commission-web-config.json'), 'utf8'));
    return String(config?.env?.CLIPPER_PASSWORD || '').trim();
  } catch {
    return '';
  }
}

function authToken() {
  const secret = crypto.createHash('sha256')
    .update(clipperPassword() + '|' + (process.env.DISCORD_TOKEN || '') + '|commission-clipper-v2')
    .digest();
  return crypto.createHmac('sha256', secret).update('youtube-clipper').digest('hex');
}

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
  return Boolean(token && clipperPassword() && safeEqual(token, authToken()));
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

function downloaderOptions(playerClients, forceIpv6 = false) {
  const options = { playerClients };
  const proxyUrl = String(process.env.YOUTUBE_PROXY_URL || '').trim();
  if (proxyUrl) {
    try { options.agent = ytdl.createProxyAgent(proxyUrl); }
    catch { options.agent = ytdl.createProxyAgent({ uri: proxyUrl }); }
  } else if (forceIpv6) {
    if (!cachedIpv6Agent) {
      cachedIpv6Agent = ytdl.createAgent([], {
        connect: {
          lookup(hostname, lookupOptions, callback) {
            const normalized = typeof lookupOptions === 'object' ? lookupOptions : {};
            dns.lookup(hostname, { ...normalized, family: 6, all: false }, callback);
          },
        },
      });
    }
    options.agent = cachedIpv6Agent;
  }
  return options;
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function getYouTubeInfo(sourceUrl) {
  const clients = [
    ['WEB_EMBEDDED'],
    ['TV'],
    ['ANDROID'],
    ['IOS'],
  ];
  const proxyConfigured = Boolean(String(process.env.YOUTUBE_PROXY_URL || '').trim());
  const ipv6Enabled = !proxyConfigured && String(process.env.YOUTUBE_FORCE_IPV6 || 'true').toLowerCase() !== 'false';
  const attempts = ipv6Enabled
    ? clients.map(playerClients => ({ playerClients, forceIpv6: true }))
      .concat(clients.map(playerClients => ({ playerClients, forceIpv6: false })))
    : clients.map(playerClients => ({ playerClients, forceIpv6: false }));
  let lastError = null;
  for (let index = 0; index < attempts.length; index += 1) {
    const options = downloaderOptions(attempts[index].playerClients, attempts[index].forceIpv6);
    try {
      return { info: await ytdl.getInfo(sourceUrl, options), options };
    } catch (error) {
      lastError = error;
      if (index < attempts.length - 1) await wait(500 * (index + 1));
    }
  }
  const message = String(lastError?.message || lastError || 'unknown YouTube error');
  if (/sign in to confirm|not a bot|login_required/i.test(message)) {
    throw new Error('YouTube blocked Railway\'s server address. Staff do not need to sign in. Configure YOUTUBE_PROXY_URL in Connection settings, then retry.');
  }
  if (/429|too many requests/i.test(message)) {
    throw new Error('YouTube rate-limited Railway (HTTP 429). Set YOUTUBE_PROXY_URL in Connection settings to a stable proxy, then retry.');
  }
  throw lastError || new Error('YouTube could not load this video.');
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

async function postToDiscord(payload) {
  const token = String(process.env.DISCORD_TOKEN || '').trim();
  if (!token) throw new Error('DISCORD_TOKEN is not configured on Railway.');
  const response = await fetch('https://discord.com/api/v10/channels/' + DISCORD_CHANNEL_ID + '/messages', {
    method: 'POST',
    headers: { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: [
        '🎬 **' + String(payload.title || 'YouTube clip').slice(0, 100) + '**',
        payload.clipUrl,
        'Source: ' + payload.sourceUrl,
        'Clip: ' + payload.start + '–' + payload.end,
      ].join('\n'),
    }),
  });
  if (!response.ok) {
    const details = (await response.text()).slice(0, 500);
    throw new Error('Discord rejected the clip post (' + response.status + '): ' + details);
  }
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
  job.stage = 'Connecting to YouTube';
  const { info, options: downloadOptions } = await getYouTubeInfo(sourceUrl);
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
    const stream = ytdl.downloadFromInfo(info, { format, agent: downloadOptions.agent });
    await runFfmpegFromStream(stream, partialFile, start, end - start, job);
    await fsp.rename(partialFile, finalFile);
    job.progress = 90;
    job.stage = 'Posting to Discord';
    const clipUrl = request.publicBaseUrl + '/clips/' + encodeURIComponent(fileName);
    await postToDiscord({
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

function loginPage(error = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Clipper — The Commission</title><style>
  :root{color-scheme:dark;font-family:Segoe UI,Inter,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#090a0d;color:#f4f1eb}.card{width:min(420px,92vw);padding:34px;border:1px solid #30343c;border-radius:18px;background:#12151a}h1{font:700 34px Georgia,serif}input,button{width:100%;box-sizing:border-box;padding:12px;border-radius:9px;font:inherit}input{background:#090b0e;color:#fff;border:1px solid #343943}button{margin-top:10px;border:0;background:#9d1d35;color:#fff;font-weight:800}.err{color:#ff8b9b}</style></head><body><form class="card" method="post" action="/clipper/login"><div>THE COMMISSION</div><h1>YouTube Clipper</h1><p>Enter the shared clipper password.</p>${error ? '<p class="err">' + String(error).replace(/[&<>]/g, '') + '</p>' : ''}<input type="password" name="password" required autofocus><button>Open Clipper</button></form></body></html>`;
}

function clipperPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Clipper — The Commission</title><style>
  :root{color-scheme:dark;--bg:#08090c;--panel:#11141a;--panel2:#171a21;--line:#2f343e;--red:#b5203f;--red2:#e03a59;--gold:#d5b16c;--muted:#a5a9b2;font-family:Inter,Segoe UI,sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 88% -10%,#3a111d 0,transparent 35%),var(--bg);color:#f5f2ec}button,input{font:inherit}button{cursor:pointer}.top{height:72px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 max(24px,calc((100vw - 1180px)/2));background:#0a0c10d9;position:sticky;top:0;z-index:5;backdrop-filter:blur(12px)}.brand{display:flex;align-items:center;gap:12px;font:700 20px Georgia,serif}.mark{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;background:linear-gradient(145deg,#6f1428,#bd2848);font-family:Inter}.nav{display:flex;gap:8px;align-items:center}.nav a,.ghost{color:#d4d4d4;text-decoration:none;padding:10px 13px;border-radius:9px;border:1px solid transparent;background:transparent}.nav a:hover,.ghost:hover{border-color:var(--line);background:#151820}.shell{width:min(1180px,94vw);margin:0 auto}.hero{text-align:center;padding:76px 0 55px}.eyebrow{color:var(--gold);letter-spacing:.18em;text-transform:uppercase;font-weight:800;font-size:11px}.hero h1{font:700 clamp(39px,6vw,66px) Georgia,serif;margin:13px auto 12px;max-width:850px}.hero p{color:var(--muted);font-size:18px;margin:0 auto 28px;max-width:650px;line-height:1.6}.urlbar{max-width:850px;margin:auto;display:flex;gap:10px;padding:9px;background:#11141a;border:1px solid #343945;border-radius:15px;box-shadow:0 24px 70px #0008}.urlbar input,.field input{width:100%;min-width:0;border:1px solid #343945;background:#090b0f;color:white;border-radius:9px;padding:13px 14px;outline:none}.urlbar input{border:0;background:transparent;font-size:16px}.primary{border:0;border-radius:9px;background:linear-gradient(135deg,var(--red),var(--red2));color:white;font-weight:800;padding:13px 19px;white-space:nowrap}.primary:disabled,.secondary:disabled{opacity:.4;cursor:not-allowed}.features{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:42px;text-align:left}.feature,.card{background:linear-gradient(145deg,#13161c,#0f1116);border:1px solid var(--line);border-radius:16px}.feature{padding:20px}.feature b{display:block;margin-bottom:7px}.feature span{color:var(--muted);font-size:14px;line-height:1.5}.workspace{display:none;padding:28px 0 60px}.workspace.open{display:block}.workspaceHead{display:flex;align-items:end;justify-content:space-between;gap:18px;margin-bottom:18px}.workspace h2{font:700 34px Georgia,serif;margin:5px 0}.workspaceHead p{color:var(--muted);margin:0}.grid{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(310px,.8fr);gap:16px}.card{padding:18px}.playerWrap{overflow:hidden;border-radius:12px;background:#000;aspect-ratio:16/9}.playerWrap #player{width:100%;height:100%}.source{display:flex;gap:9px;margin-bottom:12px}.source input{flex:1}.modes{display:flex;gap:7px;margin:15px 0 12px;padding:5px;background:#090b0f;border-radius:10px}.mode{flex:1;padding:10px;border:0;border-radius:7px;background:transparent;color:#9fa4ae;font-weight:700}.mode.on{background:#292e38;color:white}.timer{font:700 29px ui-monospace,SFMono-Regular,Consolas,monospace;text-align:center;margin:18px 0}.actions{display:grid;grid-template-columns:1fr 1fr;gap:9px}.secondary{border:1px solid #3b414d;border-radius:9px;background:#20242d;color:#fff;font-weight:750;padding:12px}.secondary.live{border-color:#d5b16c;color:#f1cd87}.manual{display:none;grid-template-columns:1fr 1fr;gap:10px}.manual.open{display:grid}.field label{display:block;color:#b2b6bf;font-size:12px;font-weight:700;margin:14px 0 6px}.wide{grid-column:1/-1}.add{width:100%;margin-top:14px}.sideTitle{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.sideTitle h3{margin:0}.count{font-size:12px;color:var(--muted);background:#252932;padding:5px 8px;border-radius:20px}.empty{padding:37px 15px;text-align:center;border:1px dashed #343a45;border-radius:11px;color:#8f949e}.clip{padding:12px;border:1px solid #333844;border-radius:10px;background:#0b0d11;margin-bottom:9px}.clipTop{display:flex;justify-content:space-between;gap:8px}.clip b{overflow:hidden;text-overflow:ellipsis}.clip small{display:block;color:var(--muted);margin-top:6px}.remove{border:0;background:transparent;color:#ff7890;font-size:18px}.export{width:100%;margin-top:13px}.status{margin-top:13px;padding:12px;background:#090b0e;border-radius:9px;white-space:pre-wrap;color:#c8cbd1;min-height:44px}.bar{height:7px;background:#292d35;border-radius:6px;overflow:hidden;margin-top:9px}.bar span{height:100%;display:block;background:linear-gradient(90deg,var(--red),#e6b966);width:0;transition:width .25s}.result{display:block;color:#e1bd77;margin-top:5px}.fine{color:#7f858f;font-size:12px;text-align:center;margin-top:22px}@media(max-width:820px){.grid{grid-template-columns:1fr}.features{grid-template-columns:1fr}.nav a:first-child{display:none}.hero{padding-top:48px}.urlbar{flex-direction:column}.workspaceHead{align-items:start;flex-direction:column}.top{padding:0 3vw}}
  </style></head><body><header class="top"><div class="brand"><span class="mark">TC</span>The Commission Clipper</div><nav class="nav"><a href="/">Control room</a><form method="post" action="/clipper/logout"><button class="ghost">Sign out</button></form></nav></header><main class="shell"><section class="hero" id="hero"><div class="eyebrow">Private clipping studio</div><h1>Turn the best moment into a shareable clip.</h1><p>Paste a YouTube link, play to the moment you want, mark its start and end, then publish it directly to your Discord clip channel.</p><div class="urlbar"><input id="heroUrl" aria-label="YouTube URL" placeholder="Paste a YouTube video or livestream URL"><button class="primary" id="openStudio">Start clipping</button></div><div class="features"><div class="feature"><b>1 · Load the video</b><span>The YouTube player stays beside the clipping controls.</span></div><div class="feature"><b>2 · Mark the moment</b><span>Use the playhead buttons or enter exact timestamps.</span></div><div class="feature"><b>3 · Publish the clips</b><span>Railway creates the files and posts their hosted links to Discord.</span></div></div></section><section class="workspace" id="workspace"><div class="workspaceHead"><div><div class="eyebrow">Clip workspace</div><h2>Mark your highlights</h2><p>Each selection can be up to ${MAX_CLIP_MINUTES} minutes.</p></div><button class="ghost" id="newVideo">Use another video</button></div><div class="grid"><section class="card"><div class="source"><input id="url" aria-label="Current YouTube URL"><button class="secondary" id="load">Load</button></div><div class="playerWrap"><div id="player"></div></div><div class="modes"><button class="mode on" data-mode="traditional">Playhead mode</button><button class="mode" data-mode="precise">Exact timestamps</button></div><div class="timer" id="timer">0:00</div><div class="actions" id="playheadControls"><button class="secondary" id="markStart">Mark start</button><button class="secondary" id="markEnd" disabled>Mark end</button></div><div class="manual" id="manual"><div class="field"><label for="start">Start</label><input id="start" value="0:00" placeholder="MM:SS"></div><div class="field"><label for="end">End</label><input id="end" value="0:30" placeholder="MM:SS"></div></div><div class="manual open"><div class="field wide"><label for="name">Clip title</label><input id="name" maxlength="100" placeholder="What happened in this moment?"></div></div><button class="primary add" id="add">Add selection</button></section><aside class="card"><div class="sideTitle"><h3>Your clips</h3><span class="count" id="count">0 selected</span></div><div id="clips"><div class="empty">Mark a start and end point to add your first clip.</div></div><button class="primary export" id="export" disabled>Create and post clips</button><div class="status" id="status">Nothing is uploaded until you click create and post.</div><div class="bar"><span id="progress"></span></div></aside></div><div class="fine">Finished clips are stored on Railway, not on your computer. Only clip content you have permission to use.</div></section></main><script src="https://www.youtube.com/iframe_api"></script><script>
  let player=null,playerReady=false,marking=false,markedStart=0,timerHandle=null,clips=[];
  const q=s=>document.querySelector(s),qa=s=>Array.from(document.querySelectorAll(s));
  function videoId(v){try{const u=new URL(v),h=u.hostname.replace(/^www\\./,'');if(h==='youtu.be')return u.pathname.split('/').filter(Boolean)[0];if(u.pathname==='/watch')return u.searchParams.get('v');return u.pathname.match(/^\\/(?:shorts|live|embed)\\/([^/?#]+)/)?.[1]}catch{return''}}
  function seconds(v){const text=String(v||'').trim();if(/^\\d+(?:\\.\\d+)?$/.test(text))return Number(text);const p=text.split(':');if(p.length<2||p.length>3||p.some(x=>!/^\\d+(?:\\.\\d+)?$/.test(x)))return NaN;return p.reduce((n,x)=>n*60+Number(x),0)}
  function stamp(s){s=Math.max(0,Math.floor(Number(s)||0));const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),x=s%60;return h?h+':'+String(m).padStart(2,'0')+':'+String(x).padStart(2,'0'):m+':'+String(x).padStart(2,'0')}
  function current(){return playerReady&&player?.getCurrentTime?player.getCurrentTime():0}
  function loadVideo(value){const id=videoId(value);if(!id){q('#status').textContent='Enter a valid YouTube URL.';return false}q('#url').value=value;q('#heroUrl').value=value;q('#hero').style.display='none';q('#workspace').classList.add('open');if(player?.destroy)player.destroy();playerReady=false;player=new YT.Player('player',{videoId:id,playerVars:{playsinline:1,rel:0},events:{onReady:()=>{playerReady=true;q('#status').textContent='Video ready. Play to the beginning of a moment and mark its start.'}}});clearInterval(timerHandle);timerHandle=setInterval(()=>{q('#timer').textContent=stamp(current())},250);return true}
  function render(){q('#count').textContent=clips.length+' selected';q('#export').disabled=!clips.length;if(!clips.length){q('#clips').innerHTML='<div class="empty">Mark a start and end point to add your first clip.</div>';return}q('#clips').innerHTML=clips.map((c,i)=>'<div class="clip"><div class="clipTop"><b>'+escapeHtml(c.name)+'</b><button class="remove" data-remove="'+i+'" aria-label="Remove clip">×</button></div><small>'+stamp(c.start)+' – '+stamp(c.end)+' · '+Math.round(c.end-c.start)+' seconds</small></div>').join('');qa('[data-remove]').forEach(b=>b.onclick=()=>{clips.splice(Number(b.dataset.remove),1);render()})}
  function escapeHtml(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  function addSelection(start,end){if(!Number.isFinite(start)||!Number.isFinite(end))return q('#status').textContent='Use a valid start and end timestamp.';if(end<=start)return q('#status').textContent='The ending timestamp must be after the start.';if(end-start>${MAX_CLIP_SECONDS})return q('#status').textContent='A clip can be no longer than ${MAX_CLIP_MINUTES} minutes.';clips.push({start,end,name:q('#name').value.trim()||'YouTube highlight '+(clips.length+1)});q('#name').value='';marking=false;q('#markStart').classList.remove('live');q('#markStart').textContent='Mark start';q('#markEnd').disabled=true;render();q('#status').textContent='Selection added. Add another moment or publish your clips.'}
  q('#openStudio').onclick=()=>loadVideo(q('#heroUrl').value);q('#heroUrl').onkeydown=e=>{if(e.key==='Enter')loadVideo(q('#heroUrl').value)};q('#load').onclick=()=>loadVideo(q('#url').value);q('#newVideo').onclick=()=>{q('#workspace').classList.remove('open');q('#hero').style.display='block';q('#heroUrl').focus()};
  q('#markStart').onclick=()=>{if(!playerReady)return q('#status').textContent='Wait for the video player to finish loading.';markedStart=current();q('#start').value=stamp(markedStart);marking=true;q('#markStart').classList.add('live');q('#markStart').textContent='Start · '+stamp(markedStart);q('#markEnd').disabled=false;q('#status').textContent='Start marked. Play to the end of the moment.'};
  q('#markEnd').onclick=()=>{if(!marking)return;const end=current();q('#end').value=stamp(end);addSelection(markedStart,end)};q('#add').onclick=()=>addSelection(seconds(q('#start').value),seconds(q('#end').value));
  qa('[data-mode]').forEach(b=>b.onclick=()=>{qa('[data-mode]').forEach(x=>x.classList.toggle('on',x===b));const precise=b.dataset.mode==='precise';q('#manual').classList.toggle('open',precise);q('#playheadControls').style.display=precise?'none':'grid'});
  async function api(url,opt={}){const r=await fetch(url,{...opt,headers:{'Content-Type':'application/json',...(opt.headers||{})}});const d=await r.json();if(!r.ok)throw new Error(d.error||'Request failed');return d}
  async function waitForJob(id,index,total){for(;;){const j=await api('/api/clipper/jobs/'+id);const overall=Math.round(((index+(j.progress||0)/100)/total)*100);q('#progress').style.width=overall+'%';q('#status').textContent='Clip '+(index+1)+' of '+total+' · '+j.stage+(j.error?'\\n'+j.error:'');if(j.status==='complete')return j;if(j.status==='failed')throw new Error(j.error||'Clip creation failed.');await new Promise(r=>setTimeout(r,900))}}
  q('#export').onclick=async()=>{const pending=clips.slice();q('#export').disabled=true;const links=[];try{for(let i=0;i<pending.length;i++){const c=pending[i];const j=await api('/api/clipper/jobs',{method:'POST',body:JSON.stringify({url:q('#url').value,start:c.start,end:c.end,name:c.name})});const done=await waitForJob(j.id,i,pending.length);links.push(done.clipUrl)}clips=[];render();q('#progress').style.width='100%';q('#status').innerHTML='All clips were hosted and posted to Discord.'+links.map((url,i)=>'<a class="result" href="'+url+'" target="_blank" rel="noopener">Open clip '+(i+1)+'</a>').join('')}catch(e){q('#status').textContent=e.message;q('#export').disabled=false}}
  render();
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
        const password = clipperPassword();
        if (!password) return send(res, 500, 'text/html; charset=utf-8', loginPage('CLIPPER_PASSWORD is not configured yet.'));
        if (!safeEqual(supplied, password)) return send(res, 401, 'text/html; charset=utf-8', loginPage('Wrong password.'));
        return redirect(res, '/clipper', { 'Set-Cookie': 'commission_clipper=' + authToken() + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200' });
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
  clipperPassword,
  formatTimestamp,
  getYouTubeInfo,
  parseTimestamp,
  parseYouTubeVideoId,
  publicBaseUrl,
  safeFilename,
};

