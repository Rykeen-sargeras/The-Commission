'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const special = require('../economy_special_events');
special.installSpecialEconomyEvents();
const { EconomyService } = require('../economy');

assert.strictEqual(special.HEIST_CHANNEL_ID, '1547079010637578301');
assert.strictEqual(special.HEIST_ENTRY_FEE, 10_000);
assert.strictEqual(special.HEIST_INTERVAL_MS, 30 * 60 * 1000);
assert.strictEqual(special.HEIST_SIGNUP_MS, (9 * 60 + 30) * 1000);
assert.strictEqual(special.MAX_ROBBERY_PERCENT, 10);
assert.strictEqual(special.shouldAnnounceHeistResult({ phase: 'cooldown', round: { status: 'cancelled', participantCount: 0 } }), false);
assert.strictEqual(special.shouldAnnounceHeistResult({ phase: 'cooldown', round: { status: 'cancelled', participantCount: 1 } }), true);
assert.strictEqual(special.shouldAnnounceHeistResult({ phase: 'cooldown', round: { status: 'complete', participantCount: 2 } }), true);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'commission-special-events-'));
const service = new EconomyService({
    dbPath: path.join(temp, 'economy.sqlite'),
    random: () => 0.99,
});

try {
    assert.strictEqual(service.config.heistChannelId, special.HEIST_CHANNEL_ID);
    assert.strictEqual(service.config.gamblingDailyWagerCap, 0);
    assert.strictEqual(service.config.gamblingHourlyWagerCap, 0);
    assert.strictEqual(service.diceMaximumWager(), null);

    const start = Date.UTC(2026, 8, 8, 12, 0, 0);
    const schedule = service.heistSchedule(start + 1000);
    assert.strictEqual(schedule.startsAt, start);
    assert.strictEqual(schedule.signupEndsAt, start + special.HEIST_SIGNUP_MS);
    assert.strictEqual(schedule.nextAt, start + special.HEIST_INTERVAL_MS);

    service.admin('guild', 'add', 'attacker-one', 50_000, 'fund-one', start);
    service.admin('guild', 'add', 'attacker-two', 50_000, 'fund-two', start);
    service.admin('guild', 'add', 'victim', 100_000, 'fund-victim', start);
    const state = service.heistState('guild', start + 1000);
    assert.strictEqual(state.phase, 'signup');
    service.joinHeist('guild', 'attacker-one', state.round.round_id, 'join-one', start + 2000);
    service.joinHeist('guild', 'attacker-two', state.round.round_id, 'join-two', start + 3000);
    const result = service.resolveHeist(state.round.round_id, schedule.signupEndsAt);
    assert.strictEqual(result.status, 'complete');
    assert.strictEqual(result.eventType, 'normal');
    assert.strictEqual(result.variant, 'robbery');
    assert.strictEqual(result.victimId, 'victim');
    assert(result.stolenAmount > 0 && result.stolenAmount <= 10_000);
    assert(result.story.some(line => line.includes('<@victim>')));
    assert.strictEqual(result.entries.filter(entry => entry.payout > 0).length, 1);

    service.admin('unlimited', 'add', 'gambler', 500_000, 'fund-gambler', start);
    service.random = () => 0.5;
    for (let index = 0; index < 8; index += 1) {
        assert.strictEqual(service.dice('unlimited', 'gambler', 25_000, `dice-${index}`, start + index).wager, 25_000);
    }
    service.random = () => 0.999999;
    assert.strictEqual(service.dice('unlimited', 'gambler', 100_000, 'large-jackpot', start + 20).multiplier, 100);

    console.log('Economy special-event tests passed.');
} finally {
    service.close();
    fs.rmSync(temp, { recursive: true, force: true });
}
