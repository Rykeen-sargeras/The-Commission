'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MembershipStore, encryptJson, decryptJson, signState, verifyState, graceDecision } = require('../membership_store');

const secret = 'test-only-membership-secret';
const encrypted = encryptJson({ access_token: 'private', refresh_token: 'also-private' }, secret);
assert(!encrypted.includes('private'), 'OAuth credentials must not be stored in plaintext');
assert.deepStrictEqual(decryptJson(encrypted, secret), { access_token: 'private', refresh_token: 'also-private' });

const token = signState({ purpose: 'member-verify', discordUserId: '123' }, { MEMBERSHIP_STATE_SECRET: secret }, 60);
assert.equal(verifyState(token, { MEMBERSHIP_STATE_SECRET: secret }, 'member-verify').discordUserId, '123');
assert.throws(() => verifyState(`${token}x`, { MEMBERSHIP_STATE_SECRET: secret }, 'member-verify'));

const graceStart = new Date('2026-09-01T12:00:00Z').getTime();
const freshGrace = graceDecision(null, 3, graceStart);
assert.equal(freshGrace.expired, false);
assert.equal(freshGrace.graceExpiresAt, '2026-09-04T12:00:00.000Z');
assert.equal(graceDecision({ grace_expires_at: freshGrace.graceExpiresAt, lapse_detected_at: freshGrace.lapseDetectedAt }, 3, graceStart + 3 * 86400000).expired, true);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commission-membership-test-'));
try {
    const store = new MembershipStore({ dataDir: tempDir });
    const streamer = store.addStreamer({ displayName: 'Roxy', expectedChannelId: 'UC123', graceDays: 5 });
    store.createInvite(streamer.id, 'single-use-nonce', 60);
    store.consumeInvite(streamer.id, 'single-use-nonce');
    assert.throws(() => store.consumeInvite(streamer.id, 'single-use-nonce'), /already been used/);
    store.saveCreatorConnection(streamer.id, { id: 'UC123', title: 'Roxy Live' }, { access_token: 'access', refresh_token: 'refresh', expiry_date: 123 }, secret);
    store.replaceTiers(streamer.id, [{ youtubeLevelId: 'level-one', displayName: 'Supporter' }]);
    store.mapTier(streamer.id, 'level-one', 'discord-role-1');
    store.replaceTiers(streamer.id, [{ youtubeLevelId: 'level-one', displayName: 'Supporter renamed' }]);
    assert.equal(store.getStreamer(streamer.id).tiers[0].discordRoleId, 'discord-role-1', 'tier refresh must preserve its Discord role mapping');
    assert.equal(store.credentials(streamer.id, secret).refresh_token, 'refresh');
    store.upsertLink('discord-user', 'youtube-user', 'Viewer');
    assert.equal(store.listLinks()[0].youtubeChannelId, 'youtube-user');
    store.close();
} finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('membership encryption, state, grace period, and persistence tests passed');
