'use strict';

const crypto = require('crypto');
const economy = require('./economy');

const { EconomyService } = economy;
const GAME_HOURLY_LIMIT = 6;
const DICE_WEIGHT_TOTAL = 10000;
const HIGH_PAYOUT_WAGER_LIMIT = 5000;

const DICE_PAYOUT_TABLE = Object.freeze([
    Object.freeze({ name: 'House wins', multiplier: 0, weight: 4400 }),
    Object.freeze({ name: 'Push', multiplier: 1, weight: 3100 }),
    Object.freeze({ name: 'Double', multiplier: 2, weight: 2000 }),
    Object.freeze({ name: 'Triple', multiplier: 3, weight: 380 }),
    Object.freeze({ name: 'Hot roll', multiplier: 5, weight: 80 }),
    Object.freeze({ name: 'Big win', multiplier: 10, weight: 30 }),
    Object.freeze({ name: 'High roller', multiplier: 25, weight: 8 }),
    Object.freeze({ name: 'Jackpot', multiplier: 100, weight: 2 }),
]);

function boundedInt(value, fallback, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(minimum, Math.min(maximum, parsed));
}

function tableWeight(table) {
    return table.reduce((sum, outcome) => sum + Number(outcome.weight || 0), 0);
}

function diceExpectedReturn(table = DICE_PAYOUT_TABLE) {
    const totalWeight = tableWeight(table);
    return table.reduce((total, outcome) => total + (outcome.multiplier * outcome.weight), 0) / totalWeight;
}

function diceHouseEdge(table = DICE_PAYOUT_TABLE) {
    return 1 - diceExpectedReturn(table);
}

function eligibleDiceTable(wager, table = DICE_PAYOUT_TABLE) {
    if (Number(wager) <= HIGH_PAYOUT_WAGER_LIMIT) return table;
    return table.filter(outcome => ![50, 100].includes(Number(outcome.multiplier)));
}

function diceOutcome(randomValue, table = DICE_PAYOUT_TABLE) {
    const totalWeight = tableWeight(table);
    if (totalWeight <= 0) throw new Error('Dice payout table has no eligible outcomes.');
    const roll = Math.min(totalWeight - 1, Math.max(0, Math.floor(Number(randomValue) * totalWeight)));
    let threshold = 0;
    for (const outcome of table) {
        threshold += outcome.weight;
        if (roll < threshold) return { ...outcome, probabilityPercent: (outcome.weight / totalWeight) * 100, roll };
    }
    throw new Error('Dice payout table weights are invalid.');
}

function gameCategory(related) {
    const value = String(related || '');
    if (value.startsWith('dice:')) return 'dice';
    if (value.startsWith('slots:')) return 'slots';
    if (value.startsWith('blackjack:')) return 'blackjack';
    if (value.startsWith('poker:')) return 'poker';
    if (value.startsWith('higher-lower:')) return 'higher-lower';
    if (value.startsWith('dragon-tower:')) return 'dragon-tower';
    if (value.startsWith('duel:')) return 'duel';
    return '';
}

const originalReserveWager = EconomyService.prototype.reserveWager;
EconomyService.prototype.reserveWager = function reserveWagerWithCategoryLimit(guildId, userId, wager, interactionId, related, now = Date.now()) {
    const category = gameCategory(related);
    if (category) {
        const count = this.db.prepare(`SELECT COUNT(*) AS total FROM economy_transactions
            WHERE guild_id=? AND user_id=? AND type='wager' AND related LIKE ? AND created_at>=?`)
            .get(guildId, userId, `${category}:%`, now - 60 * 60 * 1000).total;
        if (count >= GAME_HOURLY_LIMIT) {
            throw new Error(`${category.replaceAll('-', ' ')} hourly limit reached: maximum ${GAME_HOURLY_LIMIT} game(s) per hour.`);
        }
    }

    const previousHourlyLimit = this.config.gamblingMaxActionsPerHour;
    this.config.gamblingMaxActionsPerHour = 0;
    try {
        return originalReserveWager.call(this, guildId, userId, wager, interactionId, related, now);
    } finally {
        this.config.gamblingMaxActionsPerHour = previousHourlyLimit;
    }
};

EconomyService.prototype.createDeck = function createDeck(deckCount = 1) {
    const deck = [];
    const count = boundedInt(deckCount, 1, 1, 8);
    for (let copy = 0; copy < count; copy += 1) {
        for (const suit of ['♠', '♥', '♦', '♣']) {
            for (const rank of ['2','3','4','5','6','7','8','9','10','J','Q','K','A']) deck.push(`${rank}${suit}`);
        }
    }
    for (let index = deck.length - 1; index > 0; index -= 1) {
        const other = Math.floor(this.random() * (index + 1));
        [deck[index], deck[other]] = [deck[other], deck[index]];
    }
    return deck;
};

EconomyService.prototype.startPoker = function startPokerTwoDeck(guildId, userId, wager, interactionId, now = Date.now()) {
    return this.transaction(() => {
        if (this.db.prepare("SELECT 1 FROM poker_games WHERE guild_id=? AND user_id=? AND status='active'").get(guildId, userId)) {
            throw new Error('Finish your active poker game first.');
        }
        const gameId = crypto.randomUUID();
        const reserved = this.reserveGameWager('poker', guildId, userId, wager, interactionId, `poker:${gameId}`, now);
        const deck = this.createDeck(2);
        const cards = deck.splice(0, 5);
        this.db.prepare(`INSERT INTO poker_games
            (game_id,guild_id,user_id,wager,initial_cards,held_cards,deck,status,interaction_id,created_at)
            VALUES(?,?,?,?,?,'[]',?,'active',?,?)`)
            .run(gameId, guildId, userId, reserved.amount, JSON.stringify(cards), JSON.stringify(deck), interactionId, now);
        return { gameId, cards, held: [], wager: reserved.amount, balance: reserved.balance, dailyUsed: reserved.dailyUsed, dailyLimit: reserved.dailyLimit };
    });
};

EconomyService.prototype.evaluatePoker = function evaluatePokerTwoDeck(cards) {
    const values = cards.map(card => card.slice(0, -1));
    const suits = cards.map(card => card.slice(-1));
    const numeric = values.map(value => ({ J:11,Q:12,K:13,A:14 }[value] || Number(value))).sort((a,b) => a-b);
    const counts = [...new Map(values.map(value => [value, values.filter(item => item === value).length])).values()].sort((a,b) => b-a);
    const flush = new Set(suits).size === 1;
    const unique = [...new Set(numeric)];
    const straight = unique.length === 5 && (unique[4] - unique[0] === 4 || unique.join(',') === '2,3,4,5,14');
    const royal = flush && numeric.join(',') === '10,11,12,13,14';
    if (royal) return { name: 'Royal Flush', multiplier: 150 };
    if (flush && straight) return { name: 'Straight Flush', multiplier: 75 };
    if (counts[0] >= 4) return { name: counts[0] === 5 ? 'Five of a Kind' : 'Four of a Kind', multiplier: 25 };
    if (counts[0] === 3 && counts[1] === 2) return { name: 'Full House', multiplier: 10 };
    if (flush) return { name: 'Flush', multiplier: 7 };
    if (straight) return { name: 'Straight', multiplier: 5 };
    if (counts[0] === 3) return { name: 'Three of a Kind', multiplier: 3 };
    if (counts[0] === 2 && counts[1] === 2) return { name: 'Two Pair', multiplier: 2 };
    const pairValue = values.find(value => values.filter(item => item === value).length === 2);
    if (['10','J','Q','K','A'].includes(pairValue)) return { name: 'Tens or Better', multiplier: 1.5 };
    return { name: 'No winning hand', multiplier: 0 };
};

EconomyService.prototype.startBlackjack = function startBlackjackThreeDeck(guildId, userId, wager, interactionId, now = Date.now()) {
    const amount = boundedInt(wager, 0, 0);
    return this.transaction(() => {
        if (this.db.prepare("SELECT 1 FROM blackjack_games WHERE guild_id=? AND user_id=? AND status='active'").get(guildId, userId)) {
            throw new Error('Finish your active blackjack game first.');
        }
        const gameId = crypto.randomUUID();
        const reserved = this.reserveGameWager('blackjack', guildId, userId, amount, interactionId, `blackjack:${gameId}`, now);
        const deck = this.createDeck(3);
        const playerCards = [deck.shift(), deck.shift()];
        const dealerCards = [deck.shift(), deck.shift()];
        this.db.prepare(`INSERT INTO blackjack_games
            (game_id,guild_id,user_id,wager,base_wager,player_cards,dealer_cards,deck,hand_wagers,status,interaction_id,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,'active',?,?,?)`)
            .run(gameId, guildId, userId, reserved.amount, reserved.amount, JSON.stringify(playerCards), JSON.stringify(dealerCards), JSON.stringify(deck), JSON.stringify([reserved.amount]), interactionId, now, now);
        const game = this.blackjackGame(gameId);
        if (game.playerHand.blackjack && game.dealerHand.blackjack) return this.finishBlackjack(game, 'push', now);
        if (game.playerHand.blackjack) return this.finishBlackjack(game, 'blackjack', now, true);
        if (game.dealerHand.blackjack) return this.finishBlackjack(game, 'dealer-blackjack', now);
        return { ...game, balance: reserved.balance };
    });
};

EconomyService.prototype.dice = function diceRebalanced(guildId, userId, wager, interactionId, now = Date.now()) {
    return this.transaction(() => {
        if (this.hasInteraction(guildId, interactionId)) throw new Error('This wager was already processed.');
        const amount = boundedInt(wager, 0, 1);
        const reserved = this.reserveWager(guildId, userId, amount, interactionId, `dice:${interactionId}`, now);
        const table = eligibleDiceTable(reserved.amount);
        const outcome = diceOutcome(this.random(), table);
        const multiplier = outcome.multiplier;
        const payout = Math.floor(reserved.amount * multiplier);
        let balance = reserved.balance;
        if (payout) balance = this.applyDelta(guildId, userId, payout, 'dice-payout', `x${multiplier}`, null, now);
        const won = payout > reserved.amount;
        this.db.prepare(`UPDATE economy_members SET lifetime_won=lifetime_won+?, lifetime_lost=lifetime_lost+?,
            gambling_wins=gambling_wins+?, gambling_losses=gambling_losses+? WHERE guild_id=? AND user_id=?`)
            .run(payout, payout === 0 ? reserved.amount : 0, won ? 1 : 0, payout === 0 ? 1 : 0, guildId, userId);
        return {
            wager: reserved.amount,
            outcome: outcome.name,
            odds: outcome.probabilityPercent,
            multiplier,
            payout,
            balance,
            maximumWager: null,
            highPayoutEligible: reserved.amount <= HIGH_PAYOUT_WAGER_LIMIT,
        };
    });
};

economy.DICE_PAYOUT_TABLE = DICE_PAYOUT_TABLE;
economy.DICE_WEIGHT_TOTAL = DICE_WEIGHT_TOTAL;
economy.diceExpectedReturn = diceExpectedReturn;
economy.diceHouseEdge = diceHouseEdge;
economy.diceOutcome = diceOutcome;
economy.eligibleDiceTable = eligibleDiceTable;
economy.HIGH_PAYOUT_WAGER_LIMIT = HIGH_PAYOUT_WAGER_LIMIT;

module.exports = {
    GAME_HOURLY_LIMIT,
    DICE_PAYOUT_TABLE,
    HIGH_PAYOUT_WAGER_LIMIT,
    eligibleDiceTable,
    diceExpectedReturn,
    diceHouseEdge,
    diceOutcome,
};
