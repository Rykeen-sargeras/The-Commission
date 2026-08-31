'use strict';

const crypto = require('crypto');

const PERSONAL_LUCK_ITEMS = Object.freeze({
    'luck-1': Object.freeze({ key: 'luck-1', name: 'Lucky Break', percent: 1, cost: 5000 }),
    'luck-5': Object.freeze({ key: 'luck-5', name: 'Made Luck', percent: 5, cost: 30000 }),
    'luck-10': Object.freeze({ key: 'luck-10', name: 'Boss Luck', percent: 10, cost: 250000 }),
});
const GLOBAL_LUCK_COST = 1000;
const GLOBAL_LUCK_PERCENT = 0.5;
const GLOBAL_LUCK_DURATION_MS = 24 * 60 * 60 * 1000;
let economyApi = null;

function boundedInt(value, fallback, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(minimum, Math.min(maximum, parsed));
}

function money(value) {
    return Number(value || 0).toLocaleString('en-US');
}

function blackjackOpeningScore(cards) {
    const hand = economyApi.blackjackHand(cards);
    if (hand.blackjack) return 1000;
    return hand.total;
}

function pokerOpeningScore(service, cards) {
    const result = service.evaluatePoker(cards);
    const rankValues = cards.map(card => {
        const rank = card.slice(0, -1);
        return ({ J: 11, Q: 12, K: 13, A: 14 }[rank] || Number(rank));
    });
    return (Number(result.multiplier || 0) * 1000) + rankValues.reduce((sum, value) => sum + value, 0);
}

// 1–3000 is the common pool and every number inside it is equally likely.
// Above 3000, progressively higher bands become sharply rarer.
const DAILY_TIERS = Object.freeze([
    Object.freeze({ min: 1, max: 3000, weight: 850000 }),
    Object.freeze({ min: 3001, max: 5000, weight: 100000 }),
    Object.freeze({ min: 5001, max: 7000, weight: 35000 }),
    Object.freeze({ min: 7001, max: 9000, weight: 12000 }),
    Object.freeze({ min: 9001, max: 9900, weight: 2500 }),
    Object.freeze({ min: 9901, max: 9999, weight: 450 }),
    Object.freeze({ min: 10000, max: 10000, weight: 50 }),
]);
const DAILY_WEIGHT_TOTAL = DAILY_TIERS.reduce((sum, tier) => sum + tier.weight, 0);

function dailyRoll(random = Math.random) {
    let pick = Math.floor(random() * DAILY_WEIGHT_TOTAL);
    for (const tier of DAILY_TIERS) {
        if (pick < tier.weight) {
            return tier.min + Math.floor(random() * (tier.max - tier.min + 1));
        }
        pick -= tier.weight;
    }
    return 1;
}

function installEconomyLuck(EconomyService, economyModule) {
economyApi = economyModule;
const originalInitialize = EconomyService.prototype.initialize;
EconomyService.prototype.initialize = function initializeLuckStore() {
    originalInitialize.call(this);
    this.db.exec(`
        CREATE TABLE IF NOT EXISTS luck_purchases (
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            item_key TEXT NOT NULL,
            luck_percent REAL NOT NULL,
            cost INTEGER NOT NULL,
            purchased_at INTEGER NOT NULL,
            PRIMARY KEY (guild_id, user_id, item_key)
        );
        CREATE TABLE IF NOT EXISTS global_luck_contributions (
            contribution_id TEXT PRIMARY KEY,
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            luck_percent REAL NOT NULL,
            cost INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS global_luck_active
            ON global_luck_contributions(guild_id, expires_at);
        CREATE INDEX IF NOT EXISTS global_luck_user
            ON global_luck_contributions(guild_id, user_id, created_at DESC);
    `);

    // Retire the heist cleanly. Existing paid signup entries are refunded once,
    // active rounds are cancelled, and the old panel channel is disabled.
    this.retiredHeistChannelId = this.config.heistChannelId || '';
    try {
        const activeRounds = this.db.prepare("SELECT round_id,guild_id FROM heist_rounds WHERE status='signup'").all();
        for (const round of activeRounds) {
            const entries = this.db.prepare('SELECT user_id,entry_fee FROM heist_entries WHERE round_id=?').all(round.round_id);
            for (const entry of entries) {
                if (entry.entry_fee > 0) {
                    const alreadyRefunded = this.db.prepare("SELECT 1 FROM economy_transactions WHERE guild_id=? AND user_id=? AND type='heist-refund' AND related=? LIMIT 1")
                        .get(round.guild_id, entry.user_id, round.round_id);
                    if (!alreadyRefunded) this.applyDelta(round.guild_id, entry.user_id, entry.entry_fee, 'heist-refund', round.round_id, null, Date.now());
                }
            }
            this.db.prepare("UPDATE heist_rounds SET status='cancelled',success=0,completed_at=? WHERE round_id=? AND status='signup'")
                .run(Date.now(), round.round_id);
        }
    } catch (error) {
        console.error('Heist retirement cleanup failed:', error.message);
    }
    this.config.heistChannelId = '';
};

EconomyService.prototype.cleanupExpiredLuck = function cleanupExpiredLuck(now = Date.now()) {
    this.db.prepare('DELETE FROM global_luck_contributions WHERE expires_at<=?').run(now);
};

EconomyService.prototype.personalLuckPercent = function personalLuckPercent(guildId, userId) {
    const row = this.db.prepare('SELECT COALESCE(SUM(luck_percent),0) AS total FROM luck_purchases WHERE guild_id=? AND user_id=?')
        .get(guildId, userId);
    return Number(row?.total || 0);
};

EconomyService.prototype.globalLuckPercent = function globalLuckPercent(guildId, now = Date.now()) {
    this.cleanupExpiredLuck(now);
    const row = this.db.prepare('SELECT COALESCE(SUM(luck_percent),0) AS total FROM global_luck_contributions WHERE guild_id=? AND expires_at>?')
        .get(guildId, now);
    return Number(row?.total || 0);
};

EconomyService.prototype.totalLuckPercent = function totalLuckPercent(guildId, userId, now = Date.now()) {
    return this.personalLuckPercent(guildId, userId) + this.globalLuckPercent(guildId, now);
};

EconomyService.prototype.luckProc = function luckProc(guildId, userId, now = Date.now()) {
    const percent = this.totalLuckPercent(guildId, userId, now);
    if (percent <= 0) return false;
    const roll = crypto.randomInt(0, 1_000_000) / 10_000;
    return roll < Math.min(100, percent);
};

EconomyService.prototype.luckShopStatus = function luckShopStatus(guildId, userId, now = Date.now()) {
    this.ensureMember(guildId, userId, now);
    this.cleanupExpiredLuck(now);
    const purchases = this.db.prepare('SELECT item_key,luck_percent,cost,purchased_at FROM luck_purchases WHERE guild_id=? AND user_id=? ORDER BY purchased_at')
        .all(guildId, userId);
    const global = this.db.prepare('SELECT contribution_id,user_id,luck_percent,created_at,expires_at FROM global_luck_contributions WHERE guild_id=? AND expires_at>? ORDER BY expires_at')
        .all(guildId, now);
    const mine = global.find(row => row.user_id === userId) || null;
    const personalLuck = purchases.reduce((sum, row) => sum + Number(row.luck_percent || 0), 0);
    const globalLuck = global.reduce((sum, row) => sum + Number(row.luck_percent || 0), 0);
    return {
        purchases,
        personalLuck,
        globalLuck,
        totalLuck: personalLuck + globalLuck,
        activeGlobalContributions: global.length,
        canContributeGlobal: !mine,
        nextGlobalAt: mine?.expires_at || 0,
        balance: this.member(guildId, userId).balance,
    };
};

EconomyService.prototype.buyLuckItem = function buyLuckItem(guildId, userId, itemKey, interactionId, now = Date.now()) {
    const item = PERSONAL_LUCK_ITEMS[itemKey];
    if (!item) throw new Error('Unknown luck-shop item.');
    return this.transaction(() => {
        const member = this.ensureMember(guildId, userId, now);
        this.assertUsable(member);
        if (this.db.prepare('SELECT 1 FROM luck_purchases WHERE guild_id=? AND user_id=? AND item_key=?').get(guildId, userId, item.key)) {
            throw new Error(`${item.name} is a one-time purchase and you already own it.`);
        }
        if (member.balance < item.cost) throw new Error(`You need ${money(item.cost)} ${this.config.currencyName} for ${item.name}.`);
        const balance = this.applyDelta(guildId, userId, -item.cost, 'luck-shop-purchase', item.key, interactionId, now);
        this.db.prepare('INSERT INTO luck_purchases(guild_id,user_id,item_key,luck_percent,cost,purchased_at) VALUES(?,?,?,?,?,?)')
            .run(guildId, userId, item.key, item.percent, item.cost, now);
        return { item, balance, ...this.luckShopStatus(guildId, userId, now) };
    });
};

EconomyService.prototype.contributeGlobalLuck = function contributeGlobalLuck(guildId, userId, interactionId, now = Date.now()) {
    return this.transaction(() => {
        const member = this.ensureMember(guildId, userId, now);
        this.assertUsable(member);
        this.cleanupExpiredLuck(now);
        const active = this.db.prepare('SELECT expires_at FROM global_luck_contributions WHERE guild_id=? AND user_id=? AND expires_at>? ORDER BY expires_at DESC LIMIT 1')
            .get(guildId, userId, now);
        if (active) throw new Error(`You already added to the community luck pot. You can contribute again <t:${Math.floor(active.expires_at / 1000)}:R>.`);
        if (member.balance < GLOBAL_LUCK_COST) throw new Error(`You need ${money(GLOBAL_LUCK_COST)} ${this.config.currencyName} to boost global luck.`);
        const balance = this.applyDelta(guildId, userId, -GLOBAL_LUCK_COST, 'global-luck-contribution', '+0.5%', interactionId, now);
        const expiresAt = now + GLOBAL_LUCK_DURATION_MS;
        this.db.prepare('INSERT INTO global_luck_contributions(contribution_id,guild_id,user_id,luck_percent,cost,created_at,expires_at) VALUES(?,?,?,?,?,?,?)')
            .run(crypto.randomUUID(), guildId, userId, GLOBAL_LUCK_PERCENT, GLOBAL_LUCK_COST, now, expiresAt);
        return { added: GLOBAL_LUCK_PERCENT, expiresAt, balance, ...this.luckShopStatus(guildId, userId, now) };
    });
};

EconomyService.prototype.claimDaily = function claimDailyRng(guildId, userId, interactionId, now = Date.now()) {
    return this.transaction(() => {
        const row = this.ensureMember(guildId, userId, now);
        this.assertUsable(row);
        if (this.hasInteraction(guildId, interactionId)) return { duplicate: true, balance: row.balance };
        const elapsed = now - row.last_daily_claim;
        if (row.last_daily_claim && elapsed < 24 * 60 * 60 * 1000) return { cooldown: (24 * 60 * 60 * 1000) - elapsed };

        const streak = row.last_daily_claim && elapsed < 48 * 60 * 60 * 1000 ? row.daily_streak + 1 : 1;
        const cappedStreak = Math.min(streak, 7);
        const streakBonus = cappedStreak * 100;
        const firstRoll = dailyRoll(this.random);
        let rngReward = firstRoll;
        let luckyReroll = false;
        let secondRoll = null;
        if (this.luckProc(guildId, userId, now)) {
            secondRoll = dailyRoll(this.random);
            rngReward = Math.max(firstRoll, secondRoll);
            luckyReroll = true;
        }
        const reward = rngReward + streakBonus;
        const balance = this.applyDelta(guildId, userId, reward, 'daily', `rng:${rngReward};streak:${cappedStreak}`, interactionId, now);
        this.db.prepare('UPDATE economy_members SET last_daily_claim=?,daily_streak=? WHERE guild_id=? AND user_id=?')
            .run(now, streak, guildId, userId);
        return { reward, rngReward, streak, cappedStreak, streakBonus, luckyReroll, firstRoll, secondRoll, balance, luck: this.totalLuckPercent(guildId, userId, now) };
    });
};

// Retired heist API. Old buttons/panels cannot create or join new rounds.
EconomyService.prototype.heistState = function retiredHeistState() { return null; };
EconomyService.prototype.createHeistRound = function retiredHeistCreate() { throw new Error('Heists have been retired and replaced by the Luck Shop.'); };
EconomyService.prototype.joinHeist = function retiredHeistJoin() { throw new Error('Heists have been retired and replaced by the Luck Shop.'); };
EconomyService.prototype.resolveHeist = function retiredHeistResolve() { return null; };

// Luck-aware dice: if the first roll is a total loss and luck procs, reroll once and keep the better outcome.
const previousDice = EconomyService.prototype.dice;
EconomyService.prototype.dice = function diceWithLuck(guildId, userId, wager, interactionId, now = Date.now()) {
    const originalRandom = this.random;
    let firstOutcome = null;
    let rerollOutcome = null;
    const table = economyModule.DICE_PAYOUT_TABLE;
    const weightTotal = economyModule.DICE_WEIGHT_TOTAL || 10000;
    const outcomeFor = randomValue => {
        const roll = Math.min(weightTotal - 1, Math.max(0, Math.floor(Number(randomValue) * weightTotal)));
        let threshold = 0;
        for (const outcome of table) {
            threshold += outcome.weight;
            if (roll < threshold) return { ...outcome, probabilityPercent: outcome.weight / 100, roll };
        }
        return table[0];
    };
    try {
        this.random = () => {
            const raw = originalRandom();
            if (!firstOutcome) {
                firstOutcome = outcomeFor(raw);
                if (firstOutcome.multiplier === 0 && this.luckProc(guildId, userId, now)) {
                    const secondRaw = originalRandom();
                    rerollOutcome = outcomeFor(secondRaw);
                    const chosen = Number(rerollOutcome.multiplier) > Number(firstOutcome.multiplier) ? rerollOutcome : firstOutcome;
                    return Math.min(0.999999999, (chosen.roll + 0.5) / weightTotal);
                }
            }
            return raw;
        };
        const result = previousDice.call(this, guildId, userId, wager, interactionId, now);
        return { ...result, luck: this.totalLuckPercent(guildId, userId, now), luckyReroll: Boolean(rerollOutcome), rerollOutcome: rerollOutcome?.name || '' };
    } finally {
        this.random = originalRandom;
    }
};

// Luck-aware Higher / Lower: a failed card gets one second chance when luck procs.
const originalPlayHigherLower = EconomyService.prototype.playHigherLower;
EconomyService.prototype.playHigherLower = function playHigherLowerWithLuck(gameId, userId, direction, now = Date.now()) {
    const game = this.higherLowerGame(gameId);
    if (!game) return originalPlayHigherLower.call(this, gameId, userId, direction, now);
    const originalRandom = this.random;
    let calls = 0;
    let luckyRetry = false;
    try {
        this.random = () => {
            const raw = originalRandom();
            calls += 1;
            if (calls === 1) {
                const baseChance = economyModule.higherLowerSuccessProbability(game.step);
                if (raw >= baseChance && this.luckProc(game.guild_id, userId, now)) {
                    luckyRetry = true;
                    return originalRandom();
                }
            }
            return raw;
        };
        const result = originalPlayHigherLower.call(this, gameId, userId, direction, now);
        return { ...result, luckyRetry, luck: this.totalLuckPercent(game.guild_id, userId, now) };
    } finally {
        this.random = originalRandom;
    }
};

// Luck-aware Dragon Tower: a trap can be dodged once by a successful luck proc.
const originalPickDragonTower = EconomyService.prototype.pickDragonTower;
EconomyService.prototype.pickDragonTower = function pickDragonTowerWithLuck(gameId, userId, column, now = Date.now()) {
    const game = this.dragonTowerGame(gameId);
    if (!game || game.status !== 'active' || game.user_id !== userId) return originalPickDragonTower.call(this, gameId, userId, column, now);
    const selected = boundedInt(column, -1, -1, 3);
    const traps = game.trapPositions[game.row_number] || [];
    if (selected >= 0 && traps.includes(selected) && this.luckProc(game.guild_id, userId, now)) {
        const safe = [0, 1, 2, 3].filter(value => !traps.includes(value));
        const replacement = safe[Math.floor(this.random() * safe.length)];
        const result = originalPickDragonTower.call(this, gameId, userId, replacement, now);
        return { ...result, luckySave: true, originalSelection: selected, selected: replacement, luck: this.totalLuckPercent(game.guild_id, userId, now) };
    }
    const result = originalPickDragonTower.call(this, gameId, userId, selected, now);
    return { ...result, luckySave: false, luck: this.totalLuckPercent(game.guild_id, userId, now) };
};

// Luck-aware opening hands for poker and blackjack. A luck proc gives a second shuffled opening
// and the player keeps the stronger starting hand; otherwise gameplay remains unchanged.
const priorStartPoker = EconomyService.prototype.startPoker;
EconomyService.prototype.startPoker = function startPokerWithLuck(guildId, userId, wager, interactionId, now = Date.now()) {
    if (!this.luckProc(guildId, userId, now)) return priorStartPoker.call(this, guildId, userId, wager, interactionId, now);
    const originalCreateDeck = this.createDeck;
    let used = false;
    try {
        this.createDeck = count => {
            if (used) return originalCreateDeck.call(this, count);
            used = true;
            const a = originalCreateDeck.call(this, count);
            const b = originalCreateDeck.call(this, count);
            const handA = a.slice(0, 5);
            const handB = b.slice(0, 5);
            return pokerOpeningScore(this, handB) > pokerOpeningScore(this, handA) ? b : a;
        };
        const result = priorStartPoker.call(this, guildId, userId, wager, interactionId, now);
        return { ...result, luckyOpening: true, luck: this.totalLuckPercent(guildId, userId, now) };
    } finally {
        this.createDeck = originalCreateDeck;
    }
};

const priorStartBlackjack = EconomyService.prototype.startBlackjack;
EconomyService.prototype.startBlackjack = function startBlackjackWithLuck(guildId, userId, wager, interactionId, now = Date.now()) {
    if (!this.luckProc(guildId, userId, now)) return priorStartBlackjack.call(this, guildId, userId, wager, interactionId, now);
    const originalCreateDeck = this.createDeck;
    let used = false;
    try {
        this.createDeck = count => {
            if (used) return originalCreateDeck.call(this, count);
            used = true;
            const a = originalCreateDeck.call(this, count);
            const b = originalCreateDeck.call(this, count);
            const scoreA = blackjackOpeningScore(a.slice(0, 2));
            const scoreB = blackjackOpeningScore(b.slice(0, 2));
            return scoreB > scoreA ? b : a;
        };
        const result = priorStartBlackjack.call(this, guildId, userId, wager, interactionId, now);
        return { ...result, luckyOpening: true, luck: this.totalLuckPercent(guildId, userId, now) };
    } finally {
        this.createDeck = originalCreateDeck;
    }
};

}

function installLuckCommands(discordEconomy, Discord) {
const originalCommandData = discordEconomy.economyCommandData;
discordEconomy.economyCommandData = function luckShopCommandData() {
    const commands = originalCommandData().filter(command => command.name !== 'heist');
    commands.push(new Discord.SlashCommandBuilder()
        .setName('luck-shop')
        .setDescription('View or buy permanent and community luck boosts')
        .addStringOption(option => option.setName('action').setDescription('Luck Shop action').setRequired(false).addChoices(
            { name: 'View shop / my luck', value: 'view' },
            { name: 'Buy +1% personal luck — 5,000', value: 'luck-1' },
            { name: 'Buy +5% personal luck — 30,000', value: 'luck-5' },
            { name: 'Buy +10% personal luck — 250,000', value: 'luck-10' },
            { name: 'Add +0.5% global luck for 24h — 1,000', value: 'global' },
        )).toJSON());
    return commands;
};

const originalCreateIntegration = discordEconomy.createEconomyIntegration;
discordEconomy.createEconomyIntegration = function createLuckShopIntegration(client, economy, options = {}) {
    const integration = originalCreateIntegration(client, economy, options);
    const originalHandleCommand = integration.handleCommand;
    const originalHandleButton = integration.handleButton;

    integration.handleCommand = async interaction => {
        if (!interaction.isChatInputCommand() || interaction.commandName !== 'luck-shop') return originalHandleCommand(interaction);
        try {
            const action = interaction.options.getString('action') || 'view';
            let result;
            let headline = '🍀 The Commission Luck Shop';
            if (action === 'global') {
                result = economy.contributeGlobalLuck(interaction.guild.id, interaction.user.id, interaction.id);
                headline = '🍀 Community Luck Increased';
            } else if (PERSONAL_LUCK_ITEMS[action]) {
                result = economy.buyLuckItem(interaction.guild.id, interaction.user.id, action, interaction.id);
                headline = `🍀 Purchased ${result.item.name}`;
            } else result = economy.luckShopStatus(interaction.guild.id, interaction.user.id);

            const status = economy.luckShopStatus(interaction.guild.id, interaction.user.id);
            const owned = new Set(status.purchases.map(item => item.item_key));
            const itemLines = Object.values(PERSONAL_LUCK_ITEMS).map(item =>
                `${owned.has(item.key) ? '✅' : '🛒'} **${item.name}** — +${item.percent}% personal luck — ${money(item.cost)} ${economy.config.currencyName}${owned.has(item.key) ? ' · owned' : ''}`);
            const globalLine = status.canContributeGlobal
                ? `Available now: spend **${money(GLOBAL_LUCK_COST)}** for **+${GLOBAL_LUCK_PERCENT}% global luck** for 24 hours.`
                : `You already contributed. Your next contribution opens <t:${Math.floor(status.nextGlobalAt / 1000)}:R>.`;
            const extra = action === 'global'
                ? `\n\nYou added **+${GLOBAL_LUCK_PERCENT}%** global luck until <t:${Math.floor(result.expiresAt / 1000)}:R>.`
                : PERSONAL_LUCK_ITEMS[action]
                    ? `\n\nYour permanent personal luck increased by **+${result.item.percent}%**.`
                    : '';

            await interaction.reply({ embeds: [new Discord.EmbedBuilder().setColor(0x2ea043).setTitle(headline)
                .setDescription(`${itemLines.join('\n')}\n\n🌐 **Community Pot**\n${globalLine}${extra}`)
                .addFields(
                    { name: 'Personal luck', value: `+${status.personalLuck}%`, inline: true },
                    { name: 'Global luck', value: `+${status.globalLuck}%`, inline: true },
                    { name: 'Your total luck', value: `+${status.totalLuck}%`, inline: true },
                    { name: 'Active global boosts', value: String(status.activeGlobalContributions), inline: true },
                    { name: 'Balance', value: `${money(status.balance)} ${economy.config.currencyName}`, inline: true },
                )
                .setFooter({ text: 'Luck applies to house RNG and daily rolls. Global boosts stack and each expires 24 hours after purchase.' }).setTimestamp()] });
        } catch (error) {
            await interaction.reply({ content: `❌ ${error.message}`, ephemeral: true }).catch(() => {});
        }
        return true;
    };

    integration.handleButton = async interaction => {
        if (interaction.isButton() && interaction.customId.startsWith('econ:heist:')) {
            await interaction.reply({ content: '🍀 Heists have been retired. Use **/luck-shop** instead.', ephemeral: true }).catch(() => {});
            return true;
        }
        return originalHandleButton(interaction);
    };

    integration.updateHeistPanel = async () => null;
    integration.pushHeistPanel = async () => null;

    // Delete the old persistent heist panel after login, if one still exists.
    client.once('ready', async () => {
        const channelId = economy.retiredHeistChannelId;
        if (!channelId) return;
        for (const guild of client.guilds.cache.values()) {
            const messageId = economy.setting(guild.id, 'heist_panel_message');
            if (!messageId) continue;
            const channel = await guild.channels.fetch(channelId).catch(() => null);
            const message = channel?.isTextBased() ? await channel.messages.fetch(messageId).catch(() => null) : null;
            if (message) await message.delete().catch(() => {});
            economy.db.prepare("DELETE FROM economy_settings WHERE guild_id=? AND setting_key IN ('heist_panel_message','heist_last_announced_round')").run(guild.id);
        }
    });

    return integration;
};
}

module.exports = {
    PERSONAL_LUCK_ITEMS,
    GLOBAL_LUCK_COST,
    GLOBAL_LUCK_PERCENT,
    GLOBAL_LUCK_DURATION_MS,
    DAILY_TIERS,
    dailyRoll,
    installEconomyLuck,
    installLuckCommands,
};
