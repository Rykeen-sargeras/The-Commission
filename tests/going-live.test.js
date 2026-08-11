'use strict';

const assert = require('assert');
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

console.log('Going Live tests passed.');
