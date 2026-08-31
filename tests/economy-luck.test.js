'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const luck = require('../economy/luck');
const { EconomyService } = require('../economy');

assert.strictEqual(luck.PERSONAL_LUCK_ITEMS['luck-1'].cost, 5000);
assert.strictEqual(luck.PERSONAL_LUCK_ITEMS['luck-5'].percent, 5);
assert.strictEqual(luck.PERSONAL_LUCK_ITEMS['luck-10'].cost, 250000);
assert.strictEqual(luck.GLOBAL_LUCK_COST, 1000);
assert.strictEqual(luck.GLOBAL_LUCK_PERCENT, 0.5);
assert.strictEqual(luck.GLOBAL_LUCK_DURATION_MS, 24 * 60 * 60 * 1000);
assert.strictEqual(luck.DAILY_TIERS.reduce((sum, tier) => sum + tier.weight, 0), 1_000_000);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'commission-luck-store-'));
const sequence = [0, 0, 0, 0, 0, 0, 0, 0];
const service = new EconomyService({
    dbPath: path.join(temp, 'economy.sqlite'),
    random: () => sequence.shift() ?? 0,
    config: { heistChannelId: '123456789012345678' },
});

try {
    assert.strictEqual(service.config.heistChannelId, '');
    assert.strictEqual(service.retiredHeistChannelId, '123456789012345678');
    assert.throws(() => service.createHeistRound('guild'), /retired/i);

    service.admin('guild', 'add', 'user', 400000, 'fund-user');
    const one = service.buyLuckItem('guild', 'user', 'luck-1', 'buy-1', 1000);
    assert.strictEqual(one.personalLuck, 1);
    const five = service.buyLuckItem('guild', 'user', 'luck-5', 'buy-5', 2000);
    assert.strictEqual(five.personalLuck, 6);
    const ten = service.buyLuckItem('guild', 'user', 'luck-10', 'buy-10', 3000);
    assert.strictEqual(ten.personalLuck, 16);
    assert.throws(() => service.buyLuckItem('guild', 'user', 'luck-1', 'buy-1-again', 4000), /one-time purchase/i);

    const global = service.contributeGlobalLuck('guild', 'user', 'global-1', 5000);
    assert.strictEqual(global.globalLuck, 0.5);
    assert.strictEqual(global.totalLuck, 16.5);
    assert.strictEqual(global.expiresAt, 5000 + (24 * 60 * 60 * 1000));
    assert.throws(() => service.contributeGlobalLuck('guild', 'user', 'global-again', 6000), /already added/i);

    service.admin('guild', 'add', 'daily-user', 1, 'fund-daily');
    const daily = service.claimDaily('guild', 'daily-user', 'daily-1', 10_000);
    assert(daily.rngReward >= 1 && daily.rngReward <= 10000);
    assert.strictEqual(daily.streakBonus, 100);
    assert.strictEqual(daily.reward, daily.rngReward + 100);

    const sevenDaysLater = 10_000 + (24 * 60 * 60 * 1000) * 6;
    service.db.prepare('UPDATE economy_members SET last_daily_claim=?,daily_streak=6 WHERE guild_id=? AND user_id=?')
        .run(sevenDaysLater - (24 * 60 * 60 * 1000), 'guild', 'daily-user');
    const daySeven = service.claimDaily('guild', 'daily-user', 'daily-7', sevenDaysLater);
    assert.strictEqual(daySeven.cappedStreak, 7);
    assert.strictEqual(daySeven.streakBonus, 700);

    console.log('Economy Luck Shop tests passed.');
} finally {
    service.close();
    fs.rmSync(temp, { recursive: true, force: true });
}
