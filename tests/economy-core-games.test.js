'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const economy = require('../economy');
const slots = require('../economy/slots');
const { EconomyService } = economy;

assert.strictEqual(economy.GAME_HOURLY_LIMIT, null);
assert.strictEqual(economy.DICE_PAYOUT_TABLE.reduce((sum, outcome) => sum + outcome.weight, 0), 10000);
assert.strictEqual(Number(economy.diceExpectedReturn().toFixed(3)), 0.934);
assert.strictEqual(Number(economy.diceHouseEdge().toFixed(3)), 0.066);

const slotSymbols = slots.serverSymbols({ emojis: { cache: new Map() } });
assert.strictEqual(slotSymbols.length, 10);
assert.strictEqual(slotSymbols.at(-1).wild, true);
assert.strictEqual(slots.spinGrid(slotSymbols, () => 0.5).length, 20);
assert.deepStrictEqual(slotSymbols.map(symbol => symbol.chance), [24, 20, 15.5, 12, 9, 7, 5, 3, 1, 3.5]);
assert.strictEqual(slots.symbolChanceTotal(slotSymbols), 100);
assert.strictEqual(Number(slots.slotsExpectedReturn().toFixed(3)), 1.028);
assert.strictEqual(slots.evaluateGrid(slots.maxWinGrid(slotSymbols)).multiplier, 115);

const uniqueGrid = Array.from({ length: 20 }, (_, index) => ({
    key: `unique-${index}`, render: String(index), payouts: { 3: 0.5, 4: 2, 5: 6 }, chance: 1, wild: false,
}));
const winningSymbol = { key: 'winner', render: '🍒', payouts: { 3: 0.5, 4: 2, 5: 6 }, chance: 24, wild: false };
uniqueGrid[0] = winningSymbol;
uniqueGrid[1] = { ...slots.WILD };
uniqueGrid[2] = winningSymbol;
uniqueGrid[3] = winningSymbol;
uniqueGrid[4] = winningSymbol;
const wildResult = slots.evaluateGrid(uniqueGrid);
assert.strictEqual(wildResult.wins.length, 1);
assert.strictEqual(wildResult.wins[0].count, 5);
assert.strictEqual(wildResult.wins[0].wilds, 1);
assert.strictEqual(wildResult.wins[0].multiplier, 6);

const shortWinGrid = Array.from({ length: 20 }, (_, index) => ({
    key: `short-${index}`, render: String(index), payouts: { 3: 0.5, 4: 2, 5: 6 }, chance: 1, wild: false,
}));
shortWinGrid[0] = winningSymbol;
shortWinGrid[1] = winningSymbol;
shortWinGrid[2] = winningSymbol;
assert.strictEqual(slots.evaluateGrid(shortWinGrid).wins[0].multiplier, 0.5);

let simulationSeed = 0x5eed1234;
const simulationRandom = () => {
    simulationSeed = (Math.imul(1664525, simulationSeed) + 1013904223) >>> 0;
    return simulationSeed / 0x100000000;
};
let aboveFive = 0;
let aboveTen = 0;
const simulationSpins = 50_000;
for (let index = 0; index < simulationSpins; index += 1) {
    const result = slots.evaluateGrid(slots.spinGrid(slotSymbols, simulationRandom));
    if (result.multiplier > 5) aboveFive += 1;
    if (result.multiplier > 10) aboveTen += 1;
}
assert(aboveFive / simulationSpins > 0.045, 'More than 4.5% of spins should pay above 5×.');
assert(aboveTen / simulationSpins > 0.009, 'More than 0.9% of spins should pay above 10×.');

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
    service.admin('guild', 'add', 'max-win-user', 1000, 'fund-max-win');
    assert.deepStrictEqual(service.armSlotsMaxWin('guild', 'max-win-user'), {
        guildId: 'guild', userId: 'max-win-user', multiplier: 115,
    });
    const maxWin = service.slots('guild', 'max-win-user', 10, 'forced-max-win', slotSymbols);
    assert.strictEqual(maxWin.forcedMaxWin, true);
    assert.strictEqual(maxWin.multiplier, 115);
    assert.strictEqual(maxWin.payout, 1150);
    assert.strictEqual(service.setting('guild', slots.maxWinSettingKey('max-win-user')), '');
    const followingSpin = service.slots('guild', 'max-win-user', 10, 'ordinary-follow-up', slotSymbols);
    assert.strictEqual(followingSpin.forcedMaxWin, false);
    assert.notStrictEqual(followingSpin.multiplier, 115);

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

    for (let index = 0; index < 7; index += 1) {
        service.dice('guild', 'limit-user', 1, `dice-${index}`, now + index);
    }
    assert.strictEqual(service.dice('guild', 'limit-user', 1, 'dice-8', now + 10).wager, 1);

    // Poker has its own six-game bucket even after the same member used all six dice plays.
    for (let index = 0; index < 7; index += 1) {
        const game = service.startPoker('guild', 'limit-user', 1, `poker-limit-${index}`, now + 20 + index);
        assert(game.gameId);
        service.drawPoker(game.gameId, 'limit-user', now + 20 + index);
    }
    const unlimitedPoker = service.startPoker('guild', 'limit-user', 1, 'poker-limit-8', now + 40);
    assert(unlimitedPoker.gameId);

    console.log('Economy core game tests passed.');
} finally {
    service.close();
    fs.rmSync(temp, { recursive: true, force: true });
}
