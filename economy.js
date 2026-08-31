const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const {
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
} = require('./economy/core');

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

const { installEconomyGames } = require('./economy/games');
installEconomyGames(EconomyService);

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
