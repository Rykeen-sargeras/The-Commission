const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

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

class EconomyService {
    constructor(options = {}) {
        const raw = { ...DEFAULTS, ...(options.config || {}) };
        const legacyDailySchedule = Number(raw.dailyBase) === 25
            && Number(raw.dailyStreakStep) === 5
            && Number(raw.dailyStreakMaximum) === 75;
        this.config = {
            ...raw,
            enabled: raw.enabled !== false,
            gamblingEnabled: raw.gamblingEnabled !== false,
            gamblingDailyWagerCap: 150000,
            gamblingMaxActionsPerMinute: boundedInt(raw.gamblingMaxActionsPerMinute, 0, 0, 10000),
            gamblingMaxActionsPerHour: boundedInt(raw.gamblingMaxActionsPerHour, 0, 0, 100000),
            gamblingHourlyWagerCap: 25000,
            blackjackMinimumWager: boundedInt(raw.blackjackMinimumWager, 1, 1),
            blackjackMaximumWager: boundedInt(raw.blackjackMaximumWager, 100, 1),
            blackjackDailyCap: boundedInt(raw.blackjackDailyCap, 500, 1),
            pokerMinimumWager: boundedInt(raw.pokerMinimumWager, 1, 1),
            pokerMaximumWager: boundedInt(raw.pokerMaximumWager, 250, 1),
            pokerDailyCap: boundedInt(raw.pokerDailyCap, 1000, 1),
            messageChance: boundedInt(raw.messageChance, 40, 0, 100),
            messageRewardMin: boundedInt(raw.messageRewardMin, 1, 0),
            messageRewardMax: boundedInt(raw.messageRewardMax, 3, 0),
            messageCooldownSeconds: boundedInt(raw.messageCooldownSeconds, 60, 1),
            messageDailyCap: boundedInt(raw.messageDailyCap, 50, 0),
            messageHourlyLimit: boundedInt(raw.messageHourlyLimit, 10, 0),
            mediaRewardMin: boundedInt(raw.mediaRewardMin, 3, 0),
            mediaRewardMax: boundedInt(raw.mediaRewardMax, 8, 0),
            mediaCooldownMinutes: boundedInt(raw.mediaCooldownMinutes, 10, 1),
            mediaDailyCap: boundedInt(raw.mediaDailyCap, 40, 0),
            mediaDailyPosts: boundedInt(raw.mediaDailyPosts, 5, 0),
            voiceRewardMin: boundedInt(raw.voiceRewardMin, 2, 0),
            voiceRewardMax: boundedInt(raw.voiceRewardMax, 5, 0),
            voiceIntervalMinutes: boundedInt(raw.voiceIntervalMinutes, 10, 1),
            voiceDailyCap: boundedInt(raw.voiceDailyCap, 100, 0),
            minimumAccountAgeDays: boundedInt(raw.minimumAccountAgeDays, 7, 0),
            dailyBase: legacyDailySchedule ? 100 : boundedInt(raw.dailyBase, 100, 0),
            dailyStreakStep: legacyDailySchedule ? 100 : boundedInt(raw.dailyStreakStep, 100, 0),
            dailyStreakMaximum: legacyDailySchedule ? 700 : boundedInt(raw.dailyStreakMaximum, 700, 0),
            minimumTransfer: boundedInt(raw.minimumTransfer, 10, 1),
            transferLimitPercent: boundedInt(raw.transferLimitPercent, 10, 0, 100),
            minimumMembershipDays: boundedInt(raw.minimumMembershipDays, 7, 0),
            resetHour: boundedInt(raw.resetHour, 0, 0, 23),
            heistEntryFee: boundedInt(raw.heistEntryFee, 0, 0),
            heistFreeSuccessReward: boundedInt(raw.heistFreeSuccessReward, 100, 0),
            heistEntryMinutes: boundedInt(raw.heistEntryMinutes, 58, 1, 58),
            heistCooldownMinutes: boundedInt(raw.heistCooldownMinutes, 2, 2, 2),
            heistMinimumPlayers: boundedInt(raw.heistMinimumPlayers, 2, 1, 100),
            heistBaseSuccessChance: boundedInt(raw.heistBaseSuccessChance, 45, 0, 100),
            heistChancePerExtraPlayer: boundedInt(raw.heistChancePerExtraPlayer, 5, 0, 100),
            heistMaximumSuccessChance: boundedInt(raw.heistMaximumSuccessChance, 80, 0, 100),
            heistPayoutMultiplier: boundedInt(raw.heistPayoutMultiplier, 2, 1, 100),
        };
        this.config.blackjackMaximumWager = Math.max(this.config.blackjackMinimumWager, this.config.blackjackMaximumWager);
        this.config.blackjackDailyCap = Math.max(this.config.blackjackMinimumWager, this.config.blackjackDailyCap);
        this.config.pokerMaximumWager = Math.max(this.config.pokerMinimumWager, this.config.pokerMaximumWager);
        this.config.pokerDailyCap = Math.max(this.config.pokerMinimumWager, this.config.pokerDailyCap);
        this.excludedChannels = csvSet(raw.excludedChannelIds);
        this.mediaChannels = csvSet(raw.mediaChannelIds);
        this.excludedVoiceChannels = csvSet(raw.excludedVoiceChannelIds);
        this.excludedLeaderboardUsers = csvSet(raw.excludedLeaderboardUserIds);
        const dataDir = options.dataDir || process.env.DATA_DIR || process.cwd();
        fs.mkdirSync(dataDir, { recursive: true });
        this.dbPath = options.dbPath || path.join(dataDir, 'blood-money.sqlite');
        this.db = new DatabaseSync(this.dbPath);
        this.random = options.random || (() => crypto.randomInt(0, 0x100000000) / 0x100000000);
        this.initialize();
    }

    initialize() {
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS economy_members (
                guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
                balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
                lifetime_earned INTEGER NOT NULL DEFAULT 0,
                lifetime_spent INTEGER NOT NULL DEFAULT 0,
                lifetime_wagered INTEGER NOT NULL DEFAULT 0,
                lifetime_won INTEGER NOT NULL DEFAULT 0,
                lifetime_lost INTEGER NOT NULL DEFAULT 0,
                gambling_wins INTEGER NOT NULL DEFAULT 0,
                gambling_losses INTEGER NOT NULL DEFAULT 0,
                daily_key TEXT NOT NULL DEFAULT '',
                daily_wagered INTEGER NOT NULL DEFAULT 0,
                daily_gambling_limit INTEGER NOT NULL DEFAULT 0,
                daily_blackjack_wagered INTEGER NOT NULL DEFAULT 0,
                daily_poker_wagered INTEGER NOT NULL DEFAULT 0,
                daily_text_earned INTEGER NOT NULL DEFAULT 0,
                daily_media_earned INTEGER NOT NULL DEFAULT 0,
                daily_media_posts INTEGER NOT NULL DEFAULT 0,
                daily_voice_earned INTEGER NOT NULL DEFAULT 0,
                daily_transfers_sent INTEGER NOT NULL DEFAULT 0,
                last_message_reward INTEGER NOT NULL DEFAULT 0,
                last_message_at INTEGER NOT NULL DEFAULT 0,
                last_media_reward INTEGER NOT NULL DEFAULT 0,
                last_daily_claim INTEGER NOT NULL DEFAULT 0,
                daily_streak INTEGER NOT NULL DEFAULT 0,
                voice_minutes INTEGER NOT NULL DEFAULT 0,
                frozen INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (guild_id, user_id)
            );
            CREATE TABLE IF NOT EXISTS economy_transactions (
                id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
                amount INTEGER NOT NULL, balance_before INTEGER NOT NULL, balance_after INTEGER NOT NULL,
                type TEXT NOT NULL, related TEXT NOT NULL DEFAULT '', interaction_id TEXT,
                period_day TEXT NOT NULL DEFAULT '', period_week TEXT NOT NULL DEFAULT '', period_month TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                UNIQUE(guild_id, interaction_id)
            );
            CREATE INDEX IF NOT EXISTS economy_transactions_user ON economy_transactions(guild_id, user_id, created_at DESC);
            CREATE TABLE IF NOT EXISTS economy_messages (
                message_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
                normalized TEXT NOT NULL, reward INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS economy_messages_recent ON economy_messages(guild_id, user_id, created_at DESC);
            CREATE TABLE IF NOT EXISTS economy_media (
                fingerprint TEXT NOT NULL, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
                message_id TEXT NOT NULL, reward INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
                PRIMARY KEY (guild_id, fingerprint)
            );
            CREATE TABLE IF NOT EXISTS poker_games (
                game_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
                wager INTEGER NOT NULL, initial_cards TEXT NOT NULL, held_cards TEXT NOT NULL DEFAULT '[]',
                final_cards TEXT, deck TEXT NOT NULL, status TEXT NOT NULL, payout INTEGER NOT NULL DEFAULT 0,
                interaction_id TEXT NOT NULL, channel_id TEXT NOT NULL DEFAULT '', message_id TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL, completed_at INTEGER
            );
            CREATE UNIQUE INDEX IF NOT EXISTS poker_one_active ON poker_games(guild_id, user_id) WHERE status='active';
            CREATE TABLE IF NOT EXISTS blackjack_games (
                game_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
                wager INTEGER NOT NULL, player_cards TEXT NOT NULL, dealer_cards TEXT NOT NULL, deck TEXT NOT NULL,
                base_wager INTEGER NOT NULL DEFAULT 0, split_cards TEXT NOT NULL DEFAULT '[]',
                hand_wagers TEXT NOT NULL DEFAULT '[]', hand_outcomes TEXT NOT NULL DEFAULT '[]', active_hand INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT '', payout INTEGER NOT NULL DEFAULT 0,
                interaction_id TEXT NOT NULL, channel_id TEXT NOT NULL DEFAULT '', message_id TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
            );
            CREATE UNIQUE INDEX IF NOT EXISTS blackjack_one_active ON blackjack_games(guild_id, user_id) WHERE status='active';
            CREATE TABLE IF NOT EXISTS higher_lower_games (
                game_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
                wager INTEGER NOT NULL, current_card TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 0,
                history TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, payout INTEGER NOT NULL DEFAULT 0,
                channel_id TEXT NOT NULL DEFAULT '', message_id TEXT NOT NULL DEFAULT '',
                interaction_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
            );
            CREATE UNIQUE INDEX IF NOT EXISTS higher_lower_one_active ON higher_lower_games(guild_id, user_id) WHERE status='active';
            CREATE TABLE IF NOT EXISTS dragon_tower_games (
                game_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
                wager INTEGER NOT NULL, row_number INTEGER NOT NULL DEFAULT 0,
                trap_positions TEXT NOT NULL, history TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL, payout INTEGER NOT NULL DEFAULT 0,
                channel_id TEXT NOT NULL DEFAULT '', message_id TEXT NOT NULL DEFAULT '',
                interaction_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
            );
            CREATE UNIQUE INDEX IF NOT EXISTS dragon_tower_one_active ON dragon_tower_games(guild_id, user_id) WHERE status='active';
            CREATE TABLE IF NOT EXISTS duels (
                duel_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL,
                challenger_id TEXT NOT NULL, challenged_id TEXT NOT NULL, wager INTEGER NOT NULL,
                status TEXT NOT NULL, winner_id TEXT NOT NULL DEFAULT '',
                interaction_id TEXT NOT NULL, channel_id TEXT NOT NULL DEFAULT '', message_id TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, completed_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS duels_pending_users ON duels(guild_id, challenged_id, status, created_at DESC);
            CREATE TABLE IF NOT EXISTS economy_settings (
                guild_id TEXT NOT NULL, setting_key TEXT NOT NULL, setting_value TEXT NOT NULL,
                PRIMARY KEY (guild_id, setting_key)
            );
            CREATE TABLE IF NOT EXISTS rep_members (
                guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
                points INTEGER NOT NULL DEFAULT 0 CHECK(points >= 0),
                last_message_at INTEGER NOT NULL DEFAULT 0,
                qualified_voice_minutes INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                PRIMARY KEY (guild_id, user_id)
            );
            CREATE INDEX IF NOT EXISTS rep_members_leaderboard ON rep_members(guild_id, points DESC, updated_at ASC);
            CREATE TABLE IF NOT EXISTS heist_rounds (
                round_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, status TEXT NOT NULL,
                entry_fee INTEGER NOT NULL, signup_ends_at INTEGER NOT NULL,
                success_chance INTEGER NOT NULL DEFAULT 0, success INTEGER,
                pot INTEGER NOT NULL DEFAULT 0, payout_total INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL, completed_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS heist_rounds_guild ON heist_rounds(guild_id, created_at DESC);
            CREATE TABLE IF NOT EXISTS heist_entries (
                round_id TEXT NOT NULL, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
                entry_fee INTEGER NOT NULL, payout INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL,
                PRIMARY KEY (round_id, user_id),
                FOREIGN KEY (round_id) REFERENCES heist_rounds(round_id)
            );
        `);
        const transactionColumns = new Set(this.db.prepare('PRAGMA table_info(economy_transactions)').all().map(column => column.name));
        for (const column of ['period_day', 'period_week', 'period_month']) {
            if (!transactionColumns.has(column)) this.db.exec(`ALTER TABLE economy_transactions ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
        }
        const pokerColumns = new Set(this.db.prepare('PRAGMA table_info(poker_games)').all().map(column => column.name));
        for (const column of ['channel_id', 'message_id']) {
            if (!pokerColumns.has(column)) this.db.exec(`ALTER TABLE poker_games ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
        }
        const blackjackColumns = new Set(this.db.prepare('PRAGMA table_info(blackjack_games)').all().map(column => column.name));
        for (const [column, definition] of [
            ['updated_at', 'INTEGER NOT NULL DEFAULT 0'],
            ['base_wager', 'INTEGER NOT NULL DEFAULT 0'],
            ['split_cards', "TEXT NOT NULL DEFAULT '[]'"],
            ['hand_wagers', "TEXT NOT NULL DEFAULT '[]'"],
            ['hand_outcomes', "TEXT NOT NULL DEFAULT '[]'"],
            ['active_hand', 'INTEGER NOT NULL DEFAULT 0'],
        ]) {
            if (!blackjackColumns.has(column)) this.db.exec(`ALTER TABLE blackjack_games ADD COLUMN ${column} ${definition}`);
        }
        this.db.exec('UPDATE blackjack_games SET updated_at=created_at WHERE updated_at=0');
        this.db.exec('UPDATE blackjack_games SET base_wager=wager WHERE base_wager=0');
        const memberColumns = new Set(this.db.prepare('PRAGMA table_info(economy_members)').all().map(column => column.name));
        for (const column of ['daily_blackjack_wagered', 'daily_poker_wagered']) {
            if (!memberColumns.has(column)) this.db.exec(`ALTER TABLE economy_members ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
        }
    }

    close() { this.db.close(); }

    transaction(callback) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = callback();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    ensureMember(guildId, userId, now = Date.now()) {
        this.db.prepare(`INSERT OR IGNORE INTO economy_members
            (guild_id,user_id,daily_key,created_at,updated_at) VALUES(?,?,?,?,?)`)
            .run(guildId, userId, dayKey(now, this.config), now, now);
        this.resetDailyIfNeeded(guildId, userId, now);
        return this.member(guildId, userId);
    }

    resetDailyIfNeeded(guildId, userId, now = Date.now()) {
        const key = dayKey(now, this.config);
        this.db.prepare(`UPDATE economy_members SET daily_key=?, daily_wagered=0, daily_gambling_limit=0,
            daily_blackjack_wagered=0,daily_poker_wagered=0,
            daily_text_earned=0, daily_media_earned=0, daily_media_posts=0, daily_voice_earned=0,
            daily_transfers_sent=0, updated_at=? WHERE guild_id=? AND user_id=? AND daily_key<>?`)
            .run(key, now, guildId, userId, key);
    }

    member(guildId, userId) {
        return this.db.prepare('SELECT * FROM economy_members WHERE guild_id=? AND user_id=?').get(guildId, userId);
    }

    publicMember(guildId, userId) {
        const row = this.ensureMember(guildId, userId);
        return { ...row, rank: rankFor(row.balance) };
    }

    ensureRepMember(guildId, userId, now = Date.now()) {
        this.db.prepare(`INSERT OR IGNORE INTO rep_members(guild_id,user_id,created_at,updated_at)
            VALUES(?,?,?,?)`).run(guildId, userId, now, now);
        return this.db.prepare('SELECT * FROM rep_members WHERE guild_id=? AND user_id=?').get(guildId, userId);
    }

    repMember(guildId, userId, now = Date.now()) {
        const row = this.ensureRepMember(guildId, userId, now);
        const position = row.points > 0
            ? this.db.prepare(`SELECT COUNT(*)+1 AS position FROM rep_members
                WHERE guild_id=? AND points>0 AND (points>? OR (points=? AND user_id<?))`).get(guildId, row.points, row.points, userId).position
            : null;
        return { ...row, position };
    }

    rewardRepMessage(guildId, userId, now = Date.now()) {
        this.rolloverRepMonth(guildId, now);
        return this.transaction(() => {
            const row = this.ensureRepMember(guildId, userId, now);
            if (row.last_message_at && now - row.last_message_at < 120000) return null;
            this.db.prepare('UPDATE rep_members SET points=points+1,last_message_at=?,updated_at=? WHERE guild_id=? AND user_id=?')
                .run(now, now, guildId, userId);
            return { reward: 1, points: row.points + 1 };
        });
    }

    rewardRepVoice(guildId, userId, minutes = 1, now = Date.now()) {
        this.rolloverRepMonth(guildId, now);
        return this.transaction(() => {
            const row = this.ensureRepMember(guildId, userId, now);
            const accumulated = row.qualified_voice_minutes + Math.max(0, boundedInt(minutes, 0, 0));
            const completedBlocks = Math.floor(accumulated / 30);
            const reward = completedBlocks * 10;
            const remaining = accumulated % 30;
            this.db.prepare(`UPDATE rep_members SET points=points+?,qualified_voice_minutes=?,updated_at=?
                WHERE guild_id=? AND user_id=?`).run(reward, remaining, now, guildId, userId);
            return { reward, points: row.points + reward, qualifiedMinutes: remaining };
        });
    }

    repLeaderboard(guildId, limit = 100) {
        return this.db.prepare(`SELECT user_id,points AS score,points,updated_at FROM rep_members
            WHERE guild_id=? AND points>0 ORDER BY points DESC,updated_at ASC,user_id ASC LIMIT ?`)
            .all(guildId, Math.max(1, boundedInt(limit, 100, 1, 10000)))
            .map((row, index) => ({ ...row, position: index + 1 }));
    }

    assertUsable(row) {
        if (!this.config.enabled) throw new Error('The Blood Money economy is disabled.');
        if (row.frozen) throw new Error('This Blood Money account is frozen.');
    }

    applyDelta(guildId, userId, amount, type, related = '', interactionId = null, now = Date.now()) {
        const row = this.ensureMember(guildId, userId, now);
        const after = row.balance + amount;
        if (after < 0) throw new Error(`Not enough ${this.config.currencyName}.`);
        const earned = amount > 0 && !['transfer-in', 'admin-set', 'admin-bulk-add', 'heist-refund', 'duel-refund', 'blackjack-push'].includes(type) ? amount : 0;
        const spent = amount < 0 ? Math.abs(amount) : 0;
        this.db.prepare(`UPDATE economy_members SET balance=?, lifetime_earned=lifetime_earned+?,
            lifetime_spent=lifetime_spent+?, updated_at=? WHERE guild_id=? AND user_id=?`)
            .run(after, earned, spent, now, guildId, userId);
        const periods = periodKeys(now, this.config);
        this.db.prepare(`INSERT INTO economy_transactions
            (id,guild_id,user_id,amount,balance_before,balance_after,type,related,interaction_id,period_day,period_week,period_month,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(crypto.randomUUID(), guildId, userId, amount, row.balance, after, type, related, interactionId, periods.day, periods.week, periods.month, now);
        return after;
    }

    hasInteraction(guildId, interactionId) {
        if (!interactionId) return false;
        return Boolean(this.db.prepare('SELECT 1 FROM economy_transactions WHERE guild_id=? AND interaction_id=?').get(guildId, interactionId));
    }

    claimDaily(guildId, userId, interactionId, now = Date.now()) {
        return this.transaction(() => {
            const row = this.ensureMember(guildId, userId, now);
            this.assertUsable(row);
            if (this.hasInteraction(guildId, interactionId)) return { duplicate: true, balance: row.balance };
            const elapsed = now - row.last_daily_claim;
            if (row.last_daily_claim && elapsed < 24 * 60 * 60 * 1000) {
                return { cooldown: (24 * 60 * 60 * 1000) - elapsed };
            }
            const streak = row.last_daily_claim && elapsed < 48 * 60 * 60 * 1000 ? row.daily_streak + 1 : 1;
            const normalReward = this.config.dailyBase + ((streak - 1) * this.config.dailyStreakStep);
            const reward = streak >= 7 ? this.config.dailyStreakMaximum : Math.min(normalReward, this.config.dailyStreakMaximum);
            const balance = this.applyDelta(guildId, userId, reward, 'daily', `streak:${streak}`, interactionId, now);
            this.db.prepare('UPDATE economy_members SET last_daily_claim=?, daily_streak=? WHERE guild_id=? AND user_id=?')
                .run(now, streak, guildId, userId);
            return { reward, streak, balance };
        });
    }

    rewardMessage({ guildId, userId, messageId, content, channelId, now = Date.now() }) {
        if (!this.config.enabled || this.excludedChannels.has(channelId)) return null;
        const normalized = normalizeMessage(content);
        if (normalized.length < 5 || /^\W*$/.test(content) || /^[!/]\S+/.test(String(content).trim())) return null;
        if (!/[aeiou]/i.test(normalized) && normalized.length > 12) return null;
        return this.transaction(() => {
            const row = this.ensureMember(guildId, userId, now);
            if (row.frozen || now - row.last_message_at < 5000) return null;
            const recent = this.db.prepare(`SELECT normalized FROM economy_messages WHERE guild_id=? AND user_id=?
                ORDER BY created_at DESC LIMIT 10`).all(guildId, userId);
            this.db.prepare('INSERT OR IGNORE INTO economy_messages(message_id,guild_id,user_id,normalized,reward,created_at) VALUES(?,?,?,?,0,?)')
                .run(messageId, guildId, userId, normalized, now);
            this.db.prepare('UPDATE economy_members SET last_message_at=? WHERE guild_id=? AND user_id=?').run(now, guildId, userId);
            if (recent.some(item => similarity(normalized, item.normalized) >= 0.8)) return null;
            if (now - row.last_message_reward < this.config.messageCooldownSeconds * 1000) return null;
            const hourly = this.db.prepare(`SELECT COUNT(*) AS total FROM economy_messages WHERE guild_id=? AND user_id=?
                AND reward>0 AND created_at>=?`).get(guildId, userId, now - 60 * 60 * 1000).total;
            if (hourly >= this.config.messageHourlyLimit || row.daily_text_earned >= this.config.messageDailyCap) return null;
            if ((this.random() * 100) >= this.config.messageChance) return null;
            const reward = Math.min(
                randomInt(this.config.messageRewardMin, Math.max(this.config.messageRewardMin, this.config.messageRewardMax), this.random),
                this.config.messageDailyCap - row.daily_text_earned,
            );
            if (reward <= 0) return null;
            const balance = this.applyDelta(guildId, userId, reward, 'text', messageId, `message:${messageId}`, now);
            this.db.prepare('UPDATE economy_members SET daily_text_earned=daily_text_earned+?, last_message_reward=? WHERE guild_id=? AND user_id=?')
                .run(reward, now, guildId, userId);
            this.db.prepare('UPDATE economy_messages SET reward=? WHERE message_id=?').run(reward, messageId);
            return { reward, balance };
        });
    }

    reverseDeletedMessage(guildId, userId, messageId, now = Date.now()) {
        return this.transaction(() => {
            const reward = this.db.prepare('SELECT reward,created_at FROM economy_messages WHERE message_id=? AND guild_id=? AND user_id=?')
                .get(messageId, guildId, userId);
            if (!reward || reward.reward <= 0 || now - reward.created_at > 5 * 60 * 1000) return null;
            const row = this.ensureMember(guildId, userId, now);
            const amount = Math.min(reward.reward, row.balance);
            if (amount > 0) this.applyDelta(guildId, userId, -amount, 'deleted-message', messageId, `delete:${messageId}`, now);
            this.db.prepare('UPDATE economy_members SET daily_text_earned=MAX(0,daily_text_earned-?) WHERE guild_id=? AND user_id=?')
                .run(reward.reward, guildId, userId);
            this.db.prepare('UPDATE economy_messages SET reward=0 WHERE message_id=?').run(messageId);
            return { removed: amount };
        });
    }

    rewardMedia({ guildId, userId, messageId, channelId, fingerprint, now = Date.now() }) {
        if (!this.config.enabled || !this.mediaChannels.has(channelId)) return null;
        return this.transaction(() => {
            const row = this.ensureMember(guildId, userId, now);
            if (row.frozen || now - row.last_media_reward < this.config.mediaCooldownMinutes * 60000) return null;
            if (row.daily_media_posts >= this.config.mediaDailyPosts || row.daily_media_earned >= this.config.mediaDailyCap) return null;
            if (this.db.prepare('SELECT 1 FROM economy_media WHERE guild_id=? AND fingerprint=?').get(guildId, fingerprint)) return null;
            const reward = Math.min(
                randomInt(this.config.mediaRewardMin, Math.max(this.config.mediaRewardMin, this.config.mediaRewardMax), this.random),
                this.config.mediaDailyCap - row.daily_media_earned,
            );
            if (reward <= 0) return null;
            const balance = this.applyDelta(guildId, userId, reward, 'media', messageId, `media:${messageId}`, now);
            this.db.prepare(`UPDATE economy_members SET daily_media_earned=daily_media_earned+?,
                daily_media_posts=daily_media_posts+1,last_media_reward=? WHERE guild_id=? AND user_id=?`)
                .run(reward, now, guildId, userId);
            this.db.prepare('INSERT INTO economy_media(fingerprint,guild_id,user_id,message_id,reward,created_at) VALUES(?,?,?,?,?,?)')
                .run(fingerprint, guildId, userId, messageId, reward, now);
            return { reward, balance };
        });
    }

    rewardVoice(guildId, userId, minutes, now = Date.now()) {
        if (!this.config.enabled) return null;
        return this.transaction(() => {
            const row = this.ensureMember(guildId, userId, now);
            if (row.frozen || row.daily_voice_earned >= this.config.voiceDailyCap) return null;
            const reward = Math.min(
                randomInt(this.config.voiceRewardMin, Math.max(this.config.voiceRewardMin, this.config.voiceRewardMax), this.random),
                this.config.voiceDailyCap - row.daily_voice_earned,
            );
            if (reward <= 0) return null;
            const balance = this.applyDelta(guildId, userId, reward, 'voice', `${minutes}m`, null, now);
            this.db.prepare(`UPDATE economy_members SET daily_voice_earned=daily_voice_earned+?,
                voice_minutes=voice_minutes+? WHERE guild_id=? AND user_id=?`).run(reward, minutes, guildId, userId);
            return { reward, balance };
        });
    }

    reserveWager(guildId, userId, wager, interactionId, related, now = Date.now()) {
        const amount = boundedInt(wager, 0, 0);
        const category = gameCategory(related);
        if (category) {
            const count = this.db.prepare(`SELECT COUNT(*) AS total FROM economy_transactions
                WHERE guild_id=? AND user_id=? AND type='wager' AND related LIKE ? AND created_at>=?`)
                .get(guildId, userId, `${category}:%`, now - 60 * 60 * 1000).total;
            if (count >= GAME_HOURLY_LIMIT) {
                throw new Error(`${category.replaceAll('-', ' ')} hourly limit reached: maximum ${GAME_HOURLY_LIMIT} game(s) per hour.`);
            }
        }
        const row = this.ensureMember(guildId, userId, now);
        this.assertUsable(row);
        if (!this.config.gamblingEnabled) throw new Error('Gambling is currently disabled.');
        if (amount < 1) throw new Error('Wager must be at least 1.');
        if (amount > row.balance) throw new Error(`You only have ${row.balance} ${this.config.currencyName}.`);
        const dailyRemaining = Math.max(0, this.config.gamblingDailyWagerCap - row.daily_wagered);
        if (amount > dailyRemaining) {
            throw new Error(`Daily gambling allowance remaining: ${dailyRemaining} ${this.config.currencyName} (150,000 maximum wagered per day).`);
        }
        const hourlyWagered = this.db.prepare(`SELECT COALESCE(SUM(-amount),0) AS total FROM economy_transactions
            WHERE guild_id=? AND user_id=? AND type='wager' AND created_at>?`).get(guildId, userId, now - 3600000).total;
        const hourlyRemaining = Math.max(0, this.config.gamblingHourlyWagerCap - hourlyWagered);
        if (amount > hourlyRemaining) {
            throw new Error(`Hourly gambling allowance remaining: ${hourlyRemaining} ${this.config.currencyName} (25,000 maximum wagered per hour).`);
        }
        const balance = this.applyDelta(guildId, userId, -amount, 'wager', related, interactionId, now);
        this.db.prepare('UPDATE economy_members SET lifetime_wagered=lifetime_wagered+?,daily_wagered=daily_wagered+? WHERE guild_id=? AND user_id=?')
            .run(amount, amount, guildId, userId);
        return { amount, balance };
    }

    reserveGameWager(game, guildId, userId, wager, interactionId, related, now = Date.now()) {
        const amount = boundedInt(wager, 0, 0);
        const rules = game === 'blackjack'
            ? { minimum: this.config.blackjackMinimumWager }
            : { minimum: this.config.pokerMinimumWager };
        if (amount < rules.minimum) throw new Error(`${game === 'blackjack' ? 'Blackjack' : 'Video poker'} minimum wager is ${rules.minimum} ${this.config.currencyName}.`);
        return this.reserveWager(guildId, userId, amount, interactionId, related, now);
    }

    dice(guildId, userId, wager, interactionId, now = Date.now()) {
        return this.transaction(() => {
            if (this.hasInteraction(guildId, interactionId)) throw new Error('This wager was already processed.');
            const reserved = this.reserveWager(guildId, userId, wager, interactionId, `dice:${interactionId}`, now);
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
    }

    diceMaximumWager(guildId) {
        return this.config.gamblingHourlyWagerCap;
    }

    startProgressiveWager(guildId, userId, wager, interactionId, related, now = Date.now()) {
        return { ...this.reserveWager(guildId, userId, wager, interactionId, related, now), maximumWager: this.config.gamblingHourlyWagerCap };
    }

    higherLowerReferenceCard() {
        const ranks = ['5', '6', '7', '8', '9', '10'];
        const suits = ['♠', '♥', '♦', '♣'];
        return `${ranks[randomInt(0, ranks.length - 1, this.random)]}${suits[randomInt(0, suits.length - 1, this.random)]}`;
    }

    higherLowerReveal(referenceCard, direction, success) {
        const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
        const suits = ['♠', '♥', '♦', '♣'];
        const referenceRank = referenceCard.slice(0, -1);
        const referenceValue = ranks.indexOf(referenceRank);
        const candidates = ranks.filter((rank, index) => {
            const guessed = direction === 'higher' ? index > referenceValue : index < referenceValue;
            return success ? guessed : !guessed;
        });
        const rank = candidates[randomInt(0, candidates.length - 1, this.random)];
        const suit = suits[randomInt(0, suits.length - 1, this.random)];
        return `${rank}${suit}`;
    }

    higherLowerGame(gameId) {
        const row = this.db.prepare('SELECT * FROM higher_lower_games WHERE game_id=?').get(gameId);
        return row ? { ...row, history: JSON.parse(row.history || '[]') } : null;
    }

    attachHigherLowerMessage(gameId, channelId, messageId) {
        this.db.prepare('UPDATE higher_lower_games SET channel_id=?,message_id=? WHERE game_id=?').run(channelId, messageId, gameId);
    }

    startHigherLower(guildId, userId, wager, interactionId, now = Date.now()) {
        return this.transaction(() => {
            if (this.db.prepare("SELECT 1 FROM higher_lower_games WHERE guild_id=? AND user_id=? AND status='active'").get(guildId, userId)) {
                throw new Error('Finish your active Higher / Lower game first.');
            }
            const gameId = crypto.randomUUID();
            const reserved = this.startProgressiveWager(guildId, userId, wager, interactionId, `higher-lower:${gameId}`, now);
            const currentCard = this.higherLowerReferenceCard();
            this.db.prepare(`INSERT INTO higher_lower_games
                (game_id,guild_id,user_id,wager,current_card,status,interaction_id,created_at,updated_at)
                VALUES(?,?,?,?,?,'active',?,?,?)`)
                .run(gameId, guildId, userId, reserved.amount, currentCard, interactionId, now, now);
            return { ...this.higherLowerGame(gameId), balance: reserved.balance, maximumWager: reserved.maximumWager };
        });
    }

    finishHigherLower(game, now = Date.now(), status = 'cashed-out') {
        if (game.step < 1) {
            this.db.prepare(`UPDATE higher_lower_games SET status='lost',completed_at=?,updated_at=? WHERE game_id=? AND status='active'`)
                .run(now, now, game.game_id);
            this.db.prepare(`UPDATE economy_members SET lifetime_lost=lifetime_lost+?,gambling_losses=gambling_losses+1
                WHERE guild_id=? AND user_id=?`).run(game.wager, game.guild_id, game.user_id);
            return { ...this.higherLowerGame(game.game_id), multiplier: 0, payout: 0, balance: this.member(game.guild_id, game.user_id).balance };
        }
        const multiplier = HIGHER_LOWER_MULTIPLIERS[game.step - 1];
        const payout = randomizedPayout(game.wager * multiplier, this.random);
        const balance = this.applyDelta(game.guild_id, game.user_id, payout, 'higher-lower-payout', game.game_id, null, now);
        this.db.prepare(`UPDATE economy_members SET lifetime_won=lifetime_won+?,gambling_wins=gambling_wins+1
            WHERE guild_id=? AND user_id=?`).run(payout, game.guild_id, game.user_id);
        this.db.prepare(`UPDATE higher_lower_games SET status=?,payout=?,completed_at=?,updated_at=? WHERE game_id=? AND status='active'`)
            .run(status, payout, now, now, game.game_id);
        return { ...this.higherLowerGame(game.game_id), multiplier, payout, balance };
    }

    playHigherLower(gameId, userId, direction, now = Date.now()) {
        return this.transaction(() => {
            const game = this.higherLowerGame(gameId);
            if (!game || game.status !== 'active') throw new Error('This Higher / Lower game is no longer active.');
            if (game.user_id !== userId) throw new Error('This is not your Higher / Lower game.');
            if (!['higher', 'lower'].includes(direction)) throw new Error('Choose Higher or Lower.');
            const successChance = higherLowerSuccessProbability(game.step);
            const success = this.random() < successChance;
            const revealedCard = this.higherLowerReveal(game.current_card, direction, success);
            const history = [...game.history, { reference: game.current_card, direction, revealed: revealedCard, success }];
            if (!success) {
                this.db.prepare(`UPDATE higher_lower_games SET history=?,status='lost',completed_at=?,updated_at=?
                    WHERE game_id=? AND status='active'`).run(JSON.stringify(history), now, now, gameId);
                this.db.prepare(`UPDATE economy_members SET lifetime_lost=lifetime_lost+?,gambling_losses=gambling_losses+1
                    WHERE guild_id=? AND user_id=?`).run(game.wager, game.guild_id, game.user_id);
                return { ...this.higherLowerGame(gameId), revealedCard, success: false, multiplier: 0, balance: this.member(game.guild_id, userId).balance };
            }
            const step = game.step + 1;
            const currentCard = this.higherLowerReferenceCard();
            this.db.prepare('UPDATE higher_lower_games SET current_card=?,step=?,history=?,updated_at=? WHERE game_id=? AND status=\'active\'')
                .run(currentCard, step, JSON.stringify(history), now, gameId);
            const updated = this.higherLowerGame(gameId);
            if (step === HIGHER_LOWER_MULTIPLIERS.length) {
                return { ...this.finishHigherLower(updated, now, 'completed'), revealedCard, success: true };
            }
            return {
                ...updated,
                revealedCard,
                success: true,
                multiplier: HIGHER_LOWER_MULTIPLIERS[step - 1],
                nextMultiplier: HIGHER_LOWER_MULTIPLIERS[step],
                nextSuccessChance: higherLowerSuccessProbability(step) * 100,
                balance: this.member(game.guild_id, userId).balance,
            };
        });
    }

    cashOutHigherLower(gameId, userId, now = Date.now()) {
        return this.transaction(() => {
            const game = this.higherLowerGame(gameId);
            if (!game || game.status !== 'active') throw new Error('This Higher / Lower game is no longer active.');
            if (game.user_id !== userId) throw new Error('This is not your Higher / Lower game.');
            if (game.step < 1) throw new Error('Win at least one card before cashing out.');
            return this.finishHigherLower(game, now);
        });
    }

    dragonTowerGame(gameId) {
        const row = this.db.prepare('SELECT * FROM dragon_tower_games WHERE game_id=?').get(gameId);
        return row ? {
            ...row,
            trapPositions: JSON.parse(row.trap_positions),
            history: JSON.parse(row.history || '[]'),
            multiplier: row.row_number > 0 ? DRAGON_TOWER_MULTIPLIERS[row.row_number - 1] : 0,
            nextMultiplier: row.row_number < DRAGON_TOWER_ROWS ? DRAGON_TOWER_MULTIPLIERS[row.row_number] : null,
        } : null;
    }

    attachDragonTowerMessage(gameId, channelId, messageId) {
        this.db.prepare('UPDATE dragon_tower_games SET channel_id=?,message_id=? WHERE game_id=?').run(channelId, messageId, gameId);
    }

    startDragonTower(guildId, userId, wager, interactionId, now = Date.now()) {
        return this.transaction(() => {
            if (this.db.prepare("SELECT 1 FROM dragon_tower_games WHERE guild_id=? AND user_id=? AND status='active'").get(guildId, userId)) {
                throw new Error('Finish your active Dragon Tower first.');
            }
            const gameId = crypto.randomUUID();
            const reserved = this.startProgressiveWager(guildId, userId, wager, interactionId, `dragon-tower:${gameId}`, now);
            const traps = DRAGON_TOWER_EGGS_PER_ROW.map(eggs => {
                const columns = Array.from({ length: DRAGON_TOWER_COLUMNS }, (_, column) => column);
                for (let index = columns.length - 1; index > 0; index -= 1) {
                    const other = randomInt(0, index, this.random);
                    [columns[index], columns[other]] = [columns[other], columns[index]];
                }
                return columns.slice(0, DRAGON_TOWER_COLUMNS - eggs).sort();
            });
            this.db.prepare(`INSERT INTO dragon_tower_games
                (game_id,guild_id,user_id,wager,trap_positions,status,interaction_id,created_at,updated_at)
                VALUES(?,?,?,?,?,'active',?,?,?)`)
                .run(gameId, guildId, userId, reserved.amount, JSON.stringify(traps), interactionId, now, now);
            return { ...this.dragonTowerGame(gameId), balance: reserved.balance, maximumWager: reserved.maximumWager };
        });
    }

    finishDragonTower(game, now = Date.now(), status = 'cashed-out') {
        if (game.row_number < 1) {
            this.db.prepare(`UPDATE dragon_tower_games SET status='lost',completed_at=?,updated_at=? WHERE game_id=? AND status='active'`)
                .run(now, now, game.game_id);
            this.db.prepare(`UPDATE economy_members SET lifetime_lost=lifetime_lost+?,gambling_losses=gambling_losses+1
                WHERE guild_id=? AND user_id=?`).run(game.wager, game.guild_id, game.user_id);
            return { ...this.dragonTowerGame(game.game_id), multiplier: 0, payout: 0, balance: this.member(game.guild_id, game.user_id).balance };
        }
        const multiplier = DRAGON_TOWER_MULTIPLIERS[game.row_number - 1];
        const payout = randomizedPayout(game.wager * multiplier, this.random);
        const balance = this.applyDelta(game.guild_id, game.user_id, payout, 'dragon-tower-payout', game.game_id, null, now);
        this.db.prepare(`UPDATE economy_members SET lifetime_won=lifetime_won+?,gambling_wins=gambling_wins+1
            WHERE guild_id=? AND user_id=?`).run(payout, game.guild_id, game.user_id);
        this.db.prepare(`UPDATE dragon_tower_games SET status=?,payout=?,completed_at=?,updated_at=? WHERE game_id=? AND status='active'`)
            .run(status, payout, now, now, game.game_id);
        return { ...this.dragonTowerGame(game.game_id), multiplier, payout, balance };
    }

    pickDragonTower(gameId, userId, column, now = Date.now()) {
        return this.transaction(() => {
            const game = this.dragonTowerGame(gameId);
            if (!game || game.status !== 'active') throw new Error('This Dragon Tower game is no longer active.');
            if (game.user_id !== userId) throw new Error('This is not your Dragon Tower game.');
            const selected = boundedInt(column, -1, -1, DRAGON_TOWER_COLUMNS - 1);
            if (selected < 0) throw new Error('Choose a valid tower tile.');
            const traps = game.trapPositions[game.row_number];
            const success = !traps.includes(selected);
            const history = [...game.history, { row: game.row_number, selected, traps, success }];
            if (!success) {
                this.db.prepare(`UPDATE dragon_tower_games SET history=?,status='lost',completed_at=?,updated_at=?
                    WHERE game_id=? AND status='active'`).run(JSON.stringify(history), now, now, gameId);
                this.db.prepare(`UPDATE economy_members SET lifetime_lost=lifetime_lost+?,gambling_losses=gambling_losses+1
                    WHERE guild_id=? AND user_id=?`).run(game.wager, game.guild_id, game.user_id);
                return { ...this.dragonTowerGame(gameId), success: false, selected, traps, multiplier: 0, balance: this.member(game.guild_id, userId).balance };
            }
            const rowNumber = game.row_number + 1;
            this.db.prepare('UPDATE dragon_tower_games SET row_number=?,history=?,updated_at=? WHERE game_id=? AND status=\'active\'')
                .run(rowNumber, JSON.stringify(history), now, gameId);
            const updated = this.dragonTowerGame(gameId);
            if (rowNumber === DRAGON_TOWER_ROWS) return { ...this.finishDragonTower(updated, now, 'completed'), success: true, selected, traps };
            return { ...updated, success: true, selected, traps, balance: this.member(game.guild_id, userId).balance };
        });
    }

    autoPickDragonTower(gameId, userId, now = Date.now()) {
        return this.pickDragonTower(gameId, userId, randomInt(0, DRAGON_TOWER_COLUMNS - 1, this.random), now);
    }

    cashOutDragonTower(gameId, userId, now = Date.now()) {
        return this.transaction(() => {
            const game = this.dragonTowerGame(gameId);
            if (!game || game.status !== 'active') throw new Error('This Dragon Tower game is no longer active.');
            if (game.user_id !== userId) throw new Error('This is not your Dragon Tower game.');
            if (game.row_number < 1) throw new Error('Find at least one egg before cashing out.');
            return this.finishDragonTower(game, now);
        });
    }

    expireProgressiveGames(now = Date.now()) {
        const cutoff = now - 120_000;
        const higherLower = this.db.prepare("SELECT game_id,user_id,step FROM higher_lower_games WHERE status='active' AND updated_at<=?").all(cutoff)
            .map(game => {
                try {
                    return game.step > 0 ? this.cashOutHigherLower(game.game_id, game.user_id, now) : this.transaction(() => this.finishHigherLower(this.higherLowerGame(game.game_id), now, 'expired'));
                } catch { return null; }
            }).filter(Boolean);
        const dragonTower = this.db.prepare("SELECT game_id,user_id,row_number FROM dragon_tower_games WHERE status='active' AND updated_at<=?").all(cutoff)
            .map(game => {
                try {
                    return game.row_number > 0 ? this.cashOutDragonTower(game.game_id, game.user_id, now) : this.transaction(() => this.finishDragonTower(this.dragonTowerGame(game.game_id), now, 'expired'));
                } catch { return null; }
            }).filter(Boolean);
        return { higherLower, dragonTower };
    }

    pay(guildId, senderId, receiverId, amountValue, interactionId, now = Date.now()) {
        if (senderId === receiverId) throw new Error('You cannot pay yourself.');
        const amount = boundedInt(amountValue, 0, 0);
        return this.transaction(() => {
            if (this.hasInteraction(guildId, interactionId)) throw new Error('This transfer was already processed.');
            const sender = this.ensureMember(guildId, senderId, now);
            const receiver = this.ensureMember(guildId, receiverId, now);
            this.assertUsable(sender);
            if (receiver.frozen) throw new Error('The receiving account is frozen.');
            if (amount < this.config.minimumTransfer) throw new Error(`Minimum transfer is ${this.config.minimumTransfer} ${this.config.currencyName}.`);
            const dailyLimit = Math.floor(sender.balance * (this.config.transferLimitPercent / 100));
            if (sender.daily_transfers_sent + amount > dailyLimit) {
                throw new Error(`Transfer limit remaining today: ${Math.max(0, dailyLimit - sender.daily_transfers_sent)} ${this.config.currencyName}.`);
            }
            const senderBalance = this.applyDelta(guildId, senderId, -amount, 'transfer-out', receiverId, interactionId, now);
            const receiverBalance = this.applyDelta(guildId, receiverId, amount, 'transfer-in', senderId, null, now);
            this.db.prepare('UPDATE economy_members SET daily_transfers_sent=daily_transfers_sent+? WHERE guild_id=? AND user_id=?')
                .run(amount, guildId, senderId);
            return { amount, senderBalance, receiverBalance };
        });
    }

    createDeck(deckCount = 1) {
        const deck = [];
        const count = boundedInt(deckCount, 1, 1, 8);
        for (let copy = 0; copy < count; copy += 1) {
            for (const suit of ['♠', '♥', '♦', '♣']) for (const rank of ['2','3','4','5','6','7','8','9','10','J','Q','K','A']) deck.push(`${rank}${suit}`);
        }
        for (let index = deck.length - 1; index > 0; index -= 1) {
            const other = Math.floor(this.random() * (index + 1));
            [deck[index], deck[other]] = [deck[other], deck[index]];
        }
        return deck;
    }

    startPoker(guildId, userId, wager, interactionId, now = Date.now()) {
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
    }

    pokerGame(gameId) {
        const row = this.db.prepare('SELECT * FROM poker_games WHERE game_id=?').get(gameId);
        if (!row) return null;
        return { ...row, initialCards: JSON.parse(row.initial_cards), held: JSON.parse(row.held_cards), deckCards: JSON.parse(row.deck), finalCards: row.final_cards ? JSON.parse(row.final_cards) : null };
    }

    attachPokerMessage(gameId, channelId, messageId) {
        this.db.prepare('UPDATE poker_games SET channel_id=?,message_id=? WHERE game_id=?').run(channelId, messageId, gameId);
    }

    togglePokerHold(gameId, userId, index) {
        return this.transaction(() => {
            const game = this.pokerGame(gameId);
            if (!game || game.status !== 'active') throw new Error('This poker game is no longer active.');
            if (game.user_id !== userId) throw new Error('This is not your poker game.');
            const cardIndex = boundedInt(index, -1, -1, 4);
            if (cardIndex < 0) throw new Error('Invalid card.');
            const held = new Set(game.held);
            if (held.has(cardIndex)) held.delete(cardIndex); else held.add(cardIndex);
            const result = [...held].sort();
            this.db.prepare('UPDATE poker_games SET held_cards=? WHERE game_id=?').run(JSON.stringify(result), gameId);
            return { gameId, cards: game.initialCards, held: result, wager: game.wager };
        });
    }

    evaluatePoker(cards) {
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
    }

    drawPoker(gameId, userId, now = Date.now()) {
        return this.transaction(() => {
            const game = this.pokerGame(gameId);
            if (!game || game.status !== 'active') throw new Error('This poker game is no longer active.');
            if (game.user_id !== userId) throw new Error('This is not your poker game.');
            const held = new Set(game.held);
            const finalCards = game.initialCards.map((card, index) => held.has(index) ? card : game.deckCards.shift());
            const result = this.evaluatePoker(finalCards);
            const payout = Math.floor(game.wager * result.multiplier);
            let balance = this.member(game.guild_id, game.user_id).balance;
            if (payout) balance = this.applyDelta(game.guild_id, game.user_id, payout, 'poker-payout', gameId, null, now);
            const won = payout > game.wager;
            this.db.prepare(`UPDATE economy_members SET lifetime_won=lifetime_won+?, lifetime_lost=lifetime_lost+?,
                gambling_wins=gambling_wins+?, gambling_losses=gambling_losses+? WHERE guild_id=? AND user_id=?`)
                .run(payout, payout === 0 ? game.wager : 0, won ? 1 : 0, payout === 0 ? 1 : 0, game.guild_id, game.user_id);
            this.db.prepare(`UPDATE poker_games SET final_cards=?,status='complete',payout=?,completed_at=? WHERE game_id=? AND status='active'`)
                .run(JSON.stringify(finalCards), payout, now, gameId);
            return { gameId, userId: game.user_id, channelId: game.channel_id, messageId: game.message_id, cards: finalCards, hand: result.name, multiplier: result.multiplier, payout, wager: game.wager, balance };
        });
    }

    expirePokerGames(now = Date.now()) {
        const cutoff = now - 60_000;
        const games = this.db.prepare("SELECT game_id,user_id FROM poker_games WHERE status='active' AND created_at<=?").all(cutoff);
        return games.map(game => {
            try { return this.drawPoker(game.game_id, game.user_id, now); } catch { return null; }
        }).filter(Boolean);
    }

    blackjackGame(gameId) {
        const row = this.db.prepare('SELECT * FROM blackjack_games WHERE game_id=?').get(gameId);
        if (!row) return null;
        const playerCards = JSON.parse(row.player_cards);
        const splitCards = JSON.parse(row.split_cards || '[]');
        const hands = splitCards.length ? [playerCards, splitCards] : [playerCards];
        const storedWagers = JSON.parse(row.hand_wagers || '[]');
        const handWagers = storedWagers.length === hands.length ? storedWagers : hands.map(() => row.base_wager || row.wager);
        const handOutcomes = JSON.parse(row.hand_outcomes || '[]');
        return {
            ...row,
            playerCards,
            splitCards,
            hands,
            handWagers,
            handOutcomes,
            dealerCards: JSON.parse(row.dealer_cards),
            deckCards: JSON.parse(row.deck),
            playerHand: blackjackHand(hands[Math.min(row.active_hand, hands.length - 1)]),
            handValues: hands.map(blackjackHand),
            dealerHand: blackjackHand(JSON.parse(row.dealer_cards)),
            canSplit: hands.length === 1 && blackjackCanSplit(playerCards),
        };
    }

    attachBlackjackMessage(gameId, channelId, messageId) {
        this.db.prepare('UPDATE blackjack_games SET channel_id=?,message_id=? WHERE game_id=?').run(channelId, messageId, gameId);
    }

    finishBlackjack(game, outcome, now = Date.now(), natural = false) {
        return this.finishBlackjackHands(game, [outcome], now, [natural]);
    }

    finishBlackjackHands(game, outcomes, now = Date.now(), naturalFlags = []) {
        const payouts = outcomes.map((outcome, index) => {
            const wager = game.handWagers[index] || game.base_wager || game.wager;
            if (outcome === 'push') return wager;
            if (['win', 'blackjack'].includes(outcome)) return blackjackPayout(wager, Boolean(naturalFlags[index]));
            return 0;
        });
        const payout = payouts.reduce((sum, value) => sum + value, 0);
        let balance = this.member(game.guild_id, game.user_id).balance;
        if (payout) {
            const type = outcomes.every(outcome => outcome === 'push') ? 'blackjack-push' : 'blackjack-payout';
            balance = this.applyDelta(game.guild_id, game.user_id, payout, type, game.game_id, null, now);
        }
        const wins = outcomes.filter(outcome => ['win', 'blackjack'].includes(outcome)).length;
        const losses = outcomes.filter(outcome => ['loss', 'bust', 'dealer-blackjack'].includes(outcome)).length;
        const lostAmount = outcomes.reduce((sum, outcome, index) => losses && ['loss', 'bust', 'dealer-blackjack'].includes(outcome)
            ? sum + (game.handWagers[index] || game.base_wager || game.wager)
            : sum, 0);
        this.db.prepare(`UPDATE economy_members SET lifetime_won=lifetime_won+?,lifetime_lost=lifetime_lost+?,
            gambling_wins=gambling_wins+?,gambling_losses=gambling_losses+? WHERE guild_id=? AND user_id=?`)
            .run(wins ? payout : 0, lostAmount, wins, losses, game.guild_id, game.user_id);
        const outcome = outcomes.length === 1 ? outcomes[0] : outcomes.join(',');
        this.db.prepare(`UPDATE blackjack_games SET status='complete',outcome=?,hand_outcomes=?,payout=?,completed_at=?
            WHERE game_id=? AND status='active'`).run(outcome, JSON.stringify(outcomes), payout, now, game.game_id);
        return { ...this.blackjackGame(game.game_id), balance };
    }

    settleBlackjack(game, now = Date.now()) {
        const dealerCards = [...game.dealerCards];
        const deckCards = [...game.deckCards];
        while (blackjackHand(dealerCards).total < 17) dealerCards.push(deckCards.shift());
        this.db.prepare('UPDATE blackjack_games SET dealer_cards=?,deck=? WHERE game_id=?')
            .run(JSON.stringify(dealerCards), JSON.stringify(deckCards), game.game_id);
        const updated = this.blackjackGame(game.game_id);
        const dealer = updated.dealerHand;
        const outcomes = updated.handValues.map(player => {
            if (player.bust) return 'bust';
            if (dealer.bust || player.total > dealer.total) return 'win';
            if (player.total === dealer.total) return 'push';
            return 'loss';
        });
        return this.finishBlackjackHands(updated, outcomes, now);
    }

    startBlackjack(guildId, userId, wager, interactionId, now = Date.now()) {
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
    }

    hitBlackjack(gameId, userId, now = Date.now()) {
        return this.transaction(() => {
            const game = this.blackjackGame(gameId);
            if (!game || game.status !== 'active') throw new Error('This blackjack game is no longer active.');
            if (game.user_id !== userId) throw new Error('This is not your blackjack game.');
            const hands = game.hands.map(cards => [...cards]);
            hands[game.active_hand].push(game.deckCards.shift());
            this.db.prepare('UPDATE blackjack_games SET player_cards=?,split_cards=?,deck=?,updated_at=? WHERE game_id=?')
                .run(JSON.stringify(hands[0]), JSON.stringify(hands[1] || []), JSON.stringify(game.deckCards), now, gameId);
            const updated = this.blackjackGame(gameId);
            if (updated.playerHand.bust || updated.playerHand.total === 21) return this.advanceBlackjack(updated, now);
            return { ...updated, balance: this.member(updated.guild_id, updated.user_id).balance };
        });
    }

    advanceBlackjack(game, now = Date.now()) {
        if (game.active_hand < game.hands.length - 1) {
            this.db.prepare('UPDATE blackjack_games SET active_hand=active_hand+1,updated_at=? WHERE game_id=?')
                .run(now, game.game_id);
            const updated = this.blackjackGame(game.game_id);
            if (updated.playerHand.total === 21) return this.advanceBlackjack(updated, now);
            return { ...updated, balance: this.member(updated.guild_id, updated.user_id).balance };
        }
        return this.settleBlackjack(game, now);
    }

    standBlackjack(gameId, userId, now = Date.now()) {
        return this.transaction(() => {
            const game = this.blackjackGame(gameId);
            if (!game || game.status !== 'active') throw new Error('This blackjack game is no longer active.');
            if (game.user_id !== userId) throw new Error('This is not your blackjack game.');
            return this.advanceBlackjack(game, now);
        });
    }

    doubleBlackjack(gameId, userId, interactionId, now = Date.now()) {
        return this.transaction(() => {
            const game = this.blackjackGame(gameId);
            if (!game || game.status !== 'active') throw new Error('This blackjack game is no longer active.');
            if (game.user_id !== userId) throw new Error('This is not your blackjack game.');
            const currentCards = game.hands[game.active_hand];
            const currentWager = game.handWagers[game.active_hand];
            if (currentCards.length !== 2) throw new Error('Double Down is only available before the first Hit on this hand.');
            this.reserveGameWager('blackjack', game.guild_id, userId, currentWager, interactionId, `blackjack-double:${gameId}:${game.active_hand}`, now, false);
            const hands = game.hands.map(cards => [...cards]);
            const handWagers = [...game.handWagers];
            hands[game.active_hand].push(game.deckCards.shift());
            handWagers[game.active_hand] *= 2;
            this.db.prepare(`UPDATE blackjack_games SET wager=?,player_cards=?,split_cards=?,hand_wagers=?,deck=?,updated_at=?
                WHERE game_id=?`).run(
                game.wager + currentWager,
                JSON.stringify(hands[0]), JSON.stringify(hands[1] || []), JSON.stringify(handWagers), JSON.stringify(game.deckCards), now, gameId,
            );
            return this.advanceBlackjack(this.blackjackGame(gameId), now);
        });
    }

    splitBlackjack(gameId, userId, interactionId, now = Date.now()) {
        return this.transaction(() => {
            const game = this.blackjackGame(gameId);
            if (!game || game.status !== 'active') throw new Error('This blackjack game is no longer active.');
            if (game.user_id !== userId) throw new Error('This is not your blackjack game.');
            if (!game.canSplit) throw new Error('Split requires two cards with the same value.');
            const splitWager = game.handWagers[0];
            this.reserveGameWager('blackjack', game.guild_id, userId, splitWager, interactionId, `blackjack-split:${gameId}`, now, false);
            const firstHand = [game.playerCards[0], game.deckCards.shift()];
            const secondHand = [game.playerCards[1], game.deckCards.shift()];
            this.db.prepare(`UPDATE blackjack_games SET wager=?,player_cards=?,split_cards=?,hand_wagers=?,deck=?,active_hand=0,updated_at=?
                WHERE game_id=?`).run(
                game.wager + splitWager,
                JSON.stringify(firstHand), JSON.stringify(secondHand), JSON.stringify([splitWager, splitWager]), JSON.stringify(game.deckCards), now, gameId,
            );
            const updated = this.blackjackGame(gameId);
            if (updated.playerHand.total === 21) return this.advanceBlackjack(updated, now);
            return { ...updated, balance: this.member(updated.guild_id, updated.user_id).balance };
        });
    }

    expireBlackjackGames(now = Date.now()) {
        const cutoff = now - 120_000;
        const games = this.db.prepare("SELECT game_id,user_id FROM blackjack_games WHERE status='active' AND updated_at<=?").all(cutoff);
        return games.map(game => {
            try { return this.standBlackjack(game.game_id, game.user_id, now); } catch { return null; }
        }).filter(Boolean);
    }

    duel(duelId) {
        return this.db.prepare('SELECT * FROM duels WHERE duel_id=?').get(duelId) || null;
    }

    pendingDuelFor(guildId, challengedId) {
        return this.db.prepare(`SELECT * FROM duels WHERE guild_id=? AND challenged_id=? AND status='pending'
            ORDER BY created_at DESC LIMIT 1`).get(guildId, challengedId) || null;
    }

    attachDuelMessage(duelId, channelId, messageId) {
        this.db.prepare('UPDATE duels SET channel_id=?,message_id=? WHERE duel_id=?').run(channelId, messageId, duelId);
    }

    createDuel(guildId, challengerId, challengedId, wager, interactionId, now = Date.now()) {
        if (challengerId === challengedId) throw new Error('You cannot duel yourself.');
        return this.transaction(() => {
            const existing = this.db.prepare(`SELECT duel_id FROM duels WHERE guild_id=? AND status='pending'
                AND (challenger_id IN (?,?) OR challenged_id IN (?,?)) LIMIT 1`)
                .get(guildId, challengerId, challengedId, challengerId, challengedId);
            if (existing) throw new Error('One of these players already has a pending duel.');
            const challenged = this.ensureMember(guildId, challengedId, now);
            this.assertUsable(challenged);
            const duelId = crypto.randomUUID();
            const reserved = this.reserveWager(guildId, challengerId, wager, interactionId, `duel:${duelId}`, now);
            const expiresAt = now + 300_000;
            this.db.prepare(`INSERT INTO duels
                (duel_id,guild_id,challenger_id,challenged_id,wager,status,interaction_id,created_at,expires_at)
                VALUES(?,?,?,?,?,'pending',?,?,?)`)
                .run(duelId, guildId, challengerId, challengedId, reserved.amount, interactionId, now, expiresAt);
            return { ...this.duel(duelId), challengerBalance: reserved.balance };
        });
    }

    refundDuel(duel, status, now = Date.now()) {
        const balance = this.applyDelta(duel.guild_id, duel.challenger_id, duel.wager, 'duel-refund', duel.duel_id, null, now);
        this.db.prepare(`UPDATE economy_members SET lifetime_wagered=MAX(0,lifetime_wagered-?),daily_wagered=MAX(0,daily_wagered-?)
            WHERE guild_id=? AND user_id=?`).run(duel.wager, duel.wager, duel.guild_id, duel.challenger_id);
        this.db.prepare('UPDATE duels SET status=?,completed_at=? WHERE duel_id=? AND status=\'pending\'')
            .run(status, now, duel.duel_id);
        return { ...this.duel(duel.duel_id), challengerBalance: balance };
    }

    respondToDuel(guildId, challengedId, response, interactionId, now = Date.now()) {
        return this.transaction(() => {
            const duel = this.db.prepare(`SELECT * FROM duels WHERE guild_id=? AND challenged_id=? AND status='pending'
                ORDER BY created_at DESC LIMIT 1`).get(guildId, challengedId);
            if (!duel) throw new Error('You do not have a pending duel challenge.');
            if (now >= duel.expires_at) return this.refundDuel(duel, 'expired', now);
            if (response === 'deny') return this.refundDuel(duel, 'denied', now);
            if (response !== 'accept') throw new Error('Use !accept or !deny.');
            this.reserveWager(guildId, challengedId, duel.wager, interactionId, `duel:${duel.duel_id}`, now);
            const winnerId = this.random() < 0.5 ? duel.challenger_id : duel.challenged_id;
            const loserId = winnerId === duel.challenger_id ? duel.challenged_id : duel.challenger_id;
            const payout = duel.wager * 2;
            const winnerBalance = this.applyDelta(guildId, winnerId, payout, 'duel-payout', duel.duel_id, null, now);
            this.db.prepare(`UPDATE economy_members SET lifetime_won=lifetime_won+?,gambling_wins=gambling_wins+1
                WHERE guild_id=? AND user_id=?`).run(payout, guildId, winnerId);
            this.db.prepare(`UPDATE economy_members SET lifetime_lost=lifetime_lost+?,gambling_losses=gambling_losses+1
                WHERE guild_id=? AND user_id=?`).run(duel.wager, guildId, loserId);
            this.db.prepare(`UPDATE duels SET status='complete',winner_id=?,completed_at=? WHERE duel_id=? AND status='pending'`)
                .run(winnerId, now, duel.duel_id);
            return { ...this.duel(duel.duel_id), payout, winnerBalance };
        });
    }

    expireDuels(now = Date.now()) {
        const pending = this.db.prepare("SELECT * FROM duels WHERE status='pending' AND expires_at<=?").all(now);
        return pending.map(duel => {
            try { return this.transaction(() => this.refundDuel(duel, 'expired', now)); } catch { return null; }
        }).filter(Boolean);
    }

    heistRound(roundId) {
        const row = this.db.prepare('SELECT * FROM heist_rounds WHERE round_id=?').get(roundId);
        if (!row) return null;
        const entries = this.db.prepare('SELECT user_id,entry_fee,payout,joined_at FROM heist_entries WHERE round_id=? ORDER BY joined_at').all(roundId);
        return { ...row, entries, participantCount: entries.length };
    }

    heistSchedule(now = Date.now()) {
        const hour = 60 * 60 * 1000;
        const startsAt = Math.floor(now / hour) * hour;
        return {
            startsAt,
            signupEndsAt: startsAt + (this.config.heistEntryMinutes * 60000),
            nextAt: startsAt + hour,
        };
    }

    createHeistRound(guildId, now = Date.now()) {
        return this.transaction(() => {
            const existing = this.db.prepare("SELECT round_id FROM heist_rounds WHERE guild_id=? AND status='signup' ORDER BY created_at DESC LIMIT 1").get(guildId);
            if (existing) return this.heistRound(existing.round_id);
            const roundId = crypto.randomUUID();
            const schedule = this.heistSchedule(now);
            this.db.prepare(`INSERT INTO heist_rounds(round_id,guild_id,status,entry_fee,signup_ends_at,created_at)
                VALUES(?,?,'signup',?,?,?)`).run(roundId, guildId, this.config.heistEntryFee, schedule.signupEndsAt, schedule.startsAt);
            return this.heistRound(roundId);
        });
    }

    heistState(guildId, now = Date.now()) {
        const schedule = this.heistSchedule(now);
        let active = this.db.prepare("SELECT round_id FROM heist_rounds WHERE guild_id=? AND status='signup' ORDER BY created_at DESC LIMIT 1").get(guildId);
        if (active) {
            let round = this.heistRound(active.round_id);
            if (round.created_at < schedule.startsAt || now >= schedule.signupEndsAt) {
                round = this.resolveHeist(round.round_id, Math.max(round.signup_ends_at, now));
            } else {
                if (round.signup_ends_at !== schedule.signupEndsAt) {
                    this.db.prepare('UPDATE heist_rounds SET signup_ends_at=? WHERE round_id=?').run(schedule.signupEndsAt, round.round_id);
                    round = this.heistRound(round.round_id);
                }
                return { phase: 'signup', round, nextAt: schedule.signupEndsAt };
            }
        }
        let current = this.db.prepare(`SELECT round_id FROM heist_rounds WHERE guild_id=? AND created_at>=? AND created_at<?
            ORDER BY created_at DESC LIMIT 1`).get(guildId, schedule.startsAt, schedule.nextAt);
        if (!current) {
            const round = this.createHeistRound(guildId, now);
            if (now < schedule.signupEndsAt) return { phase: 'signup', round, nextAt: schedule.signupEndsAt };
            current = { round_id: this.resolveHeist(round.round_id, schedule.signupEndsAt).round_id };
        }
        const round = this.heistRound(current.round_id);
        if (round.status === 'signup' && now < schedule.signupEndsAt) return { phase: 'signup', round, nextAt: schedule.signupEndsAt };
        if (round.status === 'signup') return { phase: 'cooldown', round: this.resolveHeist(round.round_id, schedule.signupEndsAt), nextAt: schedule.nextAt };
        return { phase: 'cooldown', round, nextAt: schedule.nextAt };
    }

    joinHeist(guildId, userId, roundId, interactionId, now = Date.now()) {
        return this.transaction(() => {
            const round = this.heistRound(roundId);
            if (!round || round.guild_id !== guildId || round.status !== 'signup' || now >= round.signup_ends_at) {
                throw new Error('Entry for this heist is closed.');
            }
            if (round.entries.some(entry => entry.user_id === userId)) {
                return { alreadyEntered: true, round };
            }
            const member = this.ensureMember(guildId, userId, now);
            this.assertUsable(member);
            const reserved = round.entry_fee > 0
                ? this.reserveWager(guildId, userId, round.entry_fee, interactionId, `heist:${roundId}`, now)
                : { balance: member.balance };
            this.db.prepare('INSERT INTO heist_entries(round_id,guild_id,user_id,entry_fee,joined_at) VALUES(?,?,?,?,?)')
                .run(roundId, guildId, userId, round.entry_fee, now);
            this.db.prepare('UPDATE heist_rounds SET pot=pot+? WHERE round_id=?').run(round.entry_fee, roundId);
            return { alreadyEntered: false, balance: reserved.balance, round: this.heistRound(roundId) };
        });
    }

    heistEntryStatus(roundId, userId) {
        const round = this.heistRound(roundId);
        if (!round) return null;
        const entry = round.entries.find(item => item.user_id === userId) || null;
        return { entered: Boolean(entry), entry, round };
    }

    resolveHeist(roundId, now = Date.now()) {
        return this.transaction(() => {
            const round = this.heistRound(roundId);
            if (!round || round.status !== 'signup') return round;
            const entries = round.entries;
            if (entries.length < this.config.heistMinimumPlayers) {
                for (const entry of entries) {
                    if (entry.entry_fee > 0) {
                        this.applyDelta(round.guild_id, entry.user_id, entry.entry_fee, 'heist-refund', roundId, null, now);
                    }
                }
                this.db.prepare("UPDATE heist_rounds SET status='cancelled',success=0,payout_total=?,completed_at=? WHERE round_id=?")
                    .run(round.pot, now, roundId);
                return this.heistRound(roundId);
            }
            const chance = Math.min(
                this.config.heistMaximumSuccessChance,
                this.config.heistBaseSuccessChance + ((entries.length - 1) * this.config.heistChancePerExtraPlayer),
            );
            const success = (this.random() * 100) < chance;
            const share = success
                ? (round.entry_fee === 0
                    ? this.config.heistFreeSuccessReward
                    : Math.floor((round.pot * this.config.heistPayoutMultiplier) / entries.length))
                : 0;
            for (const entry of entries) {
                if (share) this.applyDelta(round.guild_id, entry.user_id, share, 'heist-payout', roundId, null, now);
                this.db.prepare(`UPDATE economy_members SET lifetime_won=lifetime_won+?,lifetime_lost=lifetime_lost+?,
                    gambling_wins=gambling_wins+?,gambling_losses=gambling_losses+? WHERE guild_id=? AND user_id=?`)
                    .run(share, success ? 0 : entry.entry_fee, success ? 1 : 0, success ? 0 : 1, round.guild_id, entry.user_id);
                this.db.prepare('UPDATE heist_entries SET payout=? WHERE round_id=? AND user_id=?').run(share, roundId, entry.user_id);
            }
            this.db.prepare("UPDATE heist_rounds SET status='complete',success_chance=?,success=?,payout_total=?,completed_at=? WHERE round_id=?")
                .run(chance, success ? 1 : 0, share * entries.length, now, roundId);
            return this.heistRound(roundId);
        });
    }

    leaderboard(guildId, type = 'balance', limit = 10, now = Date.now(), periodOverride = '') {
        if (['daily', 'weekly', 'monthly'].includes(type)) {
            const periods = periodKeys(now, this.config);
            const column = { daily: 'period_day', weekly: 'period_week', monthly: 'period_month' }[type];
            const key = periodOverride || { daily: periods.day, weekly: periods.week, monthly: periods.month }[type];
            const cutoff = this.periodCutoff(guildId, type, 'rankings', key);
            return this.db.prepare(`SELECT m.user_id,m.balance,m.lifetime_earned,m.lifetime_won,m.voice_minutes,
                COALESCE(SUM(CASE WHEN t.amount>0 AND t.type NOT IN ('transfer-in','admin-add','admin-set','admin-bulk-add','heist-refund') THEN t.amount ELSE 0 END),0) AS score
                FROM economy_members m LEFT JOIN economy_transactions t
                ON t.guild_id=m.guild_id AND t.user_id=m.user_id AND t.${column}=? AND t.created_at>=?
                WHERE m.guild_id=? GROUP BY m.user_id ORDER BY score DESC,m.updated_at ASC LIMIT ?`)
                .all(key, cutoff, guildId, Math.max(limit * 2, limit))
                .filter(row => !this.excludedLeaderboardUsers.has(row.user_id)).slice(0, limit)
                .map(row => ({ ...row, rank: rankFor(row.balance), period: key }));
        }
        const columns = {
            balance: 'balance', lifetime: 'lifetime_earned', gambling: 'lifetime_won', voice: 'voice_minutes',
        };
        const column = columns[type] || columns.balance;
        return this.db.prepare(`SELECT user_id,balance,lifetime_earned,lifetime_won,voice_minutes,(${column}) AS score
            FROM economy_members WHERE guild_id=? ORDER BY score DESC,updated_at ASC LIMIT ?`).all(guildId, Math.max(limit * 2, limit))
            .filter(row => !this.excludedLeaderboardUsers.has(row.user_id)).slice(0, limit)
            .map(row => ({ ...row, rank: rankFor(row.balance) }));
    }

    setting(guildId, key) {
        return this.db.prepare('SELECT setting_value FROM economy_settings WHERE guild_id=? AND setting_key=?').get(guildId, key)?.setting_value || '';
    }

    setSetting(guildId, key, value) {
        this.db.prepare(`INSERT INTO economy_settings(guild_id,setting_key,setting_value) VALUES(?,?,?)
            ON CONFLICT(guild_id,setting_key) DO UPDATE SET setting_value=excluded.setting_value`).run(guildId, key, String(value));
    }

    periodCutoff(guildId, period, category, periodKey) {
        if (!['weekly', 'monthly'].includes(period)) return 0;
        const prefix = `${period}_${category}`;
        return this.setting(guildId, `${prefix}_period`) === periodKey
            ? boundedInt(this.setting(guildId, `${prefix}_cutoff`), 0, 0)
            : 0;
    }

    periodStats(guildId, period, category, now = Date.now(), periodOverride = '') {
        if (!['weekly', 'monthly'].includes(period)) throw new Error('Statistics period must be weekly or monthly.');
        if (!['activity', 'gambling'].includes(category)) throw new Error('Statistics category must be activity or gambling.');
        const periods = periodKeys(now, this.config);
        const key = periodOverride || periods[period === 'weekly' ? 'week' : 'month'];
        const column = period === 'weekly' ? 'period_week' : 'period_month';
        const cutoff = this.periodCutoff(guildId, period, category, key);
        const types = category === 'activity'
            ? ['text', 'media', 'voice', 'daily']
            : ['wager', 'dice-payout', 'poker-payout', 'blackjack-payout', 'duel-payout', 'heist-payout'];
        const placeholders = types.map(() => '?').join(',');
        const row = this.db.prepare(`SELECT COUNT(*) AS transactions,COUNT(DISTINCT user_id) AS members,
            COALESCE(SUM(CASE WHEN amount>0 THEN amount ELSE 0 END),0) AS earned,
            COALESCE(SUM(CASE WHEN type='wager' THEN -amount ELSE 0 END),0) AS wagered,
            COALESCE(SUM(CASE WHEN type!='wager' AND amount>0 THEN amount ELSE 0 END),0) AS payouts,
            COALESCE(SUM(amount),0) AS net
            FROM economy_transactions WHERE guild_id=? AND ${column}=? AND created_at>=? AND type IN (${placeholders})`)
            .get(guildId, key, cutoff, ...types);
        return { period, category, periodKey: key, cutoff, ...row };
    }

    resetActionDetails(action) {
        const actions = {
            'weekly-rankings': ['weekly', 'rankings'],
            'monthly-rankings': ['monthly', 'rankings'],
            'weekly-activity': ['weekly', 'activity'],
            'monthly-activity': ['monthly', 'activity'],
            'weekly-gambling': ['weekly', 'gambling'],
            'monthly-gambling': ['monthly', 'gambling'],
        };
        return actions[action] || null;
    }

    previewEconomyReset(guildId, action, userId = '', now = Date.now()) {
        const periodAction = this.resetActionDetails(action);
        if (periodAction) {
            const [period, category] = periodAction;
            const periods = periodKeys(now, this.config);
            const periodKey = periods[period === 'weekly' ? 'week' : 'month'];
            if (category === 'rankings') {
                const leaders = this.leaderboard(guildId, period, 10000, now);
                return { action, period, category, periodKey, affectedMembers: leaders.filter(row => row.score > 0).length, leaders };
            }
            return { action, ...this.periodStats(guildId, period, category, now) };
        }
        if (action === 'all-balances') {
            const row = this.db.prepare('SELECT COUNT(*) AS affectedMembers,COALESCE(SUM(balance),0) AS currentBalance FROM economy_members WHERE guild_id=? AND balance>0').get(guildId);
            return { action, ...row };
        }
        if (action === 'member-balance') {
            if (!/^\d{17,20}$/.test(String(userId))) throw new Error('Enter a valid Discord user ID for the member balance reset.');
            const member = this.publicMember(guildId, String(userId));
            return { action, userId: String(userId), affectedMembers: member.balance > 0 ? 1 : 0, currentBalance: member.balance };
        }
        if (action === 'gambling-limits') {
            const row = this.db.prepare(`SELECT COUNT(*) AS affectedMembers,
                COALESCE(SUM(daily_wagered),0) AS totalDailyWagered,
                COALESCE(SUM(daily_blackjack_wagered),0) AS blackjackWagered,
                COALESCE(SUM(daily_poker_wagered),0) AS pokerWagered
                FROM economy_members WHERE guild_id=? AND (daily_wagered>0 OR daily_blackjack_wagered>0 OR daily_poker_wagered>0)`).get(guildId);
            return { action, ...row };
        }
        throw new Error('Unknown reset action.');
    }

    executeEconomyReset(guildId, action, userId = '', now = Date.now()) {
        const preview = this.previewEconomyReset(guildId, action, userId, now);
        return this.transaction(() => {
            const periodAction = this.resetActionDetails(action);
            if (periodAction) {
                const [period, category] = periodAction;
                this.setSetting(guildId, `${period}_${category}_period`, preview.periodKey);
                this.setSetting(guildId, `${period}_${category}_cutoff`, now);
                return { ...preview, resetAt: now };
            }
            if (action === 'gambling-limits') {
                this.db.prepare('UPDATE economy_members SET daily_wagered=0,daily_blackjack_wagered=0,daily_poker_wagered=0 WHERE guild_id=?').run(guildId);
                this.setSetting(guildId, 'gambling_rate_reset_at', now);
                return { ...preview, resetAt: now };
            }
            const targets = action === 'member-balance'
                ? this.db.prepare('SELECT user_id,balance FROM economy_members WHERE guild_id=? AND user_id=? AND balance>0').all(guildId, String(userId))
                : this.db.prepare('SELECT user_id,balance FROM economy_members WHERE guild_id=? AND balance>0').all(guildId);
            const periods = periodKeys(now, this.config);
            const insert = this.db.prepare(`INSERT INTO economy_transactions
                (id,guild_id,user_id,amount,balance_before,balance_after,type,related,interaction_id,period_day,period_week,period_month,created_at)
                VALUES(?,?,?,?,?,0,'admin-balance-reset',?,NULL,?,?,?,?)`);
            const update = this.db.prepare('UPDATE economy_members SET balance=0,updated_at=? WHERE guild_id=? AND user_id=?');
            for (const member of targets) {
                insert.run(crypto.randomUUID(), guildId, member.user_id, -member.balance, member.balance, action, periods.day, periods.week, periods.month, now);
                update.run(now, guildId, member.user_id);
            }
            return { ...preview, resetAt: now };
        });
    }

    previewBulkGrant(guildId, userIds, amount) {
        const requested = Number.parseInt(amount, 10);
        if (!Number.isFinite(requested) || requested < 1) throw new Error('Enter a positive Blood Money amount to give each member.');
        const grant = Math.min(requested, 1_000_000_000);
        const members = [...new Set((Array.isArray(userIds) ? userIds : [])
            .map(value => String(value || '').trim()).filter(value => /^\d{17,20}$/.test(value)))];
        if (!members.length) throw new Error('No human Discord members were found in this server.');
        return {
            action: 'bulk-grant',
            amountPerMember: grant,
            affectedMembers: members.length,
            totalGrant: grant * members.length,
            userIds: members,
        };
    }

    executeBulkGrant(guildId, userIds, amount, batchId = crypto.randomUUID(), now = Date.now()) {
        const preview = this.previewBulkGrant(guildId, userIds, amount);
        return this.transaction(() => {
            for (const userId of preview.userIds) {
                this.applyDelta(guildId, userId, preview.amountPerMember, 'admin-bulk-add', `batch:${batchId}`, `${batchId}:${userId}`, now);
            }
            return { ...preview, batchId, grantedAt: now };
        });
    }

    pendingWeeklyArchive(guildId) {
        const value = this.setting(guildId, 'pending_weekly_archive');
        if (!value) return null;
        try { return JSON.parse(value); } catch { return null; }
    }

    completeWeeklyArchive(guildId) {
        this.db.prepare("DELETE FROM economy_settings WHERE guild_id=? AND setting_key='pending_weekly_archive'").run(guildId);
    }

    rolloverWeek(guildId, now = Date.now()) {
        const pending = this.pendingWeeklyArchive(guildId);
        if (pending) return pending;
        const currentWeek = periodKeys(now, this.config).week;
        const lastWeek = this.setting(guildId, 'active_week');
        if (!lastWeek) {
            this.setSetting(guildId, 'active_week', currentWeek);
            return null;
        }
        if (lastWeek === currentWeek) return null;
        const result = {
            archivedWeek: lastWeek,
            currentWeek,
            leaders: this.leaderboard(guildId, 'weekly', 10000, now, lastWeek),
            activity: this.periodStats(guildId, 'weekly', 'activity', now, lastWeek),
            gambling: this.periodStats(guildId, 'weekly', 'gambling', now, lastWeek),
            archivedAt: now,
        };
        return this.transaction(() => {
            this.setSetting(guildId, 'pending_weekly_archive', JSON.stringify(result));
            this.setSetting(guildId, 'active_week', currentWeek);
            return result;
        });
    }

    pendingMonthlyArchive(guildId) {
        const value = this.setting(guildId, 'pending_monthly_archive');
        if (!value) return null;
        try { return JSON.parse(value); } catch { return null; }
    }

    completeMonthlyArchive(guildId) {
        this.db.prepare("DELETE FROM economy_settings WHERE guild_id=? AND setting_key='pending_monthly_archive'").run(guildId);
    }

    repArchiveQueue(guildId) {
        const value = this.setting(guildId, 'rep_pending_archive');
        if (!value) return [];
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [parsed];
        } catch { return []; }
    }

    pendingRepArchive(guildId) {
        return this.repArchiveQueue(guildId)[0] || null;
    }

    updateRepArchiveStatus(guildId, part) {
        const queue = this.repArchiveQueue(guildId);
        const pending = queue[0];
        if (!pending) return null;
        if (part === 'announcement') pending.announced = true;
        if (part === 'log') pending.logged = true;
        if (pending.announced && pending.logged) {
            queue.shift();
        }
        if (!queue.length) {
            this.db.prepare("DELETE FROM economy_settings WHERE guild_id=? AND setting_key='rep_pending_archive'").run(guildId);
        } else {
            this.setSetting(guildId, 'rep_pending_archive', JSON.stringify(queue));
        }
        return queue[0] || null;
    }

    rolloverRepMonth(guildId, now = Date.now()) {
        const currentMonth = repMonthKey(now, 'America/New_York');
        const activeMonth = this.setting(guildId, 'rep_active_month');
        if (!activeMonth) {
            this.setSetting(guildId, 'rep_active_month', currentMonth);
            return this.pendingRepArchive(guildId);
        }
        if (activeMonth === currentMonth) return this.pendingRepArchive(guildId);
        const leaders = this.repLeaderboard(guildId, 10000);
        return this.transaction(() => {
            const queue = this.repArchiveQueue(guildId);
            const memberCount = this.db.prepare('SELECT COUNT(*) AS total FROM rep_members WHERE guild_id=?').get(guildId).total;
            this.db.prepare(`UPDATE rep_members SET points=0,last_message_at=0,qualified_voice_minutes=0,updated_at=?
                WHERE guild_id=?`).run(now, guildId);
            const archive = {
                archivedMonth: activeMonth,
                currentMonth,
                leaders,
                memberCount,
                announced: false,
                logged: false,
                resetAt: now,
            };
            queue.push(archive);
            this.setSetting(guildId, 'rep_active_month', currentMonth);
            this.setSetting(guildId, 'rep_pending_archive', JSON.stringify(queue));
            return queue[0];
        });
    }

    rolloverMonth(guildId, now = Date.now()) {
        const pending = this.pendingMonthlyArchive(guildId);
        if (pending) return pending;
        const currentMonth = periodKeys(now, this.config).month;
        const lastMonth = this.setting(guildId, 'active_month');
        if (!lastMonth) {
            this.setSetting(guildId, 'active_month', currentMonth);
            return null;
        }
        if (lastMonth === currentMonth) return null;
        const leaders = this.leaderboard(guildId, 'monthly', 10000, now, lastMonth);
        const activity = this.periodStats(guildId, 'monthly', 'activity', now, lastMonth);
        const gambling = this.periodStats(guildId, 'monthly', 'gambling', now, lastMonth);
        return this.transaction(() => {
            const members = this.db.prepare('SELECT user_id,balance FROM economy_members WHERE guild_id=? AND balance>0').all(guildId);
            const periods = periodKeys(now, this.config);
            const result = {
                archivedMonth: lastMonth, currentMonth, leaders, activity, gambling,
                resetMembers: members.length,
                resetTotal: members.reduce((sum, member) => sum + member.balance, 0),
                archivedAt: now,
            };
            // Persist the final snapshot before changing balances. Discord delivery may be retried safely.
            this.setSetting(guildId, 'pending_monthly_archive', JSON.stringify(result));
            const insert = this.db.prepare(`INSERT INTO economy_transactions
                (id,guild_id,user_id,amount,balance_before,balance_after,type,related,interaction_id,period_day,period_week,period_month,created_at)
                VALUES(?,?,?,?,?,0,'monthly-reset',?,NULL,?,?,?,?)`);
            for (const member of members) {
                insert.run(crypto.randomUUID(), guildId, member.user_id, -member.balance, member.balance, lastMonth, periods.day, periods.week, periods.month, now);
            }
            this.db.prepare('UPDATE economy_members SET balance=0,updated_at=? WHERE guild_id=?').run(now, guildId);
            this.db.prepare("UPDATE poker_games SET status='cancelled',completed_at=? WHERE guild_id=? AND status='active'").run(now, guildId);
            this.db.prepare("UPDATE blackjack_games SET status='cancelled',completed_at=? WHERE guild_id=? AND status='active'").run(now, guildId);
            this.db.prepare("UPDATE higher_lower_games SET status='cancelled',completed_at=? WHERE guild_id=? AND status='active'").run(now, guildId);
            this.db.prepare("UPDATE dragon_tower_games SET status='cancelled',completed_at=? WHERE guild_id=? AND status='active'").run(now, guildId);
            this.db.prepare("UPDATE duels SET status='cancelled',completed_at=? WHERE guild_id=? AND status='pending'").run(now, guildId);
            this.db.prepare("UPDATE heist_rounds SET status='cancelled',completed_at=? WHERE guild_id=? AND status='signup'").run(now, guildId);
            this.setSetting(guildId, 'active_month', currentMonth);
            return result;
        });
    }

    stats(guildId) {
        const totals = this.db.prepare(`SELECT COUNT(*) AS members,COALESCE(SUM(balance),0) AS circulation,
            COALESCE(MAX(balance),0) AS richest,COALESCE(SUM(lifetime_wagered),0) AS wagered,
            COALESCE(SUM(lifetime_won),0) AS won FROM economy_members WHERE guild_id=?`).get(guildId);
        const transactions = this.db.prepare('SELECT COUNT(*) AS total FROM economy_transactions WHERE guild_id=?').get(guildId).total;
        const activePoker = this.db.prepare("SELECT COUNT(*) AS total FROM poker_games WHERE guild_id=? AND status='active'").get(guildId).total;
        const activeBlackjack = this.db.prepare("SELECT COUNT(*) AS total FROM blackjack_games WHERE guild_id=? AND status='active'").get(guildId).total;
        const activeHigherLower = this.db.prepare("SELECT COUNT(*) AS total FROM higher_lower_games WHERE guild_id=? AND status='active'").get(guildId).total;
        const activeDragonTower = this.db.prepare("SELECT COUNT(*) AS total FROM dragon_tower_games WHERE guild_id=? AND status='active'").get(guildId).total;
        const pendingDuels = this.db.prepare("SELECT COUNT(*) AS total FROM duels WHERE guild_id=? AND status='pending'").get(guildId).total;
        return { ...totals, transactions, activePoker, activeBlackjack, activeHigherLower, activeDragonTower, pendingDuels, database: this.dbPath, currencyName: this.config.currencyName };
    }

    resetBeta(guildId, now = Date.now()) {
        return this.transaction(() => {
            const before = this.stats(guildId);
            const heistRounds = this.db.prepare('SELECT COUNT(*) AS total FROM heist_rounds WHERE guild_id=?').get(guildId).total;
            this.db.prepare('DELETE FROM heist_entries WHERE guild_id=?').run(guildId);
            this.db.prepare('DELETE FROM heist_rounds WHERE guild_id=?').run(guildId);
            this.db.prepare('DELETE FROM duels WHERE guild_id=?').run(guildId);
            this.db.prepare('DELETE FROM dragon_tower_games WHERE guild_id=?').run(guildId);
            this.db.prepare('DELETE FROM higher_lower_games WHERE guild_id=?').run(guildId);
            this.db.prepare('DELETE FROM blackjack_games WHERE guild_id=?').run(guildId);
            this.db.prepare('DELETE FROM poker_games WHERE guild_id=?').run(guildId);
            this.db.prepare('DELETE FROM economy_media WHERE guild_id=?').run(guildId);
            this.db.prepare('DELETE FROM economy_messages WHERE guild_id=?').run(guildId);
            this.db.prepare('DELETE FROM economy_transactions WHERE guild_id=?').run(guildId);
            this.db.prepare('DELETE FROM economy_members WHERE guild_id=?').run(guildId);
            this.db.prepare(`DELETE FROM economy_settings WHERE guild_id=?
                AND setting_key NOT IN ('leaderboard_panel_message','heist_panel_message')
                AND setting_key NOT LIKE 'rep_%'`).run(guildId);
            this.setSetting(guildId, 'active_month', periodKeys(now, this.config).month);
            return {
                membersCleared: before.members,
                transactionsCleared: before.transactions,
                pokerGamesCleared: before.activePoker,
                blackjackGamesCleared: before.activeBlackjack,
                higherLowerGamesCleared: before.activeHigherLower,
                dragonTowerGamesCleared: before.activeDragonTower,
                duelsCleared: before.pendingDuels,
                heistRoundsCleared: heistRounds,
                circulationCleared: before.circulation,
            };
        });
    }

    audit(guildId, userId, limit = 20) {
        return this.db.prepare('SELECT * FROM economy_transactions WHERE guild_id=? AND user_id=? ORDER BY created_at DESC LIMIT ?')
            .all(guildId, userId, limit);
    }

    admin(guildId, action, userId, amount, interactionId, now = Date.now()) {
        return this.transaction(() => {
            const row = this.ensureMember(guildId, userId, now);
            if (['freeze','unfreeze'].includes(action)) {
                this.db.prepare('UPDATE economy_members SET frozen=?,updated_at=? WHERE guild_id=? AND user_id=?')
                    .run(action === 'freeze' ? 1 : 0, now, guildId, userId);
                return this.publicMember(guildId, userId);
            }
            if (action === 'reset-daily') {
                this.db.prepare(`UPDATE economy_members SET daily_key='',daily_wagered=0,daily_gambling_limit=0,
                    daily_blackjack_wagered=0,daily_poker_wagered=0,
                    daily_text_earned=0,daily_media_earned=0,daily_media_posts=0,daily_voice_earned=0,daily_transfers_sent=0
                    WHERE guild_id=? AND user_id=?`).run(guildId, userId);
                return this.publicMember(guildId, userId);
            }
            if (action === 'reset-user') {
                if (row.balance > 0) {
                    const periods = periodKeys(now, this.config);
                    this.db.prepare(`INSERT INTO economy_transactions
                        (id,guild_id,user_id,amount,balance_before,balance_after,type,related,interaction_id,period_day,period_week,period_month,created_at)
                        VALUES(?,?,?,?,?,0,'admin-balance-reset','slash-command',?,?,?,?,?)`)
                        .run(crypto.randomUUID(), guildId, userId, -row.balance, row.balance, interactionId || null, periods.day, periods.week, periods.month, now);
                    this.db.prepare('UPDATE economy_members SET balance=0,updated_at=? WHERE guild_id=? AND user_id=?').run(now, guildId, userId);
                }
                return this.publicMember(guildId, userId);
            }
            const value = boundedInt(amount, 0, 0);
            if (action === 'set') {
                const delta = value - row.balance;
                this.applyDelta(guildId, userId, delta, 'admin-set', String(value), interactionId, now);
            } else if (action === 'add') {
                this.applyDelta(guildId, userId, value, 'admin-add', '', interactionId, now);
            } else if (action === 'remove') {
                this.applyDelta(guildId, userId, -Math.min(value, row.balance), 'admin-remove', '', interactionId, now);
            } else throw new Error('Unknown economy administration action.');
            return this.publicMember(guildId, userId);
        });
    }
}

module.exports = {
    EconomyService,
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
    diceExpectedReturn,
    diceHouseEdge,
    diceOutcome,
    eligibleDiceTable,
    higherLowerSuccessProbability,
    randomizedPayout,
    normalizeMessage,
    similarity,
    rankFor,
    repMonthKey,
    blackjackHand,
    blackjackPayout,
};

const { installEconomyLuck } = require('./economy/luck');
const { installSlots } = require('./economy/slots');
installEconomyLuck(EconomyService, module.exports);
installSlots(EconomyService);
