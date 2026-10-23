'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const economyModule = require('../economy');
const fourDaily = require('../economy_heist_four_daily_patch');
const goons = require('../economy_heist_goons_patch');

assert.strictEqual(fourDaily.SOLO_HEIST_ENTRY_FEE, 1_000_000);
assert.strictEqual(fourDaily.SOLO_HEIST_COOLDOWN_MS, 3 * 60 * 60 * 1000);
assert.strictEqual(fourDaily.SOLO_HEIST_SUCCESS_CHANCE, 55);
assert.strictEqual(fourDaily.SOLO_HEIST_PAYOUT_MULTIPLIER, 1.5);
assert.strictEqual(fourDaily.heistSeason(Date.UTC(2026, 10, 15, 17)).id, 'thanksgiving');
assert.strictEqual(fourDaily.heistSeason(Date.UTC(2026, 11, 15, 17)).id, 'christmas');
assert.strictEqual(fourDaily.heistSeason(Date.UTC(2027, 0, 15, 17)).id, 'mobster');
assert(fourDaily.heistSeason(Date.UTC(2026, 10, 15, 17)).bosses.every(boss => boss.season === 'thanksgiving'));
assert(fourDaily.heistSeason(Date.UTC(2026, 11, 15, 17)).bosses.every(boss => boss.season === 'christmas'));

fourDaily.installFourDailyHeists();
goons.installHeistGoonsPatch();
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

    service.admin('prestige-heist', 'add', 'prestige-user', 30_000_000, 'fund-prestige-heist');
    service.buyLuckItem('prestige-heist', 'prestige-user', 'luck-1', 'prestige-heist-luck-1');
    service.buyLuckItem('prestige-heist', 'prestige-user', 'luck-5', 'prestige-heist-luck-5');
    service.buyLuckItem('prestige-heist', 'prestige-user', 'luck-10', 'prestige-heist-luck-10');
    service.buyLuckItem('prestige-heist', 'prestige-user', 'luck-25', 'prestige-heist-luck-25');
    service.buyLuckItem('prestige-heist', 'prestige-user', 'prestige-25m', 'buy-prestige-heist');
    service.random = () => 0.69;
    const boostedBoss = service.bossOutcome(
        { guild_id: 'prestige-heist', round_id: 'boosted-round' },
        [{ user_id: 'prestige-user' }],
        { id: 'boss', name: 'Test Boss', emoji: '👑' },
    );
    assert.strictEqual(boostedBoss.prestigeModifier, 2.5);
    assert.strictEqual(boostedBoss.chance, 70);
    assert.strictEqual(boostedBoss.success, true, 'Prestige should turn a 69% roll into a crew-heist success.');

    service.admin('prestige-solo', 'add', 'prestige-user', 30_000_000, 'fund-prestige-solo');
    service.buyLuckItem('prestige-solo', 'prestige-user', 'luck-1', 'prestige-solo-luck-1');
    service.buyLuckItem('prestige-solo', 'prestige-user', 'luck-5', 'prestige-solo-luck-5');
    service.buyLuckItem('prestige-solo', 'prestige-user', 'luck-10', 'prestige-solo-luck-10');
    service.buyLuckItem('prestige-solo', 'prestige-user', 'luck-25', 'prestige-solo-luck-25');
    service.buyLuckItem('prestige-solo', 'prestige-user', 'prestige-25m', 'buy-prestige-solo');
    service.random = () => 0.56;
    const boostedSolo = service.soloHeist('prestige-solo', 'prestige-user', 'prestige-solo-run', 5_000);
    assert.strictEqual(boostedSolo.chance, 57.5);
    assert.strictEqual(boostedSolo.prestigeModifier, 2.5);
    assert.strictEqual(boostedSolo.success, true, 'Prestige should increase solo-heist success chance.');

    console.log('Four-daily solo heist tests passed.');
} finally {
    service.close();
    fs.rmSync(temp, { recursive: true, force: true });
}
