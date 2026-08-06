'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SecretBox } = require('../memberbridge/crypto');
const { batches, MembershipEngine } = require('../memberbridge/engine');
const { MemberBridgeStore } = require('../memberbridge/store');
const { SimulatedYouTubeClient } = require('../memberbridge/youtube');
const { STATUS } = require('../memberbridge/constants');

class FakeRoles {
    constructor() { this.byUser = new Map(); this.operations = []; }
    roles(userId) { if (!this.byUser.has(userId)) this.byUser.set(userId, new Set()); return this.byUser.get(userId); }
    async validate() { return {}; }
    async operate({ record, roleId, operation }) {
        if (operation === 'add') this.roles(record.discord_user_id).add(roleId);
        else this.roles(record.discord_user_id).delete(roleId);
        this.operations.push({ userId: record.discord_user_id, roleId, operation });
    }
}

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commission-memberbridge-'));
    const store = new MemberBridgeStore({ dataDir: dir, secretBox: new SecretBox(crypto.randomBytes(32).toString('base64')) });
    const fakeRoles = new FakeRoles();
    const simulator = new SimulatedYouTubeClient(store);
    const engine = new MembershipEngine({ store, youtube: null, simulatedYoutube: simulator, roleAdapter: fakeRoles, simulationMode: true });
    return { dir, store, fakeRoles, engine, close() { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function creator(f, guildId = '12345678901234567', name = 'Misfit Mafia') {
    const row = f.store.createCreator({ guildId, displayName: name, missingChecksBeforeGrace: 2, gracePeriodHours: 168, massAbsencePercent: 20 });
    f.store.updateCreator(row.id, { enabled: 1, connection_status: 'Operational' });
    f.store.saveLevels(row.id, [
        { id: 'LEVEL_ASSOCIATE', displayName: 'Associate' },
        { id: 'LEVEL_UNDERBOSS', displayName: 'Underboss' },
    ]);
    f.store.setRoleMapping(row.id, 'LEVEL_ASSOCIATE', '22345678901234567');
    f.store.setRoleMapping(row.id, 'LEVEL_UNDERBOSS', '32345678901234567');
    return f.store.getCreator(row.id);
}

function linked(f, creatorRow, suffix = '01') {
    const discordUserId = `4${suffix.padStart(16, '0')}`;
    const youtubeChannelId = `UC_MEMBER_${suffix}`;
    f.store.linkAccount({ guildId: creatorRow.guild_id, discordUserId, discordUsername: `member-${suffix}`, youtubeChannelId, youtubeDisplayName: `YouTube ${suffix}` });
    return { discordUserId, youtubeChannelId };
}

async function run() {
    assert.deepStrictEqual(batches(Array.from({ length: 100 }, (_, i) => i)).map(group => group.length), [100]);
    assert.deepStrictEqual(batches(Array.from({ length: 101 }, (_, i) => i)).map(group => group.length), [100, 1]);

    {
        const f = fixture();
        try {
            const c = creator(f);
            const user = linked(f, c);
            f.store.simulatorSetMember({ creatorId: c.id, youtubeChannelId: user.youtubeChannelId, displayName: 'Member', highestLevelId: 'LEVEL_UNDERBOSS', accessibleLevelIds: ['LEVEL_ASSOCIATE','LEVEL_UNDERBOSS'], active: true });
            const result = await f.engine.verifyCreator(c.id);
            assert.equal(result.active, 1);
            assert.equal(f.store.userRecords(c.guild_id, user.discordUserId)[0].status, STATUS.ACTIVE);
            assert(f.fakeRoles.roles(user.discordUserId).has('32345678901234567'));
            assert(!f.fakeRoles.roles(user.discordUserId).has('22345678901234567'), 'highest-only mode must not add lower roles');

            f.store.simulatorSetMember({ creatorId: c.id, youtubeChannelId: user.youtubeChannelId, highestLevelId: 'LEVEL_ASSOCIATE', accessibleLevelIds: ['LEVEL_ASSOCIATE'], active: true });
            await f.engine.verifyCreator(c.id);
            assert(f.fakeRoles.roles(user.discordUserId).has('32345678901234567'), 'first downgrade report preserves the higher role');
            await f.engine.verifyCreator(c.id);
            assert(f.fakeRoles.roles(user.discordUserId).has('22345678901234567'), 'downgrade replacement added');
            assert(!f.fakeRoles.roles(user.discordUserId).has('32345678901234567'), 'old higher role removed after replacement');

            f.store.simulatorSetMember({ creatorId: c.id, youtubeChannelId: user.youtubeChannelId, active: false });
            await f.engine.verifyCreator(c.id);
            assert.equal(f.store.userRecords(c.guild_id, user.discordUserId)[0].status, STATUS.PENDING_MISSING);
            assert(f.fakeRoles.roles(user.discordUserId).has('22345678901234567'), 'first missing check preserves role');
            await f.engine.verifyCreator(c.id);
            let record = f.store.userRecords(c.guild_id, user.discordUserId)[0];
            assert.equal(record.status, STATUS.GRACE);
            assert(f.fakeRoles.roles(user.discordUserId).has('22345678901234567'), 'grace preserves role');

            f.store.simulatorSetFailure(c.id, 'timeout');
            await f.engine.verifyCreator(c.id);
            record = f.store.userRecords(c.guild_id, user.discordUserId)[0];
            assert.equal(record.status, STATUS.UNAVAILABLE);
            assert.equal(record.consecutive_missing_checks, 2, 'API outage cannot count as absence');
            assert(f.fakeRoles.roles(user.discordUserId).has('22345678901234567'), 'API outage preserves role');

            f.store.simulatorSetFailure(c.id, '');
            f.store.simulatorSetMember({ creatorId: c.id, youtubeChannelId: user.youtubeChannelId, highestLevelId: 'LEVEL_UNDERBOSS', accessibleLevelIds: ['LEVEL_ASSOCIATE','LEVEL_UNDERBOSS'], active: true });
            await f.engine.verifyCreator(c.id);
            record = f.store.userRecords(c.guild_id, user.discordUserId)[0];
            assert.equal(record.status, STATUS.ACTIVE);
            assert.equal(record.consecutive_missing_checks, 0);
            assert(f.fakeRoles.roles(user.discordUserId).has('32345678901234567'));
        } finally { f.close(); }
    }

    {
        const f = fixture();
        try {
            const c = creator(f);
            const user = linked(f, c, '22');
            f.store.simulatorSetMember({ creatorId: c.id, youtubeChannelId: user.youtubeChannelId, highestLevelId: 'LEVEL_UNKNOWN', accessibleLevelIds: ['LEVEL_UNKNOWN'], active: true });
            await f.engine.verifyCreator(c.id);
            const record = f.store.userRecords(c.guild_id, user.discordUserId)[0];
            assert.equal(record.status, STATUS.UNMAPPED);
            assert.equal(f.fakeRoles.operations.length, 0, 'unknown levels do not guess a role');
        } finally { f.close(); }
    }

    {
        const f = fixture();
        try {
            const c = creator(f);
            const users = Array.from({ length: 5 }, (_, index) => linked(f, c, String(100 + index)));
            for (const user of users) f.store.simulatorSetMember({ creatorId: c.id, youtubeChannelId: user.youtubeChannelId, highestLevelId: 'LEVEL_ASSOCIATE', accessibleLevelIds: ['LEVEL_ASSOCIATE'], active: true });
            await f.engine.verifyCreator(c.id);
            for (const user of users) f.store.simulatorSetMember({ creatorId: c.id, youtubeChannelId: user.youtubeChannelId, active: false });
            const result = await f.engine.verifyCreator(c.id);
            assert.equal(result.safeMode, true, 'mass absence enables safe mode');
            assert.equal(f.store.getCreator(c.id).safe_mode, 1);
            for (const user of users) assert(f.fakeRoles.roles(user.discordUserId).has('22345678901234567'));
        } finally { f.close(); }
    }

    {
        const f = fixture();
        try {
            const first = creator(f, '12345678901234567', 'Creator A');
            const second = creator(f, '12345678901234567', 'Creator B');
            assert.notEqual(first.id, second.id, 'multiple unconnected creators must coexist');
            linked(f, first, '88');
            const token = 'one-time-link-token';
            const session = f.store.createLinkSession({ token, guildId: first.guild_id, discordUserId: '92345678901234567', expiresUtc: new Date(Date.now() + 600000).toISOString() });
            assert(f.store.findLinkSession(token));
            assert.notEqual(session.token_hash, token, 'raw link token is not stored');
            f.store.updateLinkSession(session.id, { used_utc: nowForTest() });
            assert(f.store.findLinkSession(token).used_utc, 'session becomes single use');
            const record = f.store.creatorRecords(first.id)[0];
            const override = f.store.createOverride({ recordId: record.id, overrideType: 'PreserveCurrentRole', reason: 'test', administratorUserId: 'owner', expiresUtc: new Date(Date.now() + 60000).toISOString() });
            assert.equal(f.store.activeOverride(record.id).id, override.id);
            assert(f.store.removeOverride(record.id, 'owner'));
            assert.equal(f.store.activeOverride(record.id), undefined);
            const backup = f.store.createBackup();
            assert(backup.valid, 'created backup passes manifest hash and SQLite integrity');
            assert(f.store.verifyBackup(backup.fileName).valid);
        } finally { f.close(); }
    }

    {
        const f = fixture();
        try {
            const guildId = '12345678901234567';
            const panel = f.store.saveVerifyPanel(guildId, {
                categoryId: '1532513761573863577',
                channelId: '1534990967923282080',
                messageId: '1535990967923282080',
            });
            assert.equal(panel.category_id, '1532513761573863577');
            assert.equal(panel.channel_id, '1534990967923282080');
            assert.equal(f.store.getVerifyPanel(guildId).message_id, '1535990967923282080');
            assert(f.store.clearVerifyPanel(guildId));
            assert.equal(f.store.getVerifyPanel(guildId), undefined);
        } finally { f.close(); }
    }

    console.log('MemberBridge tests passed.');
}

function nowForTest() { return new Date().toISOString(); }

run().catch(error => { console.error(error); process.exitCode = 1; });
