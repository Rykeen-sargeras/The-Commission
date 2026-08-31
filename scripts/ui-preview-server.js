'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 18991);
const mock = `window.commission={
 bootstrap:async()=>({authenticated:true,config:{settings:{},hasDiscordToken:true},status:{state:'running',dashboardReady:true,pid:1234,logs:[]}}),
 login:async()=>({ok:true}),lock:async()=>({}),saveConfig:async p=>({config:{settings:p.settings}}),startBot:async()=>({state:'running'}),stopBot:async()=>({state:'stopped'}),openDashboard:async()=>({}),openDataFolder:async()=>({}),listBlueprints:async()=>[],onStatus:()=>{},onLog:()=>{},
 getEconomyStats:async()=>({}),getEconomyLeaderboard:async()=>[],pushHeistPanel:async()=>({}),previewEconomyReset:async()=>({}),executeEconomyReset:async()=>({}),previewBulkGrant:async()=>({}),executeBulkGrant:async()=>({}),listGuilds:async()=>[],captureBlueprint:async()=>({}),applyBlueprint:async()=>({})
};`;

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
