'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Discord = require('discord.js');
const {
  easternParts,
  operationalDate,
  resetCutoff,
  pruneForDailyReset,
  normalizeDate,
  normalizeTime,
  normalizeLink,
} = require('../going_live_time');

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

test('Eastern time follows standard and daylight-saving offsets', () => {
  assert.deepStrictEqual(easternParts(new Date('2026-01-15T12:00:00Z')), {
    date: '2026-01-15', hm: '07:00', hour: 7, minute: 0,
  });
  assert.deepStrictEqual(easternParts(new Date('2026-07-15T12:00:00Z')), {
    date: '2026-07-15', hm: '08:00', hour: 8, minute: 0,
  });
});

test('AM and PM choices convert correctly', () => {
  assert.deepStrictEqual(normalizeTime('12', 'AM'), { display: '12:00 AM', hm: '00:00' });
  assert.deepStrictEqual(normalizeTime('12:30', 'PM'), { display: '12:30 PM', hm: '12:30' });
  assert.deepStrictEqual(normalizeTime('7:05', 'PM'), { display: '7:05 PM', hm: '19:05' });
  assert.deepStrictEqual(normalizeTime('7:05 PM'), { display: '7:05 PM', hm: '19:05' });
  assert.throws(() => normalizeTime('13', 'PM'), /valid 12-hour time/);
});

test('a yearless date selects the next occurrence across New Year', () => {
  const now = new Date('2026-12-31T17:00:00Z');
  assert.strictEqual(normalizeDate('1/2', now), '2027-01-02');
  assert.strictEqual(normalizeDate('12/31', now), '2026-12-31');
  assert.throws(() => normalizeDate('2/30', now), /not valid/);
});

test('the schedule day rolls over at exactly 5 AM Eastern', () => {
  assert.strictEqual(operationalDate(new Date('2026-08-11T08:59:00Z')), '2026-08-10');
  assert.strictEqual(resetCutoff(new Date('2026-08-11T08:59:00Z')), '2026-08-10 05:00');
  assert.strictEqual(operationalDate(new Date('2026-08-11T09:00:00Z')), '2026-08-11');
  assert.strictEqual(resetCutoff(new Date('2026-08-11T09:00:00Z')), '2026-08-11 05:00');
});

test('daily reset clears the previous board and stale pending requests', () => {
  const entries = [
    { id: 'old', date: '2026-08-10', hm: '20:00', status: 'active' },
    { id: 'early', date: '2026-08-11', hm: '04:59', status: 'pending' },
    { id: 'boundary', date: '2026-08-11', hm: '05:00', status: 'active' },
    { id: 'future', date: '2026-08-12', hm: '19:00', status: 'active' },
  ];
  assert.deepStrictEqual(
    pruneForDailyReset(entries, new Date('2026-08-11T09:00:00Z')).map(entry => entry.id),
    ['boundary', 'future'],
  );
});

test('stream links only allow complete HTTP(S) URLs', () => {
  assert.strictEqual(normalizeLink(''), '');
  assert.strictEqual(normalizeLink('https://twitch.tv/example'), 'https://twitch.tv/example');
  assert.throws(() => normalizeLink('javascript:alert(1)'), /http:\/\/ or https:\/\//);
  assert.throws(() => normalizeLink('twitch.tv/example'), /complete/);
});


test('/whoslive is registered as the graphic board repost command', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'going_live.js'), 'utf8');
  assert.match(source, /name:\s*'whoslive'/);
  assert.match(source, /interaction\.commandName === 'whoslive'/);
  assert.match(source, /async function handleWho[\s\S]*await repostBoard\(client\)/);
  assert.match(source, /renderScheduleImages/);
});

test('graphic schedules paginate after five streamers', () => {
  const { schedulePages, boardEmbeds } = require('../going_live');
  const entries = Array.from({ length: 6 }, (_, index) => ({ date: '2026-09-04', username: `Streamer ${index + 1}` }));
  const pages = schedulePages(entries);
  assert.strictEqual(pages.length, 2);
  assert.strictEqual(pages[0].rows.length, 5);
  assert.strictEqual(pages[1].rows.length, 1);

  const embeds = boardEmbeds(entries, ['whos-live-1.jpg', 'whos-live-2.jpg']);
  assert.strictEqual(embeds.length, 2);
  assert.strictEqual(embeds[0].toJSON().image.url, 'attachment://whos-live-1.jpg');
  assert.strictEqual(embeds[1].toJSON().image.url, 'attachment://whos-live-2.jpg');
});

test('/goinglive uses only channel, title, time, and link fields', () => {
  const { GOING_LIVE_COMMAND, REMOVE_COMMAND } = require('../going_live');
  assert.deepStrictEqual(GOING_LIVE_COMMAND.options.map(option => option.name), ['channel', 'title', 'time', 'link']);
  assert.strictEqual(GOING_LIVE_COMMAND.options.every(option => option.required), true);
  assert.strictEqual(REMOVE_COMMAND.name, 'remove');
  assert.strictEqual(REMOVE_COMMAND.default_member_permissions, Discord.PermissionFlagsBits.Administrator.toString());
});

test('graphic text is converted to font-independent SVG outlines', () => {
  const { normalizeGraphicText, outlineText } = require('../going_live');
  assert.strictEqual(normalizeGraphicText('𝐑𝐲𝐤𝐞𝐞𝐧'), 'Rykeen');
  const markup = outlineText('Friday Night Live', 640, 350, 28);
  assert.match(markup, /^<path d="/);
  assert.doesNotMatch(markup, /<text|font-family/);
});

test('confirmed schedule additions repost instead of only editing the board', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'going_live.js'), 'utf8');
  assert.match(source, /store\.entries\.push\(entry\); writeStore\(store\);\s*await repostBoard\(client\)/);
  assert.match(source, /previous\.delete\(\)/);
  assert.match(source, /channel\.send\(/);
});

console.log('Going Live tests passed.');
