'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const patch = require('../economy_balance_patch');
const { EconomyService } = require('../economy');

assert.strictEqual(patch.GAME_HOURLY_LIMIT, 6);
assert.strictEqual(patch.DICE_PAYOUT_TABLE.reduce((sum, outcome) => sum + outcome.weight, 0), 10000);
assert.strictEqual(Number(patch.diceExpectedReturn().toFixed(3)), 0.934);
assert.strictEqual(Number(patch.diceHouseEdge().toFixed(3)), 0.066);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'commission-balance-patch-'));
const service = new EconomyService({
    dbPath: path.join(temp, 'economy.sqlite'),
    random: () => 0.5,
    config: {
        blackjackMaximumWager: 1000,
        blackjackDailyCap: 10000,
        pokerMaximumWager: 1000,
        pokerDailyCap: 10000,
    },
});

try {
    assert.strictEqual(service.createDeck().length, 52);
    assert.strictEqual(service.createDeck(2).length, 104);
    assert.strictEqual(service.createDeck(3).length, 156);

    service.admin('guild', 'add', 'blackjack-user', 1000, 'fund-blackjack');
    const blackjack = service.startBlackjack('guild', 'blackjack-user', 10, 'blackjack-start');
    const blackjackRow = service.db.prepare('SELECT deck FROM blackjack_games WHERE game_id=?').get(blackjack.game_id || blackjack.gameId);
    assert.strictEqual(JSON.parse(blackjackRow.deck).length, 152, 'Blackjack should deal from a three-deck shoe.');

    service.admin('guild', 'add', 'poker-user', 1000, 'fund-poker');
    const poker = service.startPoker('guild', 'poker-user', 10, 'poker-start');
    assert.strictEqual(service.pokerGame(poker.gameId).deckCards.length, 99, 'Poker should deal from a two-deck shoe.');
    assert.deepStrictEqual(
        service.evaluatePoker(['A♠', 'A♠', 'A♥', 'A♦', 'A♣']),
        { name: 'Five of a Kind', multiplier: 25 },
    );

    const now = Date.now();
    service.admin('guild', 'add', 'limit-user', 1000, 'fund-limit-user');

    for (let index = 0; index < 6; index += 1) {
        service.dice('guild', 'limit-user', 1, `dice-${index}`, now + index);
    }
    assert.throws(
        () => service.dice('guild', 'limit-user', 1, 'dice-7', now + 10),
        /hourly limit reached: maximum 6 game\(s\) per hour/i,
    );

    // Poker has its own six-game bucket even after the same member used all six dice plays.
    for (let index = 0; index < 6; index += 1) {
        const game = service.startPoker('guild', 'limit-user', 1, `poker-limit-${index}`, now + 20 + index);
        assert(game.gameId);
        service.drawPoker(game.gameId, 'limit-user', now + 20 + index);
    }
    assert.throws(
        () => service.startPoker('guild', 'limit-user', 1, 'poker-limit-7', now + 40),
        /hourly limit reached: maximum 6 game\(s\) per hour/i,
    );

    console.log('Economy balance patch tests passed.');
} finally {
    service.close();
    fs.rmSync(temp, { recursive: true, force: true });
}
