'use strict';

// Load Railway web-board routes and Discord bootstrap patches relative to this file.
require('./going_live_preload');
require('./youtube_clipper_preload');

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

const port = Number(process.env.PORT || 8080);
const host = '0.0.0.0';
const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true });
const configFile = path.join(dataDir, 'commission-web-config.json');
const blueprintDir = path.join(dataDir, 'blueprints-web');
fs.mkdirSync(blueprintDir, { recursive: true });

const dashboardPassword = String(process.env.WEB_DASHBOARD_PASSWORD || '');
const sessionKey = crypto.createHash('sha256').update(`${dashboardPassword}|${process.env.DISCORD_TOKEN || ''}|commission-web-v1`).digest();
const sessions = new Map();
let bot = null;
let botState = 'stopped';
let logs = [];
let pending = new Map();
let shuttingDown = false;
let desiredRunning = true;

const { BASE_FIELDS, ECON_FIELDS } = require('./railway/fields');
const { loginPage, dashboardPage } = require('./railway/ui');
const { MembershipWeb } = require('./membership_web');

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function parseEconomyEnv() { try { return JSON.parse(process.env.ECONOMY_CONFIG_JSON || '{}'); } catch { return {}; } }
function loadSaved() { return readJson(configFile, { env: {}, economy: {} }); }
function saveSaved(value) { const tmp=`${configFile}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value,null,2)); fs.renameSync(tmp,configFile); }
function mergedConfig() { const saved=loadSaved(); const env={}; for(const [key] of BASE_FIELDS) env[key] = Object.prototype.hasOwnProperty.call(saved.env||{},key) ? saved.env[key] : (process.env[key]||''); const economy={...parseEconomyEnv(),...(saved.economy||{})}; if((economy.dailyBase===undefined&&economy.dailyStreakStep===undefined&&economy.dailyStreakMaximum===undefined)||(Number(economy.dailyBase)===25&&Number(economy.dailyStreakStep)===5&&Number(economy.dailyStreakMaximum)===75)){economy.dailyBase=100;economy.dailyStreakStep=100;economy.dailyStreakMaximum=700;} return { env, economy }; }
function childEnv() { const cfg=mergedConfig(); return {...process.env,...cfg.env,ECONOMY_CONFIG_JSON:JSON.stringify(cfg.economy),COMMISSION_RAILWAY_MODE:'true',DATA_DIR:dataDir,PORT:String(port)}; }
function maskConfig(cfg) { const out=JSON.parse(JSON.stringify(cfg)); for(const [key,,type] of BASE_FIELDS) if(type==='password') out.env[key]=out.env[key]?'••••••••':''; return out; }
function addLog(source, line) { for(const part of String(line).split(/\r?\n/)){ if(!part) continue; logs.push({at:new Date().toISOString(),source,line:part}); if(logs.length>1000) logs.shift(); } }

function startBot(){
  if(bot) return;
  desiredRunning=true; botState='starting';
  bot=fork(path.join(__dirname,'discord_bootstrap.js'),[],{cwd:dataDir,env:childEnv(),silent:true});
  addLog('system',`Started The Commission bot (PID ${bot.pid}).`);
  bot.stdout?.on('data',d=>{addLog('bot',d);process.stdout.write(d);}); bot.stderr?.on('data',d=>{addLog('error',d);process.stderr.write(d);});
  bot.on('message',msg=>{ if(!msg?.id) return; const p=pending.get(msg.id); if(!p) return; clearTimeout(p.timer); pending.delete(msg.id); msg.ok?p.resolve(msg.data):p.reject(new Error(msg.error||'Bot operation failed.')); });
  bot.on('spawn',()=>{botState='running';});
  bot.on('exit',(code,signal)=>{ addLog('system',`Bot stopped (code ${code??'n/a'}, signal ${signal||'none'}).`); bot=null; botState='stopped'; for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Bot stopped.'));} pending.clear(); if(desiredRunning&&!shuttingDown) setTimeout(startBot,1500).unref?.(); });
}
function stopBot(restart=false){ return new Promise(resolve=>{ desiredRunning=restart; if(!bot){botState='stopped'; if(restart) startBot(); return resolve();} const current=bot; botState='stopping'; const timer=setTimeout(()=>{try{current.kill('SIGKILL')}catch{}},8000); current.once('exit',()=>{clearTimeout(timer); if(restart) setTimeout(startBot,350); resolve();}); try{current.kill('SIGTERM')}catch{resolve();} }); }
function botRequest(channel,action,payload={},timeoutMs=30000){ if(!bot?.connected) return Promise.reject(new Error('Bot is not running.')); const id=crypto.randomUUID(); return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${action} timed out.`));},timeoutMs); pending.set(id,{resolve,reject,timer}); bot.send({channel,id,action,payload});}); }
const membershipWeb = new MembershipWeb({ dataDir, configProvider: () => ({ ...process.env, ...mergedConfig().env }), botRequest });

function cookies(req){const out={};for(const p of String(req.headers.cookie||'').split(';')){const [k,...v]=p.trim().split('=');if(k)out[k]=decodeURIComponent(v.join('='));}return out;}
function newSession(){const token=crypto.randomBytes(24).toString('hex');sessions.set(token,Date.now()+12*3600000);return token;}
function authed(req){const t=cookies(req).commission_session;const exp=sessions.get(t);if(!exp||exp<Date.now()){if(t)sessions.delete(t);return false;}return true;}
function safeEqual(a,b){const aa=Buffer.from(String(a)),bb=Buffer.from(String(b));return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb);}
function send(res,status,type,body,headers={}){res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store',...headers});res.end(body);}
function json(res,status,obj){send(res,status,'application/json; charset=utf-8',JSON.stringify(obj));}
function redirect(res,to,headers={}){res.writeHead(302,{Location:to,...headers});res.end();}
function body(req){return new Promise((resolve,reject)=>{let raw='';req.on('data',c=>{raw+=c;if(raw.length>2_000_000){reject(new Error('Request too large'));req.destroy();}});req.on('end',()=>resolve(raw));req.on('error',reject);});}
function listBlueprints(){return fs.readdirSync(blueprintDir).filter(x=>x.endsWith('.json')).map(name=>{const b=readJson(path.join(blueprintDir,name),{});return{name,sourceGuild:b.sourceGuild||{},capturedAt:b.capturedAt||''};}).sort((a,b)=>String(b.capturedAt).localeCompare(String(a.capturedAt)));}


const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    if(url.pathname==='/health') return json(res,200,{ok:true,service:'the-commission',webapp:true,botState});
    if(url.pathname==='/login'&&req.method==='POST'){const raw=await body(req);const p=new URLSearchParams(raw).get('password')||'';if(!dashboardPassword)return send(res,500,'text/html; charset=utf-8',loginPage('WEB_DASHBOARD_PASSWORD is not configured.'));if(!safeEqual(p,dashboardPassword))return send(res,401,'text/html; charset=utf-8',loginPage('Wrong password.'));const token=newSession();return redirect(res,'/',{'Set-Cookie':`commission_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`});}
    if(url.pathname==='/logout'&&req.method==='POST'){const t=cookies(req).commission_session;if(t)sessions.delete(t);return redirect(res,'/',{'Set-Cookie':'commission_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'});}
    if(await membershipWeb.handle(req,res,url,authed(req))) return;
    if(!authed(req)){if(url.pathname.startsWith('/api/'))return json(res,401,{error:'Not authenticated'});return send(res,200,'text/html; charset=utf-8',loginPage());}
    if(url.pathname==='/'&&req.method==='GET') return send(res,200,'text/html; charset=utf-8',dashboardPage());
    if(url.pathname==='/api/state'&&req.method==='GET') return json(res,200,{state:botState,pid:bot?.pid||null,logs:logs.slice(-500),config:maskConfig(mergedConfig())});
    if(url.pathname==='/api/config'&&req.method==='POST'){const incoming=JSON.parse(await body(req)||'{}');const saved=loadSaved();saved.env=saved.env||{};saved.economy=saved.economy||{};const allowed=new Set(BASE_FIELDS.map(x=>x[0]));for(const [k,v] of Object.entries(incoming.env||{}))if(allowed.has(k))saved.env[k]=String(v);const econAllowed=new Set(ECON_FIELDS.map(x=>x[0]));for(const [k,v] of Object.entries(incoming.economy||{}))if(econAllowed.has(k))saved.economy[k]=v;saveSaved(saved);await stopBot(true);return json(res,200,{ok:true,config:maskConfig(mergedConfig())});}
    if(url.pathname==='/api/bot/start'&&req.method==='POST'){startBot();return json(res,200,{ok:true});}
    if(url.pathname==='/api/bot/stop'&&req.method==='POST'){await stopBot(false);return json(res,200,{ok:true});}
    if(url.pathname==='/api/bot/restart'&&req.method==='POST'){await stopBot(true);return json(res,200,{ok:true});}
    if(url.pathname==='/api/economy/stats'&&req.method==='GET'){return json(res,200,await botRequest('commission:economy-request','stats',{}));}
    if(url.pathname==='/api/economy/leaderboard'&&req.method==='GET'){return json(res,200,await botRequest('commission:economy-request','leaderboard',{type:String(url.searchParams.get('type')||'balance')}));}
    if(url.pathname==='/api/economy/push-heist'&&req.method==='POST'){const p=JSON.parse(await body(req)||'{}');return json(res,200,await botRequest('commission:economy-request','push-heist-panel',{channelId:p.channelId||''}));}
    if(url.pathname==='/api/economy/bulk-grant/preview'&&req.method==='POST'){const p=JSON.parse(await body(req)||'{}');const amount=Number.parseInt(p.amount,10);if(!Number.isFinite(amount)||amount<1)return json(res,400,{error:'Enter a positive Blood Money amount for each member.'});return json(res,200,await botRequest('commission:economy-request','bulk-grant-preview',{amount},60000));}
    if(url.pathname==='/api/economy/bulk-grant/execute'&&req.method==='POST'){const p=JSON.parse(await body(req)||'{}');if(!String(p.token||'').trim())return json(res,400,{error:'Preview the bulk grant before confirming it.'});return json(res,200,await botRequest('commission:economy-request','bulk-grant-execute',{token:String(p.token)},60000));}
    if(url.pathname==='/api/economy/reset/preview'&&req.method==='POST'){const p=JSON.parse(await body(req)||'{}');return json(res,200,await botRequest('commission:economy-request','reset-preview',{action:String(p.action||''),userId:String(p.userId||'').trim()}));}
    if(url.pathname==='/api/economy/reset/execute'&&req.method==='POST'){const p=JSON.parse(await body(req)||'{}');if(!String(p.token||'').trim())return json(res,400,{error:'Preview the reset before confirming it.'});return json(res,200,await botRequest('commission:economy-request','reset-execute',{token:String(p.token)}));}
    if(url.pathname==='/api/blueprints'&&req.method==='GET'){const guilds=await botRequest('commission:blueprint-request','list-guilds',{});return json(res,200,{guilds,blueprints:listBlueprints()});}
    if(url.pathname==='/api/blueprints/capture'&&req.method==='POST'){const p=JSON.parse(await body(req)||'{}');const bp=await botRequest('commission:blueprint-request','capture',{guildId:p.guildId},120000);const name=`${bp.sourceGuild?.id||p.guildId}-${String(bp.capturedAt||new Date().toISOString()).replace(/[:.]/g,'-')}.json`;fs.writeFileSync(path.join(blueprintDir,path.basename(name)),JSON.stringify(bp,null,2));return json(res,200,{ok:true,name});}
    if(url.pathname==='/api/blueprints/apply'&&req.method==='POST'){const p=JSON.parse(await body(req)||'{}');const file=path.basename(String(p.fileName||''));if(file!==p.fileName||!file.endsWith('.json'))return json(res,400,{error:'Invalid blueprint file'});const bp=readJson(path.join(blueprintDir,file),null);if(!bp)return json(res,404,{error:'Blueprint not found'});const result=await botRequest('commission:blueprint-request','apply',{guildId:p.guildId,blueprint:bp,applyEveryonePermissions:Boolean(p.applyEveryonePermissions)},300000);return json(res,200,result);}
    return json(res,404,{error:'Not found'});
  }catch(error){console.error('[Web dashboard]',error);return json(res,500,{error:error.message});}
});

server.listen(port,host,()=>{console.log(`[Railway] The Commission web control room listening on ${host}:${port}`);startBot();});
server.on('error',e=>{console.error('[Railway] Web server failed:',e);process.exit(1);});
async function shutdown(signal){if(shuttingDown)return;shuttingDown=true;desiredRunning=false;console.log(`[Railway] ${signal} received.`);await stopBot(false).catch(()=>{});server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),10000).unref?.();}
process.once('SIGTERM',()=>shutdown('SIGTERM'));process.once('SIGINT',()=>shutdown('SIGINT'));
