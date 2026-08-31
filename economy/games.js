'use strict';

const crypto = require('node:crypto');
const {
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
    diceOutcome,
    eligibleDiceTable,
    gameCategory,
    boundedInt,
    randomInt,
    periodKeys,
    blackjackHand,
    blackjackCardValue,
    blackjackCanSplit,
    blackjackPayout,
} = require('./core');

class EconomyGames {

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
}

function installEconomyGames(EconomyService) {
    for (const name of Object.getOwnPropertyNames(EconomyGames.prototype)) {
        if (name === 'constructor') continue;
        Object.defineProperty(
            EconomyService.prototype,
            name,
            Object.getOwnPropertyDescriptor(EconomyGames.prototype, name),
        );
    }
}

module.exports = { installEconomyGames };

