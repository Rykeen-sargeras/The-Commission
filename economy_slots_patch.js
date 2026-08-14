'use strict';

const economyModule = require('./economy');
const { EconomyService } = economyModule;

const SLOT_MULTIPLIERS = Object.freeze([2, 3, 5, 8, 12, 18, 30, 50, 100, 250]);
const SLOT_WEIGHTS = Object.freeze([250, 200, 150, 120, 90, 70, 50, 35, 25, 10]);
const SLOT_FALLBACK = Object.freeze(['🍒','🍋','🍊','🍇','🔔','💎','🍀','👑','💰','🃏']);
const PAYLINES = Object.freeze([
    [0,1,2], [3,4,5], [6,7,8],
    [0,3,6], [1,4,7], [2,5,8],
    [0,4,8], [2,4,6],
]);

function serverSymbols(guild) {
    const custom = [...guild.emojis.cache.values()]
        .filter(emoji => !emoji.managed && emoji.available !== false)
        .slice(0, 10)
        .map(emoji => ({ key: emoji.id, render: emoji.toString(), name: emoji.name || 'emoji' }));
    const symbols = [...custom];
    for (let index = symbols.length; index < 10; index += 1) {
        symbols.push({ key: `fallback-${index}`, render: SLOT_FALLBACK[index], name: SLOT_FALLBACK[index] });
    }
    return symbols.slice(0, 10).map((symbol, index) => ({
        ...symbol,
        multiplier: SLOT_MULTIPLIERS[index],
        weight: SLOT_WEIGHTS[index],
    }));
}

function weightedSymbol(symbols, random) {
    const total = symbols.reduce((sum, symbol) => sum + symbol.weight, 0);
    let pick = Math.floor(random() * total);
    for (const symbol of symbols) {
        if (pick < symbol.weight) return symbol;
        pick -= symbol.weight;
    }
    return symbols[0];
}

function spinGrid(symbols, random) {
    return Array.from({ length: 9 }, () => weightedSymbol(symbols, random));
}

function evaluateGrid(grid) {
    const wins = [];
    PAYLINES.forEach((line, index) => {
        const [a,b,c] = line.map(position => grid[position]);
        if (a.key === b.key && b.key === c.key) {
            wins.push({ line: index + 1, symbol: a, multiplier: a.multiplier });
        }
    });
    return {
        wins,
        multiplier: wins.reduce((sum, win) => sum + win.multiplier, 0),
    };
}

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

module.exports = {
    SLOT_MULTIPLIERS,
    SLOT_WEIGHTS,
    SLOT_FALLBACK,
    PAYLINES,
    serverSymbols,
    evaluateGrid,
};

