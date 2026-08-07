'use strict';

const http = require('http');

const port = Number(process.env.PORT || 8080);
const host = '0.0.0.0';

const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, service: 'the-commission', memberBridge: 'retired' }));
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(port, host, () => {
    console.log(`[Railway] Health server listening on ${host}:${port}`);
});

server.on('error', error => {
    console.error('[Railway] Health server failed:', error);
    process.exitCode = 1;
});

require('./discord_bot.js');
