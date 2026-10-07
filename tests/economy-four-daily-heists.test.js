'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const economyModule = require('../economy');
const fourDaily = require('../economy_heist_four_daily_patch');

assert.strictEqual(fourDaily.SOLO_HEIST_ENTRY_FEE, 1_000_000);
assert.strictEqual(fourDaily.SOLO_HEIST_COOLDOWN_MS, 3 * 60 * 60 * 1000);
assert.strictEqual(fourDaily.SOLO_HEIST_SUCCESS_CHANCE, 55);
assert.strictEqual(fourDaily.SOLO_HEIST_PAYOUT_MULTIPLIER, 1.5);

fourDaily.installFourDailyHeists();
const { EconomyService } = economyModule;

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'commission-solo-heist-'));
const service = new EconomyService({
    dbPath: path.join(temp, 'economy.sqlite'),
    random: () => 0,
});

try {
    service.admin('guild', 'add', 'solo-user', 2_000_000, 'fund-solo');
    const first = service.soloHeist('guild', 'solo-user', 'solo-heist-1', 1_000);
    assert.strictEqual(first.success, true);
    assert.strictEqual(first.wager, 1_000_000);
    assert.strictEqual(first.payout, 1_500_000);
    assert.strictEqual(first.balance, 2_500_000);
    assert.strictEqual(first.nextAt, 1_000 + (3 * 60 * 60 * 1000));

    const cooldown = service.soloHeist('guild', 'solo-user', 'solo-heist-2', 2_000);
    assert(cooldown.cooldown > 0);
    assert.strictEqual(cooldown.nextAt, first.nextAt);

    console.log('Four-daily solo heist tests passed.');
} finally {
    service.close();
    fs.rmSync(temp, { recursive: true, force: true });
}
