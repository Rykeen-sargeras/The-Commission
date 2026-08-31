'use strict';

const DEFAULTS = Object.freeze({
    enabled: true,
    currencyName: 'Blood Money',
    auditChannelId: '',
    archiveChannelId: '1532792745385529455',
    leaderboardChannelId: '',
    heistChannelId: '',
    gamblingChannelId: '',
    excludedChannelIds: '',
    mediaChannelIds: '',
    excludedVoiceChannelIds: '',
    excludedLeaderboardUserIds: '',
    messageChance: 40,
    messageRewardMin: 1,
    messageRewardMax: 3,
    messageCooldownSeconds: 60,
    messageDailyCap: 50,
    messageHourlyLimit: 10,
    mediaRewardMin: 3,
    mediaRewardMax: 8,
    mediaCooldownMinutes: 10,
    mediaDailyCap: 40,
    mediaDailyPosts: 5,
    voiceRewardMin: 2,
    voiceRewardMax: 5,
    voiceIntervalMinutes: 10,
    voiceDailyCap: 100,
    minimumAccountAgeDays: 7,
    dailyBase: 100,
    dailyStreakStep: 100,
    dailyStreakMaximum: 700,
    gamblingEnabled: true,
    gamblingDailyWagerCap: 150000,
    gamblingMaxActionsPerMinute: 0,
    gamblingMaxActionsPerHour: 0,
    gamblingHourlyWagerCap: 25000,
    blackjackMinimumWager: 1,
    blackjackMaximumWager: 100,
    blackjackDailyCap: 500,
    pokerMinimumWager: 1,
    pokerMaximumWager: 250,
    pokerDailyCap: 1000,
    prizeMonths: '',
    minimumTransfer: 10,
    transferLimitPercent: 10,
    minimumMembershipDays: 7,
    resetHour: 0,
    timeZone: 'America/New_York',
    pokerTimeoutBehavior: 'keep',
    heistEntryFee: 0,
    heistFreeSuccessReward: 100,
    heistEntryMinutes: 58,
    heistCooldownMinutes: 2,
    heistMinimumPlayers: 2,
    heistBaseSuccessChance: 45,
    heistChancePerExtraPlayer: 5,
    heistMaximumSuccessChance: 80,
    heistPayoutMultiplier: 2,
});

const RANKS = [
    [100000, 'Blood Baron'],
    [50000, 'Underboss'],
    [15000, 'Capo'],
    [5000, 'Made Member'],
    [2000, 'Enforcer'],
    [500, 'Runner'],
    [0, 'Street Rat'],
];

const DICE_WEIGHT_TOTAL = 10000;
const GAME_HOURLY_LIMIT = 6;
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

const HOUSE_GAME_RTP = 0.85;
const HIGHER_LOWER_MULTIPLIERS = Object.freeze([1.5, 2, 3, 5, 8, 12, 18, 25]);
const DRAGON_TOWER_COLUMNS = 4;
const DRAGON_TOWER_ROWS = 8;
const DRAGON_TOWER_EGGS_PER_ROW = Object.freeze([3, 3, 3, 3, 3, 1, 1, 1]);
const DRAGON_TOWER_MULTIPLIERS = Object.freeze(DRAGON_TOWER_EGGS_PER_ROW.map((_, index) => {
    const survival = DRAGON_TOWER_EGGS_PER_ROW.slice(0, index + 1)
        .reduce((chance, eggs) => chance * (eggs / DRAGON_TOWER_COLUMNS), 1);
    return HOUSE_GAME_RTP / survival;
}));

function higherLowerSuccessProbability(step) {
    const index = boundedInt(step, 0, 0, HIGHER_LOWER_MULTIPLIERS.length - 1);
    return index === 0
        ? HOUSE_GAME_RTP / HIGHER_LOWER_MULTIPLIERS[0]
        : HIGHER_LOWER_MULTIPLIERS[index - 1] / HIGHER_LOWER_MULTIPLIERS[index];
}

function randomizedPayout(value, random = Math.random) {
    const exact = Math.max(0, Number(value) || 0);
    const whole = Math.floor(exact);
    const fraction = exact - whole;
    return fraction > 0 && random() < fraction ? whole + 1 : whole;
}

function diceExpectedReturn(table = DICE_PAYOUT_TABLE) {
    const totalWeight = table.reduce((sum, outcome) => sum + Number(outcome.weight || 0), 0);
    return table.reduce((total, outcome) => total + (outcome.multiplier * outcome.weight), 0) / totalWeight;
}

function diceHouseEdge(table = DICE_PAYOUT_TABLE) {
    return 1 - diceExpectedReturn(table);
}

function diceOutcome(randomValue, table = DICE_PAYOUT_TABLE) {
    const totalWeight = table.reduce((sum, outcome) => sum + Number(outcome.weight || 0), 0);
    if (totalWeight <= 0) throw new Error('Dice payout table has no eligible outcomes.');
    const roll = Math.min(totalWeight - 1, Math.max(0, Math.floor(Number(randomValue) * totalWeight)));
    let threshold = 0;
    for (const outcome of table) {
        threshold += outcome.weight;
        if (roll < threshold) return { ...outcome, probabilityPercent: (outcome.weight / totalWeight) * 100, roll };
    }
    throw new Error('Dice payout table weights are invalid.');
}

function eligibleDiceTable(wager, table = DICE_PAYOUT_TABLE) {
    if (Number(wager) <= HIGH_PAYOUT_WAGER_LIMIT) return table;
    return table.filter(outcome => ![50, 100].includes(Number(outcome.multiplier)));
}

function gameCategory(related) {
    const value = String(related || '');
    for (const category of ['dice', 'slots', 'blackjack', 'poker', 'higher-lower', 'dragon-tower', 'duel']) {
        if (value.startsWith(`${category}:`)) return category;
    }
    return '';
}

function boundedInt(value, fallback, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(minimum, Math.min(maximum, parsed));
}

function csvSet(value) {
    return new Set(String(value || '').split(/[\s,]+/).map(item => item.trim()).filter(Boolean));
}

function randomInt(minimum, maximum, random = Math.random) {
    return minimum + Math.floor(random() * (maximum - minimum + 1));
}

function normalizeMessage(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/<@!?\d+>|<@&\d+>|<#\d+>/g, ' ')
        .replace(/https?:\/\/\S+/g, ' link ')
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function bigrams(value) {
    const normalized = normalizeMessage(value);
    const result = new Set();
    for (let index = 0; index < normalized.length - 1; index += 1) result.add(normalized.slice(index, index + 2));
    return result;
}

function similarity(left, right) {
    if (!left || !right) return 0;
    if (left === right) return 1;
    const a = bigrams(left);
    const b = bigrams(right);
    if (!a.size || !b.size) return 0;
    let overlap = 0;
    for (const item of a) if (b.has(item)) overlap += 1;
    return (2 * overlap) / (a.size + b.size);
}

function localDateParts(now, config) {
    const shifted = new Date(now - (config.resetHour * 60 * 60 * 1000));
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: config.timeZone,
            year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(shifted);
        const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
        return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
    } catch {
        return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
    }
}

function periodKeys(now, config) {
    const parts = localDateParts(now, config);
    const day = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    const weekday = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() - weekday + 1);
    const week = date.toISOString().slice(0, 10);
    return { day, week, month: day.slice(0, 7) };
}

function dayKey(now, config) { return periodKeys(now, config).day; }

function repMonthKey(now, timeZone = 'America/New_York') {
    let year;
    let month;
    let day;
    let hour;
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone,
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(new Date(now));
        const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
        year = Number(values.year);
        month = Number(values.month);
        day = Number(values.day);
        hour = Number(values.hour) % 24;
    } catch {
        const date = new Date(now);
        year = date.getUTCFullYear();
        month = date.getUTCMonth() + 1;
        day = date.getUTCDate();
        hour = date.getUTCHours();
    }
    if (day === 1 && hour < 8) {
        const previous = new Date(Date.UTC(year, month - 2, 1));
        return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}`;
    }
    return `${year}-${String(month).padStart(2, '0')}`;
}

function rankFor(balance) {
    return RANKS.find(([minimum]) => balance >= minimum)?.[1] || 'Street Rat';
}

function blackjackHand(cards = []) {
    let total = 0;
    let aces = 0;
    for (const card of cards) {
        const rank = String(card).match(/^(10|[2-9JQKA])/)?.[1] || '0';
        if (rank === 'A') {
            total += 11;
            aces += 1;
        } else if (['J', 'Q', 'K'].includes(rank)) total += 10;
        else total += Number(rank);
    }
    while (total > 21 && aces > 0) {
        total -= 10;
        aces -= 1;
    }
    return { total, soft: aces > 0, blackjack: cards.length === 2 && total === 21, bust: total > 21 };
}

function blackjackCardValue(card) {
    const rank = String(card).match(/^(10|[2-9JQKA])/)?.[1] || '0';
    if (rank === 'A') return 11;
    if (['10', 'J', 'Q', 'K'].includes(rank)) return 10;
    return Number(rank);
}

function blackjackCanSplit(cards = []) {
    return cards.length === 2 && blackjackCardValue(cards[0]) === blackjackCardValue(cards[1]);
}

function blackjackPayout(wager, natural = false) {
    const amount = boundedInt(wager, 0, 0);
    const grossProfit = natural ? amount * 1.5 : amount;
    const profitAfterHouseEdge = Math.floor(grossProfit * 0.95);
    return amount + profitAfterHouseEdge;
}

module.exports = {
    DEFAULTS,
    GAME_HOURLY_LIMIT,
    HIGH_PAYOUT_WAGER_LIMIT,
    DICE_WEIGHT_TOTAL,
    DICE_PAYOUT_TABLE,
    HOUSE_GAME_RTP,
    HIGHER_LOWER_MULTIPLIERS,
    DRAGON_TOWER_COLUMNS,
    DRAGON_TOWER_ROWS,
    DRAGON_TOWER_EGGS_PER_ROW,
    DRAGON_TOWER_MULTIPLIERS,
    higherLowerSuccessProbability,
    randomizedPayout,
    diceExpectedReturn,
    diceHouseEdge,
    diceOutcome,
    eligibleDiceTable,
    gameCategory,
    boundedInt,
    csvSet,
    randomInt,
    normalizeMessage,
    similarity,
    localDateParts,
    periodKeys,
    dayKey,
    repMonthKey,
    rankFor,
    blackjackHand,
    blackjackCardValue,
    blackjackCanSplit,
    blackjackPayout,
};

