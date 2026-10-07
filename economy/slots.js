'use strict';

const SLOT_COLUMNS = 5;
const SLOT_ROWS = 4;
const SLOT_CHANCES = Object.freeze([24, 20, 15.5, 12, 9, 7, 5, 3, 1]);
const SLOT_PAYOUTS = Object.freeze([
    Object.freeze({ 3: 0.5, 4: 2, 5: 6 }),
    Object.freeze({ 3: 0.75, 4: 2.5, 5: 8 }),
    Object.freeze({ 3: 1.25, 4: 3.5, 5: 10 }),
    Object.freeze({ 3: 1.5, 4: 5, 5: 15 }),
    Object.freeze({ 3: 2.5, 4: 7, 5: 20 }),
    Object.freeze({ 3: 4, 4: 10, 5: 30 }),
    Object.freeze({ 3: 6, 4: 15, 5: 50 }),
    Object.freeze({ 3: 10, 4: 30, 5: 100 }),
    Object.freeze({ 3: 25, 4: 75, 5: 250 }),
]);
const SLOT_FALLBACK = Object.freeze(['🍒','🍋','🍊','🍇','🔔','💎','🍀','👑','💰']);
const WILD = Object.freeze({
    key: 'wild', render: '🃏', name: 'Wild', chance: 3.5, weight: 3.5,
    payouts: Object.freeze({ 3: 50, 4: 150, 5: 500 }), wild: true,
});

// Each payline crosses the five reels from left to right on the row-major 5×4 grid.
const PAYLINES = Object.freeze([
    [0,1,2,3,4], [5,6,7,8,9], [10,11,12,13,14], [15,16,17,18,19],
    [0,6,12,8,4], [15,11,7,13,19],
    [0,6,7,8,4], [15,11,12,13,19],
    [5,1,7,13,9], [10,16,12,8,14],
    [5,11,17,13,9], [10,6,2,8,14],
]);

function serverSymbols(guild) {
    const custom = [...guild.emojis.cache.values()]
        .filter(emoji => !emoji.managed && emoji.available !== false)
        .slice(0, 9)
        .map(emoji => ({ key: emoji.id, render: emoji.toString(), name: emoji.name || 'emoji' }));
    const symbols = [...custom];
    for (let index = symbols.length; index < 9; index += 1) {
        symbols.push({ key: `fallback-${index}`, render: SLOT_FALLBACK[index], name: SLOT_FALLBACK[index] });
    }
    const regular = symbols.slice(0, 9).map((symbol, index) => ({
        ...symbol,
        chance: SLOT_CHANCES[index],
        weight: SLOT_CHANCES[index],
        payouts: SLOT_PAYOUTS[index],
        wild: false,
    }));
    return [...regular, { ...WILD }];
}

function symbolChanceTotal(symbols) {
    return symbols.reduce((sum, symbol) => sum + Number(symbol.chance || 0), 0);
}

function weightedSymbol(symbols, random) {
    const total = symbolChanceTotal(symbols);
    let pick = Math.min(0.999999999, Math.max(0, random())) * total;
    for (const symbol of symbols) {
        if (pick < symbol.chance) return symbol;
        pick -= symbol.chance;
    }
    return symbols[0];
}

function spinGrid(symbols, random) {
    return Array.from({ length: SLOT_COLUMNS * SLOT_ROWS }, () => weightedSymbol(symbols, random));
}

function roundedMultiplier(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function slotsExpectedReturn() {
    const wildProbability = WILD.chance / 100;
    let expectedPerLine = 0;
    SLOT_CHANCES.forEach((chance, index) => {
        const probability = chance / 100;
        const allowed = probability + wildProbability;
        const matchProbabilities = {
            3: ((allowed ** 3) - (wildProbability ** 3)) * (1 - allowed),
            4: ((allowed ** 4) - (wildProbability ** 4)) * (1 - allowed),
            5: (allowed ** 5) - (wildProbability ** 5),
        };
        for (const count of [3, 4, 5]) {
            expectedPerLine += matchProbabilities[count] * SLOT_PAYOUTS[index][count];
        }
    });
    expectedPerLine += (wildProbability ** 5) * WILD.payouts[5];
    return expectedPerLine * PAYLINES.length;
}

function evaluateLine(grid, line) {
    const lineSymbols = line.map(position => grid[position]);
    const payingSymbol = lineSymbols.find(symbol => !symbol.wild) || WILD;
    let count = 0;
    let wilds = 0;
    for (const symbol of lineSymbols) {
        if (!symbol.wild && symbol.key !== payingSymbol.key) break;
        count += 1;
        if (symbol.wild) wilds += 1;
    }
    if (count < 3) return null;
    return {
        symbol: payingSymbol,
        count,
        wilds,
        multiplier: payingSymbol.payouts[count],
    };
}

function evaluateGrid(grid) {
    if (!Array.isArray(grid) || grid.length !== SLOT_COLUMNS * SLOT_ROWS) {
        throw new Error(`Slots grid must contain exactly ${SLOT_COLUMNS * SLOT_ROWS} symbols.`);
    }
    const wins = [];
    PAYLINES.forEach((line, index) => {
        const win = evaluateLine(grid, line);
        if (win) wins.push({ line: index + 1, ...win });
    });
    return {
        wins,
        multiplier: roundedMultiplier(wins.reduce((sum, win) => sum + win.multiplier, 0)),
    };
}

function installSlots(EconomyService) {
EconomyService.prototype.slots = function slots(guildId, userId, wager, interactionId, symbols, now = Date.now()) {
    return this.transaction(() => {
        if (this.hasInteraction(guildId, interactionId)) throw new Error('This spin was already processed.');
        const amount = Math.max(1, Number.parseInt(wager, 10) || 0);
        const reserved = this.reserveWager(guildId, userId, amount, interactionId, `slots:${interactionId}`, now);

        let grid = spinGrid(symbols, this.random);
        let result = evaluateGrid(grid);
        let luckyRespins = false;
        if (result.multiplier === 0 && typeof this.luckProc === 'function' && this.luckProc(guildId, userId, now)) {
            const secondGrid = spinGrid(symbols, this.random);
            const secondResult = evaluateGrid(secondGrid);
            if (secondResult.multiplier > result.multiplier) {
                grid = secondGrid;
                result = secondResult;
            }
            luckyRespins = true;
        }

        const payout = Math.floor(reserved.amount * result.multiplier);
        let balance = reserved.balance;
        if (payout > 0) balance = this.applyDelta(guildId, userId, payout, 'slots-payout', `x${result.multiplier}`, null, now);
        const won = payout > reserved.amount;
        this.db.prepare(`UPDATE economy_members SET lifetime_won=lifetime_won+?, lifetime_lost=lifetime_lost+?,
            gambling_wins=gambling_wins+?, gambling_losses=gambling_losses+? WHERE guild_id=? AND user_id=?`)
            .run(payout, payout === 0 ? reserved.amount : 0, won ? 1 : 0, payout === 0 ? 1 : 0, guildId, userId);

        return {
            wager: reserved.amount,
            grid,
            wins: result.wins,
            multiplier: result.multiplier,
            payout,
            balance,
            luckyRespins,
        };
    });
};
}

module.exports = {
    SLOT_COLUMNS,
    SLOT_ROWS,
    SLOT_CHANCES,
    SLOT_PAYOUTS,
    SLOT_FALLBACK,
    WILD,
    PAYLINES,
    serverSymbols,
    symbolChanceTotal,
    spinGrid,
    slotsExpectedReturn,
    evaluateGrid,
    installSlots,
};
