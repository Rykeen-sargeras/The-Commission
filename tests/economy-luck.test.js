'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const luck = require('../economy/luck');
const { myLuckPayload } = require('../economy/luck_panel');
const { EconomyService } = require('../economy');

assert.strictEqual(luck.PERSONAL_LUCK_ITEMS['luck-1'].cost, 5000);
assert.strictEqual(luck.PERSONAL_LUCK_ITEMS['luck-5'].percent, 5);
assert.strictEqual(luck.PERSONAL_LUCK_ITEMS['luck-10'].cost, 250000);
assert.strictEqual(luck.PRESTIGE_ITEMS['prestige-25m'].modifier, 2.5);
assert.strictEqual(luck.PRESTIGE_ITEMS['prestige-100m'].modifier, 10);
assert.strictEqual(luck.PRESTIGE_MASTER_COST, 50_000_000_000);
assert.strictEqual(luck.GLOBAL_LUCK_COST, 1000);
assert.strictEqual(luck.GLOBAL_LUCK_PERCENT, 0.75);
assert.strictEqual(luck.GLOBAL_LUCK_MAX_ACTIVE_PER_USER, 20);
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
    assert.strictEqual(service.config.heistChannelId, '123456789012345678');
    assert.strictEqual(service.createHeistRound('guild').status, 'signup');

    service.admin('guild', 'add', 'user', 400000, 'fund-user');
    const one = service.buyLuckItem('guild', 'user', 'luck-1', 'buy-1', 1000);
    assert.strictEqual(one.personalLuck, 1);
    const five = service.buyLuckItem('guild', 'user', 'luck-5', 'buy-5', 2000);
    assert.strictEqual(five.personalLuck, 6);
    const ten = service.buyLuckItem('guild', 'user', 'luck-10', 'buy-10', 3000);
    assert.strictEqual(ten.personalLuck, 16);
    assert.throws(() => service.buyLuckItem('guild', 'user', 'luck-1', 'buy-1-again', 4000), /one-time purchase/i);

    service.admin('guild', 'add', 'prestige-user', 220_000_000, 'fund-prestige');
    service.buyLuckItem('guild', 'prestige-user', 'luck-1', 'prestige-buy-luck-1', 4400);
    for (const prestigeKey of ['prestige-25m', 'prestige-30m', 'prestige-50m', 'prestige-100m']) {
        for (const luckKey of ['luck-5', 'luck-10', 'luck-25']) {
            service.buyLuckItem('guild', 'prestige-user', luckKey, `${prestigeKey}-${luckKey}`, 4500);
        }
        service.buyLuckItem('guild', 'prestige-user', prestigeKey, `buy-${prestigeKey}`, 4500);
    }
    const prestige = service.luckShopStatus('guild', 'prestige-user', 4600);
    assert.strictEqual(prestige.prestigeModifier, 20.5);
    assert.strictEqual(prestige.personalLuck, 161, 'Each Prestige cycle should permanently bank 5% + 10% + 25%, while 1% remains owned.');
    const masterPayload = myLuckPayload(service, 'guild', 'prestige-user');
    assert.strictEqual(masterPayload.components.length, 1);
    assert.strictEqual(masterPayload.components[0].components[0].data.label, 'Prestige Master');
    assert.match(masterPayload.embeds[0].data.description, /50,000,000,000/);
    assert.throws(() => service.claimPrestigeMaster('guild', 'prestige-user', 'master-poor', 4700), /need 50,000,000,000/i);
    service.admin('guild', 'add', 'prestige-user', 50_000_000_000, 'fund-master', 4750);
    const master = service.claimPrestigeMaster('guild', 'prestige-user', 'master-buy', 4800);
    assert.strictEqual(master.alreadyClaimed, false);
    assert.strictEqual(master.charged, 50_000_000_000);
    assert.strictEqual(service.audit('guild', 'prestige-user').some(row => row.type === 'prestige-master-purchase' && row.amount === -50_000_000_000), true);
    assert.strictEqual(service.claimPrestigeMaster('guild', 'prestige-user', 'master-restore', 4900).alreadyClaimed, true);

    const gifted = service.applyOneTimePrestigeGrant('gift-guild', 'gift-user', 'all-upgrades-test', 4900);
    assert.strictEqual(gifted.applied, true);
    assert.deepStrictEqual(new Set(gifted.grantedKeys), new Set([
        'luck-1', 'luck-5', 'luck-10', 'luck-25',
        'prestige-25m', 'prestige-30m', 'prestige-50m', 'prestige-100m',
    ]));
    assert.strictEqual(gifted.personalLuck, 41);
    assert.strictEqual(gifted.prestigeModifier, 20.5);
    assert.strictEqual(myLuckPayload(service, 'gift-guild', 'gift-user').components[0].components[0].data.label, 'Prestige Master');
    const duplicateGift = service.applyOneTimePrestigeGrant('gift-guild', 'gift-user', 'all-upgrades-test', 5000);
    assert.strictEqual(duplicateGift.applied, false);
    assert.deepStrictEqual(duplicateGift.grantedKeys, []);
    assert.strictEqual(service.luckShopStatus('gift-guild', 'gift-user').purchases.length, 8);

    const global = service.contributeGlobalLuck('guild', 'user', 'global-1', 5000);
    assert.strictEqual(global.globalLuck, 0.75);
    assert.strictEqual(global.totalLuck, 16.75);
    assert.strictEqual(global.expiresAt, 5000 + (24 * 60 * 60 * 1000));
    for (let index = 2; index <= 20; index += 1) {
        service.contributeGlobalLuck('guild', 'user', `global-${index}`, 5000 + index);
    }
    const stacked = service.luckShopStatus('guild', 'user', 6000);
    assert.strictEqual(stacked.activeGlobalContributionsByUser, 20);
    assert.strictEqual(stacked.globalLuck, 15);
    assert.strictEqual(stacked.totalLuck, 31);
    assert.throws(() => service.contributeGlobalLuck('guild', 'user', 'global-21', 7000), /maximum 20 active/i);

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
