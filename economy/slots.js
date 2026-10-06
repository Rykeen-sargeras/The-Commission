'use strict';

const SLOT_COLUMNS = 5;
const SLOT_ROWS = 4;
const SLOT_MULTIPLIERS = Object.freeze([2, 3, 5, 8, 12, 18, 30, 50, 100]);
const SLOT_WEIGHTS = Object.freeze([260, 210, 160, 125, 90, 65, 45, 25, 10]);
const SLOT_FALLBACK = Object.freeze(['🍒','🍋','🍊','🍇','🔔','💎','🍀','👑','💰']);
const WILD = Object.freeze({ key: 'wild', render: '🃏', name: 'Wild', multiplier: 25, weight: 45, wild: true });
const MATCH_PAYOUT_FACTORS = Object.freeze({
    3: Object.freeze([0.15, 0.35]),
    4: Object.freeze([0.35, 0.65]),
    5: Object.freeze([0.75, 1.15]),
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
        multiplier: SLOT_MULTIPLIERS[index],
        weight: SLOT_WEIGHTS[index],
        wild: false,
    }));
    return [...regular, { ...WILD }];
}

function weightedSymbol(symbols, random) {
    const total = symbols.reduce((sum, symbol) => sum + symbol.weight, 0);
    let pick = Math.floor(Math.min(0.999999999, Math.max(0, random())) * total);
    for (const symbol of symbols) {
        if (pick < symbol.weight) return symbol;
        pick -= symbol.weight;
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
    const totalWeight = SLOT_WEIGHTS.reduce((sum, weight) => sum + weight, WILD.weight);
    const wildProbability = WILD.weight / totalWeight;
    const averageFactor = count => {
        const [low, high] = MATCH_PAYOUT_FACTORS[count];
        return (low + high) / 2;
    };
    let expectedPerLine = 0;
    SLOT_WEIGHTS.forEach((weight, index) => {
        const probability = weight / totalWeight;
        const allowed = probability + wildProbability;
        const three = ((allowed ** 3) - (wildProbability ** 3)) * (1 - allowed);
        const four = ((allowed ** 4) - (wildProbability ** 4)) * (1 - allowed);
        const five = (allowed ** 5) - (wildProbability ** 5);
        expectedPerLine += SLOT_MULTIPLIERS[index] * (
            (three * averageFactor(3)) + (four * averageFactor(4)) + (five * averageFactor(5))
        );
    });
    expectedPerLine += (wildProbability ** 5) * WILD.multiplier * averageFactor(5);
    return expectedPerLine * PAYLINES.length;
}

function randomizedPayout(symbol, count, random) {
    const [minimumFactor, maximumFactor] = MATCH_PAYOUT_FACTORS[count];
    const roll = Math.min(0.999999999, Math.max(0, random()));
    return roundedMultiplier(symbol.multiplier * (minimumFactor + ((maximumFactor - minimumFactor) * roll)));
}

function evaluateLine(grid, line, random) {
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
        multiplier: randomizedPayout(payingSymbol, count, random),
    };
}

function evaluateGrid(grid, random = Math.random) {
    if (!Array.isArray(grid) || grid.length !== SLOT_COLUMNS * SLOT_ROWS) {
        throw new Error(`Slots grid must contain exactly ${SLOT_COLUMNS * SLOT_ROWS} symbols.`);
    }
    const wins = [];
    PAYLINES.forEach((line, index) => {
        const win = evaluateLine(grid, line, random);
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
        let result = evaluateGrid(grid, this.random);
        let luckyRespins = false;
        if (result.multiplier === 0 && typeof this.luckProc === 'function' && this.luckProc(guildId, userId, now)) {
            const secondGrid = spinGrid(symbols, this.random);
            const secondResult = evaluateGrid(secondGrid, this.random);
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
    SLOT_MULTIPLIERS,
    SLOT_WEIGHTS,
    SLOT_FALLBACK,
    WILD,
    MATCH_PAYOUT_FACTORS,
    PAYLINES,
    serverSymbols,
    spinGrid,
    slotsExpectedReturn,
    evaluateGrid,
    installSlots,
};
