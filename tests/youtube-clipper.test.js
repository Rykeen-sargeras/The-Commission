'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const Module = require('module');
const os = require('os');
const path = require('path');

const clipTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commission-clipper-test-'));
process.env.CLIP_STORAGE_DIR = clipTestDir;

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === '@distube/ytdl-core') return {};
  if (request === 'ffmpeg-static') return 'ffmpeg';
  return originalLoad.call(this, request, parent, isMain);
};
const {
  CLIP_RETENTION_HOURS,
  MAX_CLIP_SECONDS,
  clipperPassword,
  formatTimestamp,
  parseTimestamp,
  parseYouTubeVideoId,
  publicBaseUrl,
  safeFilename,
} = require('../youtube_clipper_preload');
Module._load = originalLoad;

assert.strictEqual(CLIP_RETENTION_HOURS, 3);
assert.strictEqual(MAX_CLIP_SECONDS, 900);
process.env.CLIPPER_PASSWORD = 'clipper-only-test-password';
assert.strictEqual(clipperPassword(), 'clipper-only-test-password');
delete process.env.CLIPPER_PASSWORD;
assert.strictEqual(parseTimestamp('1:23'), 83);
assert.strictEqual(parseTimestamp('1:02:03'), 3723);
assert.strictEqual(parseTimestamp('9.5'), 9.5);
assert.throws(() => parseTimestamp('wat'), /seconds/);
assert.strictEqual(parseYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ?t=10'), 'dQw4w9WgXcQ');
assert.strictEqual(parseYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
assert.strictEqual(parseYouTubeVideoId('https://youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
assert.throws(() => parseYouTubeVideoId('https://example.com/watch?v=dQw4w9WgXcQ'), /valid YouTube/);
assert.strictEqual(safeFilename('  My: Clip!?  '), 'My-Clip');
assert.strictEqual(formatTimestamp(3723), '1:02:03');
assert.strictEqual(publicBaseUrl({ headers: { host: 'the-commission-production.up.railway.app', 'x-forwarded-proto': 'https' } }), 'https://the-commission-production.up.railway.app');

function request(port, options, body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, ...options }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

(async () => {
  process.env.CLIPPER_PASSWORD = 'website-test-password';
  const server = http.createServer((req, res) => { res.writeHead(404); res.end('fallback'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const loginBody = 'password=' + encodeURIComponent(process.env.CLIPPER_PASSWORD);
    const login = await request(port, { method: 'POST', path: '/clipper/login', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(loginBody) } }, loginBody);
    assert.strictEqual(login.status, 302);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const page = await request(port, { method: 'GET', path: '/clipper', headers: { Cookie: cookie } });
    assert.strictEqual(page.status, 200);
    assert.match(page.text, /Create a downloadable MP4/);
    assert.match(page.text, /Download MP4/);
    assert.doesNotMatch(page.text, /Discord|Google Drive/);

    const expiredFile = path.join(clipTestDir, 'expired.mp4');
    fs.writeFileSync(expiredFile, 'expired-test-file');
    const expiredAt = new Date(Date.now() - 4 * 60 * 60 * 1000);
    fs.utimesSync(expiredFile, expiredAt, expiredAt);
    const expired = await request(port, { method: 'GET', path: '/clips/expired.mp4' });
    assert.strictEqual(expired.status, 410);
    assert.strictEqual(fs.existsSync(expiredFile), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    delete process.env.CLIPPER_PASSWORD;
    delete process.env.CLIP_STORAGE_DIR;
    fs.rmSync(clipTestDir, { recursive: true, force: true });
  }
  console.log('youtube-clipper tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

