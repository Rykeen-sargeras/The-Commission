'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 18991);
const mock = `window.commission={
 bootstrap:async()=>({authenticated:true,config:{settings:{memberBridgeEnabled:true,memberBridgeSimulationMode:true,memberBridgeProductionMode:false,memberBridgePublicBaseUrl:'http://127.0.0.1:17842',memberBridgeCallbackHost:'127.0.0.1',memberBridgeCallbackPort:17842,memberBridgeVerificationIntervalMinutes:360,memberBridgeLevelSyncHours:24,memberBridgeMissingChecksBeforeGrace:2,memberBridgeGracePeriodHours:168,memberBridgeMassAbsencePercent:20,memberBridgeMemberDmsEnabled:true},hasDiscordToken:true,hasMemberBridgeGoogleClientSecret:false,hasMemberBridgeDiscordClientSecret:false},status:{state:'running',dashboardReady:true,pid:1234,logs:[]}}),
 login:async()=>({ok:true}),lock:async()=>({}),saveConfig:async p=>({config:{settings:p.settings}}),startBot:async()=>({state:'running'}),stopBot:async()=>({state:'stopped'}),openDashboard:async()=>({}),openDataFolder:async()=>({}),listBlueprints:async()=>[],onStatus:()=>{},onLog:()=>{},
 memberBridge:async(action,payload)=>{if(action==='dashboard')return{status:'Healthy',dashboard:{operationalCreators:1,creators:1,linkedMembers:2,activeMemberships:1,graceMemberships:1}};if(action==='creators')return[{id:1,display_name:'Misfit Mafia',connection_status:'Operational',role_mode:'highest',general_role_id:'',missing_checks_before_grace:2,grace_period_hours:168,mass_absence_percent:20,safe_mode:0}];if(action==='levels')return[{youtube_level_id:'LEVEL_ASSOCIATE',display_name:'Associate',currently_reported:1,mapped_role_id:'22345678901234567'},{youtube_level_id:'LEVEL_UNDERBOSS',display_name:'Underboss',currently_reported:1,mapped_role_id:'32345678901234567'}];if(action==='guild-roles')return[{id:'22345678901234567',name:'MM Associate',editable:true},{id:'32345678901234567',name:'MM Underboss',editable:true}];if(action==='links')return[{discord_user_id:'42345678901234567',discord_username:'example_member',youtube_channel_id:'UC_MEMBER_001',youtube_display_name:'Example Member',records:[{creator_name:'Misfit Mafia',status:'Active',current_level_name:'Underboss'}]},{discord_user_id:'52345678901234567',discord_username:'grace_member',youtube_channel_id:'UC_MEMBER_002',youtube_display_name:'Grace Member',records:[{creator_name:'Misfit Mafia',status:'GracePeriod',current_level_name:'Associate',grace_expires_utc:new Date(Date.now()+86400000).toISOString()}]}];if(action==='audit')return[{created_utc:new Date().toISOString(),severity:'success',event_type:'Membership verified active',message:'Example member verified as Underboss.'}];return{}},
 getEconomyStats:async()=>({}),getEconomyLeaderboard:async()=>[],pushHeistPanel:async()=>({}),previewEconomyReset:async()=>({}),executeEconomyReset:async()=>({}),previewBulkGrant:async()=>({}),executeBulkGrant:async()=>({}),listGuilds:async()=>[],captureBlueprint:async()=>({}),applyBlueprint:async()=>({})
};setTimeout(()=>document.querySelector('[data-page-target="memberbridge"]')?.click(),100);`;

http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/preview-bridge.js') { res.writeHead(200, {'content-type':'application/javascript'}); return res.end(mock); }
    let file;
    if (url.pathname === '/' || url.pathname === '/index.html') file = path.join(root, 'desktop', 'index.html');
    else if (url.pathname === '/styles.css' || url.pathname === '/renderer.js') file = path.join(root, 'desktop', path.basename(url.pathname));
    else if (url.pathname.startsWith('/assets/')) file = path.join(root, url.pathname);
    if (!file || !file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
    let body = fs.readFileSync(file);
    if (url.pathname === '/' || url.pathname === '/index.html') body = Buffer.from(body.toString('utf8').replace('<script src="renderer.js"></script>', '<script src="preview-bridge.js"></script><script src="renderer.js"></script>').replace('../assets/', '/assets/'));
    const types = {'.html':'text/html','.css':'text/css','.js':'application/javascript','.png':'image/png','.ico':'image/x-icon'};
    res.writeHead(200, {'content-type':types[path.extname(file)] || 'application/octet-stream'}); res.end(body);
}).listen(port, '127.0.0.1', () => console.log(`UI preview listening at http://127.0.0.1:${port}`));
