'use strict';

const Discord = require('discord.js');
const economyModule = require('./economy');
const discordViews = require('./economy/discord_views');
const {
    HIGHER_LOWER_MULTIPLIERS,
    higherLowerSuccessProbability,
} = require('./economy/core');

const REIMBURSEMENT_GUILD_ID = '1532503754350264571';
const REIMBURSEMENT_USER_ID = '1262823372270735466';
const REIMBURSEMENT_AMOUNT = 1_000_000;
const REIMBURSEMENT_KEY = 'reimbursement:hilo-tie:1262823372270735466:1000000';

function money(value) {
    return Number(value || 0).toLocaleString('en-US');
}

function cardRank(card) {
    return String(card || '').slice(0, -1);
}

function installHigherLowerTiePatch() {
    const EconomyService = economyModule.EconomyService;

    const previousInitialize = EconomyService.prototype.initialize;
    EconomyService.prototype.initialize = function initializeWithTieReimbursement(...args) {
        const result = previousInitialize.apply(this, args);
        try {
            if (this.setting(REIMBURSEMENT_GUILD_ID, REIMBURSEMENT_KEY) !== 'complete') {
                const now = Date.now();
                this.ensureMember(REIMBURSEMENT_GUILD_ID, REIMBURSEMENT_USER_ID, now);
                this.applyDelta(
                    REIMBURSEMENT_GUILD_ID,
                    REIMBURSEMENT_USER_ID,
                    REIMBURSEMENT_AMOUNT,
                    'admin-reimbursement',
                    'Higher / Lower tie reimbursement',
                    `reimbursement:${REIMBURSEMENT_USER_ID}:hilo-tie`,
                    now,
                );
                this.setSetting(REIMBURSEMENT_GUILD_ID, REIMBURSEMENT_KEY, 'complete');
            }
        } catch (error) {
            console.error('Higher / Lower reimbursement failed:', error.message);
        }
        return result;
    };

    EconomyService.prototype.playHigherLower = function playHigherLowerTieNeutral(gameId, userId, direction, now = Date.now()) {
        return this.transaction(() => {
            const game = this.higherLowerGame(gameId);
            if (!game || game.status !== 'active') throw new Error('This Higher / Lower game is no longer active.');
            if (game.user_id !== userId) throw new Error('This is not your Higher / Lower game.');
            if (!['higher', 'lower'].includes(direction)) throw new Error('Choose Higher or Lower.');

            const successChance = higherLowerSuccessProbability(game.step);
            let success = this.random() < successChance;
            let luckyRetry = false;
            if (!success && this.luckProc?.(game.guild_id, userId, now)) {
                luckyRetry = true;
                success = this.random() < successChance;
            }

            const revealedCard = this.higherLowerReveal(game.current_card, direction, success);
            const tie = cardRank(revealedCard) === cardRank(game.current_card);
            const historyEntry = {
                reference: game.current_card,
                direction,
                revealed: revealedCard,
                success: success && !tie,
                tie,
            };
            const history = [...game.history, historyEntry];

            if (tie) {
                this.db.prepare(`UPDATE higher_lower_games SET current_card=?,history=?,updated_at=?
                    WHERE game_id=? AND status='active'`)
                    .run(revealedCard, JSON.stringify(history), now, gameId);
                const updated = this.higherLowerGame(gameId);
                const currentMultiplier = updated.step > 0 ? HIGHER_LOWER_MULTIPLIERS[updated.step - 1] : 0;
                return {
                    ...updated,
                    revealedCard,
                    success: false,
                    tie: true,
                    luckyRetry,
                    multiplier: currentMultiplier,
                    nextMultiplier: HIGHER_LOWER_MULTIPLIERS[updated.step],
                    nextSuccessChance: higherLowerSuccessProbability(updated.step) * 100,
                    balance: this.member(game.guild_id, userId).balance,
                };
            }

            if (!success) {
                this.db.prepare(`UPDATE higher_lower_games SET history=?,status='lost',completed_at=?,updated_at=?
                    WHERE game_id=? AND status='active'`).run(JSON.stringify(history), now, now, gameId);
                this.db.prepare(`UPDATE economy_members SET lifetime_lost=lifetime_lost+?,gambling_losses=gambling_losses+1
                    WHERE guild_id=? AND user_id=?`).run(game.wager, game.guild_id, game.user_id);
                return {
                    ...this.higherLowerGame(gameId),
                    revealedCard,
                    success: false,
                    tie: false,
                    luckyRetry,
                    multiplier: 0,
                    balance: this.member(game.guild_id, userId).balance,
                };
            }

            const step = game.step + 1;
            const currentCard = this.higherLowerReferenceCard();
            this.db.prepare(`UPDATE higher_lower_games SET current_card=?,step=?,history=?,updated_at=?
                WHERE game_id=? AND status='active'`)
                .run(currentCard, step, JSON.stringify(history), now, gameId);
            const updated = this.higherLowerGame(gameId);
            if (step === HIGHER_LOWER_MULTIPLIERS.length) {
                return { ...this.finishHigherLower(updated, now, 'completed'), revealedCard, success: true, tie: false, luckyRetry };
            }
            return {
                ...updated,
                revealedCard,
                success: true,
                tie: false,
                luckyRetry,
                multiplier: HIGHER_LOWER_MULTIPLIERS[step - 1],
                nextMultiplier: HIGHER_LOWER_MULTIPLIERS[step],
                nextSuccessChance: higherLowerSuccessProbability(step) * 100,
                balance: this.member(game.guild_id, userId).balance,
            };
        });
    };

    discordViews.higherLowerPayload = function higherLowerPayload(game, userMention, currencyName, note = '') {
        const active = game.status === 'active';
        const currentMultiplier = game.step > 0 ? HIGHER_LOWER_MULTIPLIERS[game.step - 1] : 0;
        const nextMultiplier = active ? HIGHER_LOWER_MULTIPLIERS[game.step] : null;
        const last = game.history?.at(-1);
        const description = active
            ? `${userMention}, is the hidden card **Higher** or **Lower** than **${game.current_card}**?${last?.tie
                ? `\n\n🟨 **FREE CARD:** ${last.reference} → ${last.revealed} was a tie. Your multiplier did not change and your wager is still alive.`
                : last?.success
                    ? `\n\n✅ ${last.reference} → ${last.revealed} was correct.`
                    : ''}`
            : game.status === 'lost'
                ? `${userMention} guessed **${last?.direction || 'incorrectly'}**: ${last?.reference || '?'} → ${last?.revealed || '?'}. The wager was lost.`
                : `${userMention} cashed out the card ladder${game.status === 'completed' ? ' at the 25× summit' : ''}.`;
        const fields = [
            { name: 'Wager', value: `${money(game.wager)} ${currencyName}`, inline: true },
            { name: 'Correct cards', value: String(game.step), inline: true },
        ];
        if (active) fields.push(
            { name: 'Current cash-out', value: game.step ? `${currentMultiplier}×` : 'Locked', inline: true },
            { name: 'Next win', value: `${nextMultiplier}× · ${(higherLowerSuccessProbability(game.step) * 100).toFixed(2)}%`, inline: true },
        );
        else fields.push(
            { name: 'Payout', value: `${money(game.payout)} ${currencyName}`, inline: true },
            { name: 'Balance', value: `${money(game.balance)} ${currencyName}`, inline: true },
        );
        const components = active ? [new Discord.ActionRowBuilder().addComponents(
            new Discord.ButtonBuilder().setCustomId(`econ:hilo:${game.game_id}:higher`).setLabel('Higher').setEmoji('⬆️').setStyle(Discord.ButtonStyle.Success),
            new Discord.ButtonBuilder().setCustomId(`econ:hilo:${game.game_id}:lower`).setLabel('Lower').setEmoji('⬇️').setStyle(Discord.ButtonStyle.Danger),
            new Discord.ButtonBuilder().setCustomId(`econ:hilo:${game.game_id}:cash`).setLabel(game.step ? `Cash Out ${currentMultiplier}×` : 'Cash Out').setEmoji('💰').setStyle(Discord.ButtonStyle.Primary).setDisabled(game.step < 1),
        )] : [];
        return {
            embeds: [new Discord.EmbedBuilder().setColor(active ? 0x7c3aed : game.status === 'lost' ? 0x9b1c31 : 0x2ea043)
                .setTitle('🃏 Higher / Lower Cards').setDescription(`${description}${note ? `\n\n*${note}*` : ''}`).addFields(fields)
                .setFooter({ text: 'Ties are free cards · multiplier stays the same · inactivity cashes out earned progress' }).setTimestamp()],
            components,
        };
    };
}

module.exports = { installHigherLowerTiePatch };
