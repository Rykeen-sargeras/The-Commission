'use strict';

const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === '@distube/ytdl-core') return {};
  if (request === 'ffmpeg-static') return 'ffmpeg';
  return originalLoad.call(this, request, parent, isMain);
};
const {
  DISCORD_CHANNEL_ID,
  MAX_CLIP_SECONDS,
  clipperPassword,
  formatTimestamp,
  parseTimestamp,
  parseYouTubeVideoId,
  publicBaseUrl,
  safeFilename,
} = require('../youtube_clipper_preload');
Module._load = originalLoad;

assert.strictEqual(DISCORD_CHANNEL_ID, '1543329276735266926');
assert.strictEqual(MAX_CLIP_SECONDS, 120);
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

console.log('youtube-clipper tests passed');

