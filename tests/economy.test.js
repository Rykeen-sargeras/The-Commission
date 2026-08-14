const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    EconomyService,
    DICE_WEIGHT_TOTAL,
    DICE_PAYOUT_TABLE,
    HOUSE_GAME_RTP,
    HIGHER_LOWER_MULTIPLIERS,
    DRAGON_TOWER_COLUMNS,
    DRAGON_TOWER_EGGS_PER_ROW,
    DRAGON_TOWER_MULTIPLIERS,
    diceExpectedReturn,
    diceHouseEdge,
    higherLowerSuccessProbability,
    similarity,
    rankFor,
    repMonthKey,
    blackjackHand,
    blackjackPayout,
} = require('../economy');
const { canAdministerEconomy } = require('../economy_discord');

const staffMember = {
    permissions: { has: () => false },
    roles: { cache: new Map([['staff-role', { id: 'staff-role' }]]) },
};
const regularMember = { permissions: { has: () => false }, roles: { cache: new Map() } };
const administrator = { permissions: { has: () => true }, roles: { cache: new Map() } };
assert.strictEqual(canAdministerEconomy(staffMember, 'add', ['staff-role']), true);
assert.strictEqual(canAdministerEconomy(staffMember, 'remove', ['staff-role']), true);
assert.strictEqual(canAdministerEconomy(staffMember, 'set', ['staff-role']), true);
assert.strictEqual(canAdministerEconomy(staffMember, 'reset-user', ['staff-role']), true);
assert.strictEqual(canAdministerEconomy(staffMember, 'enable-gambling', ['staff-role']), false);
assert.strictEqual(canAdministerEconomy(regularMember, 'add', ['staff-role']), false);
assert.strictEqual(canAdministerEconomy(administrator, 'enable-gambling', ['staff-role']), true);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'commission-economy-'));
const service = new EconomyService({
    dbPath: path.join(temp, 'economy.sqlite'),
    random: () => 0.995,
    config: {
        messageChance: 100,
        messageCooldownSeconds: 1,
        mediaChannelIds: '12345678901234567',
        heistBaseSuccessChance: 100,
        heistMaximumSuccessChance: 100,
        heistFreeSuccessReward: 100,
        blackjackMaximumWager: 1000,
        blackjackDailyCap: 10000,
        pokerMaximumWager: 1000,
        pokerDailyCap: 10000,
    },
});

try {
    assert(similarity('hello there friend', 'hello there friend!') >= 0.8);
    assert.strictEqual(rankFor(100000), 'Blood Baron');
    assert.deepStrictEqual(blackjackHand(['A♠', 'K♥']), { total: 21, soft: true, blackjack: true, bust: false });
    assert.strictEqual(blackjackHand(['A♠', '9♥', '8♦']).total, 18);
    assert.strictEqual(blackjackPayout(1000), 1950);
    assert.strictEqual(blackjackPayout(1000, true), 2425);
    assert.strictEqual(blackjackPayout(1200), 2340);
    assert.strictEqual(repMonthKey(Date.UTC(2026, 0, 1, 12, 59), 'America/New_York'), '2025-12');
    assert.strictEqual(repMonthKey(Date.UTC(2026, 0, 1, 13, 0), 'America/New_York'), '2026-01');
    assert.strictEqual(repMonthKey(Date.UTC(2026, 7, 1, 11, 59), 'America/New_York'), '2026-07');
    assert.strictEqual(repMonthKey(Date.UTC(2026, 7, 1, 12, 0), 'America/New_York'), '2026-08');
    assert.strictEqual(service.config.heistEntryMinutes, 58);
    assert.strictEqual(service.config.heistCooldownMinutes, 2);
    assert.deepStrictEqual(service.evaluatePoker(['10♠','10♥','3♦','6♣','9♠']), { name: 'Tens or Better', multiplier: 1.5 });
    assert.deepStrictEqual(service.evaluatePoker(['9♠','9♥','3♦','6♣','A♠']), { name: 'No winning hand', multiplier: 0 });
    assert.deepStrictEqual(service.evaluatePoker(['10♠','J♠','Q♠','K♠','A♠']), { name: 'Royal Flush', multiplier: 150 });
    assert.deepStrictEqual(service.evaluatePoker(['5♠','6♠','7♠','8♠','9♠']), { name: 'Straight Flush', multiplier: 75 });
    assert.deepStrictEqual(service.evaluatePoker(['K♠','K♥','K♦','K♣','2♠']), { name: 'Four of a Kind', multiplier: 25 });
    assert.deepStrictEqual(service.evaluatePoker(['Q♠','Q♥','Q♦','2♣','2♠']), { name: 'Full House', multiplier: 10 });
    assert.deepStrictEqual(service.evaluatePoker(['2♠','5♠','8♠','J♠','K♠']), { name: 'Flush', multiplier: 7 });
    assert.deepStrictEqual(service.evaluatePoker(['5♠','6♥','7♦','8♣','9♠']), { name: 'Straight', multiplier: 5 });

    const heistHour = Date.UTC(2026, 7, 1, 10, 0);
    const scheduledSignup = service.heistState('scheduled-heist-guild', heistHour + (23 * 60000));
    assert.strictEqual(scheduledSignup.phase, 'signup');
    assert.strictEqual(scheduledSignup.round.created_at, heistHour);
    assert.strictEqual(scheduledSignup.round.signup_ends_at, heistHour + (58 * 60000));
    const scheduledCooldown = service.heistState('scheduled-heist-guild', heistHour + (58 * 60000));
    assert.strictEqual(scheduledCooldown.phase, 'cooldown');
    assert.strictEqual(scheduledCooldown.nextAt, heistHour + (60 * 60000));
    const nextScheduledSignup = service.heistState('scheduled-heist-guild', heistHour + (60 * 60000));
    assert.strictEqual(nextScheduledSignup.phase, 'signup');
    assert.strictEqual(nextScheduledSignup.round.created_at, heistHour + (60 * 60000));

    const repStart = Date.UTC(2025, 11, 31, 20, 0);
    service.setSetting('rep-guild', 'rep_active_month', '2025-12');
    assert.strictEqual(service.rewardRepMessage('rep-guild', 'alice', repStart).reward, 1);
    assert.strictEqual(service.rewardRepMessage('rep-guild', 'alice', repStart + 119999), null);
    assert.strictEqual(service.rewardRepMessage('rep-guild', 'alice', repStart + 120000).points, 2);
    assert.strictEqual(service.rewardRepVoice('rep-guild', 'alice', 29, repStart).reward, 0);
    assert.strictEqual(service.rewardRepVoice('rep-guild', 'alice', 1, repStart + 60000).reward, 10);
    assert.strictEqual(service.repMember('rep-guild', 'alice').points, 12);
    const repArchive = service.rolloverRepMonth('rep-guild', Date.UTC(2026, 0, 1, 13, 0));
    assert.strictEqual(repArchive.archivedMonth, '2025-12');
    assert.strictEqual(repArchive.leaders[0].points, 12);
    assert.strictEqual(service.repMember('rep-guild', 'alice').points, 0);
    assert(service.pendingRepArchive('rep-guild'));
    assert.strictEqual(service.rewardRepMessage('rep-guild', 'bob', Date.UTC(2026, 0, 2, 13, 0)).points, 1);
    service.rolloverRepMonth('rep-guild', Date.UTC(2026, 1, 1, 13, 0));
    assert.strictEqual(service.repMember('rep-guild', 'bob').points, 0);
    service.updateRepArchiveStatus('rep-guild', 'announcement');
    assert(service.pendingRepArchive('rep-guild'));
    service.updateRepArchiveStatus('rep-guild', 'log');
    assert.strictEqual(service.pendingRepArchive('rep-guild').archivedMonth, '2026-01');
    service.updateRepArchiveStatus('rep-guild', 'announcement');
    service.updateRepArchiveStatus('rep-guild', 'log');
    assert.strictEqual(service.pendingRepArchive('rep-guild'), null);

    const daily = service.claimDaily('guild', 'alice', 'daily-1', 1_700_000_000_000);
    assert.strictEqual(daily.reward, 100);
    assert.strictEqual(daily.balance, 100);
    const cooldown = service.claimDaily('guild', 'alice', 'daily-2', 1_700_000_001_000);
    assert(cooldown.cooldown > 0);
    const streakRewards = [];
    const streakStart = 1_710_000_000_000;
    for (let day = 0; day < 8; day += 1) {
        streakRewards.push(service.claimDaily('streak-guild', 'streak-user', `streak-${day}`, streakStart + (day * 86400000)).reward);
    }
    assert.deepStrictEqual(streakRewards, [100, 200, 300, 400, 500, 600, 700, 700]);

    const text = service.rewardMessage({
        guildId: 'guild', userId: 'alice', messageId: 'message-1',
        content: 'This is a legitimate conversation message.', channelId: 'channel', now: 1_700_000_010_000,
    });
    assert(text.reward >= 1 && text.reward <= 3);
    const duplicate = service.rewardMessage({
        guildId: 'guild', userId: 'alice', messageId: 'message-2',
        content: 'This is a legitimate conversation message!', channelId: 'channel', now: 1_700_000_012_000,
    });
    assert.strictEqual(duplicate, null);

    assert.strictEqual(DICE_PAYOUT_TABLE.reduce((total, outcome) => total + outcome.weight, 0), DICE_WEIGHT_TOTAL);
    assert.strictEqual(diceExpectedReturn(), 0.845);
    assert(Math.abs(diceHouseEdge() - 0.155) < Number.EPSILON);

    const savedDiceRandom = service.random;
    service.random = () => 0.9999;
    service.admin('guild', 'add', 'alice', 2000, 'admin-1');
    const dice = service.dice('guild', 'alice', 50, 'dice-1');
    assert.strictEqual(dice.outcome, 'Jackpot');
    assert.strictEqual(dice.odds, 0.02);
    assert.strictEqual(dice.multiplier, 100);
    assert.strictEqual(dice.payout, 5000);
    assert.strictEqual(service.diceMaximumWager('guild'), 25000);
    assert.strictEqual(service.publicMember('guild', 'alice').daily_wagered, 50);

    const diceBoundaryCases = [
        [0, 'House wins', 0],
        [0.5738, 'Push', 1],
        [0.7738, 'Double', 2],
        [0.9238, 'Triple', 3],
        [0.9738, 'Hot roll', 5],
        [0.9938, 'Big win', 10],
        [0.9988, 'High roller', 25],
        [0.9998, 'Jackpot', 100],
    ];
    service.admin('weighted-dice-guild', 'add', 'dice-player', 1000, 'weighted-dice-bankroll');
    diceBoundaryCases.forEach(([random, outcome, multiplier], index) => {
        service.random = () => random;
        const result = service.dice('weighted-dice-guild', 'dice-player', 1, `weighted-dice-${index}`);
        assert.strictEqual(result.outcome, outcome);
        assert.strictEqual(result.multiplier, multiplier);
    });

    let higherLowerSurvival = 1;
    HIGHER_LOWER_MULTIPLIERS.forEach((multiplier, step) => {
        higherLowerSurvival *= higherLowerSuccessProbability(step);
        assert(Math.abs((higherLowerSurvival * multiplier) - HOUSE_GAME_RTP) < 1e-12);
    });
    service.random = () => 0;
    service.admin('higher-lower-guild', 'add', 'card-climber', 1000, 'higher-lower-bankroll');
    const higherLower = service.startHigherLower('higher-lower-guild', 'card-climber', 100, 'higher-lower-start');
    assert.strictEqual(higherLower.step, 0);
    const firstHigher = service.playHigherLower(higherLower.game_id, 'card-climber', 'higher');
    assert.strictEqual(firstHigher.success, true);
    assert.strictEqual(firstHigher.step, 1);
    assert.strictEqual(firstHigher.multiplier, 1.5);
    const higherCashout = service.cashOutHigherLower(higherLower.game_id, 'card-climber');
    assert.strictEqual(higherCashout.payout, 150);
    assert.strictEqual(higherCashout.balance, 1050);
    service.admin('higher-lower-summit', 'add', 'summit-climber', 1000, 'summit-bankroll');
    let summit = service.startHigherLower('higher-lower-summit', 'summit-climber', 40, 'summit-start');
    for (let step = 0; step < HIGHER_LOWER_MULTIPLIERS.length; step += 1) {
        summit = service.playHigherLower(summit.game_id, 'summit-climber', step % 2 ? 'lower' : 'higher');
    }
    assert.strictEqual(summit.status, 'completed');
    assert.strictEqual(summit.multiplier, 25);
    assert.strictEqual(summit.payout, 1000);

    assert.deepStrictEqual(DRAGON_TOWER_EGGS_PER_ROW, [3, 3, 3, 3, 3, 1, 1, 1]);
    let towerSurvival = 1;
    DRAGON_TOWER_MULTIPLIERS.forEach((multiplier, row) => {
        towerSurvival *= DRAGON_TOWER_EGGS_PER_ROW[row] / DRAGON_TOWER_COLUMNS;
        assert(Math.abs((towerSurvival * multiplier) - HOUSE_GAME_RTP) < 1e-12);
    });
    service.admin('dragon-guild', 'add', 'dragon-climber', 1000, 'dragon-bankroll');
    const tower = service.startDragonTower('dragon-guild', 'dragon-climber', 100, 'dragon-start');
    assert.strictEqual(tower.trapPositions.length, 8);
    assert.strictEqual(tower.trapPositions[0].length, 1);
    assert.strictEqual(tower.trapPositions[5].length, 3);
    const firstEgg = service.pickDragonTower(tower.game_id, 'dragon-climber', 0);
    assert.strictEqual(firstEgg.success, true);
    assert.strictEqual(firstEgg.row_number, 1);
    const towerCashout = service.cashOutDragonTower(tower.game_id, 'dragon-climber');
    assert.strictEqual(towerCashout.payout, 114);
    assert.strictEqual(towerCashout.balance, 1014);
    service.admin('dragon-danger-guild', 'add', 'tower-tester', 1000, 'dragon-danger-bankroll');
    let dangerTower = service.startDragonTower('dragon-danger-guild', 'tower-tester', 100, 'dragon-danger-start');
    for (let row = 0; row < 6; row += 1) dangerTower = service.pickDragonTower(dangerTower.game_id, 'tower-tester', 0);
    assert.strictEqual(dangerTower.row_number, 6);
    assert.strictEqual(dangerTower.success, true);
    const topRowTrap = service.pickDragonTower(dangerTower.game_id, 'tower-tester', 1);
    assert.strictEqual(topRowTrap.success, false);
    assert.strictEqual(topRowTrap.status, 'lost');
    service.random = savedDiceRandom;

    const limitNow = Date.UTC(2026, 7, 2, 12, 0);
    assert.strictEqual(service.config.gamblingHourlyWagerCap, 25000);
    service.admin('hourly-limit-guild', 'add', 'hourly-gambler', 100000, 'hourly-bankroll', limitNow);
    service.dice('hourly-limit-guild', 'hourly-gambler', 15000, 'hourly-first', limitNow + 1);
    service.dice('hourly-limit-guild', 'hourly-gambler', 10000, 'hourly-second', limitNow + 2);
    assert.throws(() => service.dice('hourly-limit-guild', 'hourly-gambler', 1, 'hourly-over', limitNow + 3), /hourly gambling allowance remaining: 0.*25,000 maximum wagered per hour/i);
    const nextHour = service.dice('hourly-limit-guild', 'hourly-gambler', 1, 'hourly-reset', limitNow + 3600002);
    assert.strictEqual(nextHour.wager, 1);

    const poker = service.startPoker('guild', 'alice', 5, 'poker-1');
    assert.strictEqual(poker.cards.length, 5);
    const held = service.togglePokerHold(poker.gameId, 'alice', 0);
    assert.deepStrictEqual(held.held, [0]);
    service.attachPokerMessage(poker.gameId, 'poker-channel', 'poker-message');
    const result = service.drawPoker(poker.gameId, 'alice');
    assert.strictEqual(result.cards.length, 5);
    assert.strictEqual(result.channelId, 'poker-channel');
    assert.strictEqual(result.messageId, 'poker-message');
    assert.strictEqual(service.pokerGame(poker.gameId).status, 'complete');
    service.admin('pair-payout-guild', 'add', 'pair-player', 100, 'pair-bankroll');
    const pairGame = service.startPoker('pair-payout-guild', 'pair-player', 5, 'pair-game');
    const evaluatePoker = service.evaluatePoker;
    service.evaluatePoker = () => ({ name: 'Tens or Better', multiplier: 1.5 });
    const pairResult = service.drawPoker(pairGame.gameId, 'pair-player');
    service.evaluatePoker = evaluatePoker;
    assert.strictEqual(pairResult.payout, 7, 'fractional poker payouts should round down to whole Blood Money');

    service.admin('blackjack-guild', 'add', 'card-player', 5000, 'blackjack-bankroll');
    service.admin('blackjack-guild', 'add', 'large-card-player', 5000, 'large-blackjack-bankroll');
    let largeBlackjack = service.startBlackjack('blackjack-guild', 'large-card-player', 1001, 'blackjack-over-legacy-maximum');
    while (largeBlackjack.status === 'active') largeBlackjack = service.standBlackjack(largeBlackjack.game_id, 'large-card-player');
    let blackjack = service.startBlackjack('blackjack-guild', 'card-player', 400, 'blackjack-game');
    assert.strictEqual(blackjack.status, 'active');
    blackjack = service.doubleBlackjack(blackjack.game_id, 'card-player', 'blackjack-double');
    assert.strictEqual(blackjack.status, 'complete');
    assert.strictEqual(blackjack.wager, 800);
    assert(blackjack.payout >= 0);
    service.admin('blackjack-guild', 'add', 'max-player', 5000, 'blackjack-max-bankroll');
    const maxBlackjack = service.startBlackjack('blackjack-guild', 'max-player', 600, 'blackjack-max-game');
    const uncappedDouble = service.doubleBlackjack(maxBlackjack.game_id, 'max-player', 'blackjack-max-double');
    assert.strictEqual(uncappedDouble.wager, 1200);
    const originalRandom = service.random;
    service.random = () => 0.04;
    service.admin('blackjack-guild', 'add', 'split-player', 10000, 'blackjack-split-bankroll');
    let splitGame = service.startBlackjack('blackjack-guild', 'split-player', 400, 'blackjack-split-game');
    assert.strictEqual(splitGame.canSplit, true);
    splitGame = service.splitBlackjack(splitGame.game_id, 'split-player', 'blackjack-split-action');
    assert.strictEqual(splitGame.hands.length, 2);
    assert.strictEqual(splitGame.wager, 800);
    if (splitGame.status === 'active' && splitGame.hands[splitGame.active_hand].length === 2) {
        splitGame = service.doubleBlackjack(splitGame.game_id, 'split-player', 'blackjack-split-double');
        assert(splitGame.wager > 1000);
    }
    while (splitGame.status === 'active') splitGame = service.standBlackjack(splitGame.game_id, 'split-player');
    assert.strictEqual(splitGame.handOutcomes.length, 2);
    service.random = originalRandom;

    const originalLimits = {
        blackjackMinimumWager: service.config.blackjackMinimumWager,
        blackjackMaximumWager: service.config.blackjackMaximumWager,
        blackjackDailyCap: service.config.blackjackDailyCap,
        pokerMinimumWager: service.config.pokerMinimumWager,
        pokerMaximumWager: service.config.pokerMaximumWager,
        pokerDailyCap: service.config.pokerDailyCap,
    };
    Object.assign(service.config, {
        blackjackMinimumWager: 100, blackjackMaximumWager: 200, blackjackDailyCap: 300,
        pokerMinimumWager: 100, pokerMaximumWager: 200, pokerDailyCap: 300,
    });
    service.admin('limits-guild', 'add', 'limited-player', 5000, 'limits-bankroll');
    assert.throws(() => service.startBlackjack('limits-guild', 'limited-player', 99, 'blackjack-minimum'), /minimum wager/i);
    let limitedBlackjack = service.startBlackjack('limits-guild', 'limited-player', 201, 'blackjack-over-legacy-maximum');
    while (limitedBlackjack.status === 'active') limitedBlackjack = service.standBlackjack(limitedBlackjack.game_id, 'limited-player');
    limitedBlackjack = service.startBlackjack('limits-guild', 'limited-player', 101, 'blackjack-over-legacy-daily');
    while (limitedBlackjack.status === 'active') limitedBlackjack = service.standBlackjack(limitedBlackjack.game_id, 'limited-player');
    assert.throws(() => service.startPoker('limits-guild', 'limited-player', 99, 'poker-minimum'), /minimum wager/i);
    const limitedPoker = service.startPoker('limits-guild', 'limited-player', 201, 'poker-over-legacy-maximum');
    service.drawPoker(limitedPoker.gameId, 'limited-player');
    const nextLimitedPoker = service.startPoker('limits-guild', 'limited-player', 101, 'poker-over-legacy-daily');
    service.drawPoker(nextLimitedPoker.gameId, 'limited-player');
    Object.assign(service.config, originalLimits);

    service.admin('duel-guild', 'add', 'duelist-one', 10000, 'duel-bankroll-one');
    service.admin('duel-guild', 'add', 'duelist-two', 10000, 'duel-bankroll-two');
    const duel = service.createDuel('duel-guild', 'duelist-one', 'duelist-two', 5000, 'duel-create', 2_000_000_000_000);
    assert.strictEqual(duel.status, 'pending');
    assert.strictEqual(service.publicMember('duel-guild', 'duelist-one').balance, 5000);
    const acceptedDuel = service.respondToDuel('duel-guild', 'duelist-two', 'accept', 'duel-accept', 2_000_000_001_000);
    assert.strictEqual(acceptedDuel.status, 'complete');
    assert.strictEqual(acceptedDuel.payout, 10000);
    assert.strictEqual(acceptedDuel.winner_id, 'duelist-two');
    assert.strictEqual(service.publicMember('duel-guild', 'duelist-two').balance, 15000);
    const deniedDuel = service.createDuel('duel-guild', 'duelist-one', 'duelist-two', 1000, 'duel-deny-create', 2_000_000_010_000);
    const balanceBeforeDeny = service.publicMember('duel-guild', 'duelist-one').balance;
    const denied = service.respondToDuel('duel-guild', 'duelist-two', 'deny', 'duel-deny', 2_000_000_011_000);
    assert.strictEqual(denied.status, 'denied');
    assert.strictEqual(service.publicMember('duel-guild', 'duelist-one').balance, balanceBeforeDeny + deniedDuel.wager);
    const expiringDuel = service.createDuel('duel-guild', 'duelist-one', 'duelist-two', 500, 'duel-expire-create', 2_000_000_020_000);
    const expiredDuels = service.expireDuels(expiringDuel.expires_at);
    assert.strictEqual(expiredDuels[0].status, 'expired');

    service.admin('guild', 'add', 'bob', 1000, 'admin-bob');
    const heistNow = 1_800_000_000_000;
    const heist = service.heistState('guild', heistNow);
    assert.strictEqual(heist.phase, 'signup');
    assert.strictEqual(heist.round.entry_fee, 0);
    service.ensureMember('guild', 'alice', heistNow);
    const aliceBeforeHeist = service.publicMember('guild', 'alice');
    const aliceEntry = service.joinHeist('guild', 'alice', heist.round.round_id, 'heist-alice', heistNow + 1000);
    assert.strictEqual(aliceEntry.alreadyEntered, false);
    assert.strictEqual(aliceEntry.balance, aliceBeforeHeist.balance);
    assert.strictEqual(service.publicMember('guild', 'alice').daily_wagered, aliceBeforeHeist.daily_wagered);
    const duplicateEntry = service.joinHeist('guild', 'alice', heist.round.round_id, 'heist-alice-duplicate', heistNow + 2000);
    assert.strictEqual(duplicateEntry.alreadyEntered, true);
    service.joinHeist('guild', 'bob', heist.round.round_id, 'heist-bob', heistNow + 3000);
    assert.strictEqual(service.heistEntryStatus(heist.round.round_id, 'bob').entered, true);
    const resolvedHeist = service.resolveHeist(heist.round.round_id, heistNow + (16 * 60000));
    assert.strictEqual(resolvedHeist.status, 'complete');
    assert.strictEqual(resolvedHeist.participantCount, 2);
    assert.strictEqual(resolvedHeist.success, 1);
    assert.strictEqual(resolvedHeist.payout_total, 200);
    assert(resolvedHeist.entries.every(entry => entry.payout === 100));

    const stats = service.stats('guild');
    assert(stats.transactions >= 5);
    assert(stats.circulation >= 0);
    service.setSetting('guild', 'active_month', '2024-01');
    const rollover = service.rolloverMonth('guild', Date.UTC(2024, 1, 1, 18));
    assert.strictEqual(rollover.archivedMonth, '2024-01');
    assert(rollover.resetMembers >= 1);
    assert.strictEqual(service.publicMember('guild', 'alice').balance, 0);
    assert(service.pendingMonthlyArchive('guild'));
    service.completeMonthlyArchive('guild');
    assert.strictEqual(service.pendingMonthlyArchive('guild'), null);

    const resetNow = Date.UTC(2026, 6, 7, 16);
    service.claimDaily('reset-guild', 'member-one', 'reset-daily', resetNow);
    service.admin('reset-guild', 'add', 'member-one', 475, 'reset-bankroll', resetNow + 1);
    const beforeBalanceReset = service.publicMember('reset-guild', 'member-one');
    const balancePreview = service.previewEconomyReset('reset-guild', 'member-balance', '123456789012345678', resetNow + 2);
    assert.strictEqual(balancePreview.userId, '123456789012345678');
    const actualPreview = service.previewEconomyReset('reset-guild', 'member-balance', '123456789012345679', resetNow + 2);
    assert.strictEqual(actualPreview.currentBalance, 0);
    const allPreview = service.previewEconomyReset('reset-guild', 'all-balances', '', resetNow + 2);
    assert.strictEqual(allPreview.currentBalance, 575);
    service.executeEconomyReset('reset-guild', 'all-balances', '', resetNow + 3);
    const afterBalanceReset = service.publicMember('reset-guild', 'member-one');
    assert.strictEqual(afterBalanceReset.balance, 0);
    assert.strictEqual(afterBalanceReset.lifetime_earned, beforeBalanceReset.lifetime_earned);
    assert.strictEqual(afterBalanceReset.lifetime_won, beforeBalanceReset.lifetime_won);
    assert(service.audit('reset-guild', 'member-one').some(row => row.type === 'admin-balance-reset'));

    service.claimDaily('cutoff-guild', 'earner', 'cutoff-daily', resetNow);
    const weeklyBefore = service.leaderboard('cutoff-guild', 'weekly', 10, resetNow);
    assert(weeklyBefore[0].score > 0);
    service.executeEconomyReset('cutoff-guild', 'weekly-rankings', '', resetNow + 1);
    assert.strictEqual(service.leaderboard('cutoff-guild', 'weekly', 10, resetNow + 2)[0].score, 0);
    const lifetimeAfterRankingReset = service.publicMember('cutoff-guild', 'earner').lifetime_earned;
    assert(lifetimeAfterRankingReset > 0);

    service.setSetting('weekly-archive-guild', 'active_week', '2026-07-06');
    service.claimDaily('weekly-archive-guild', 'weekly-earner', 'weekly-earned', Date.UTC(2026, 6, 7, 16));
    const weeklyArchive = service.rolloverWeek('weekly-archive-guild', Date.UTC(2026, 6, 13, 16));
    assert.strictEqual(weeklyArchive.archivedWeek, '2026-07-06');
    assert(weeklyArchive.leaders[0].score > 0);
    assert(service.pendingWeeklyArchive('weekly-archive-guild'));
    service.completeWeeklyArchive('weekly-archive-guild');
    assert.strictEqual(service.pendingWeeklyArchive('weekly-archive-guild'), null);
    service.claimDaily('slash-reset-guild', 'slash-member', 'slash-reset-earned', resetNow);
    const slashBefore = service.publicMember('slash-reset-guild', 'slash-member');
    const slashAfter = service.admin('slash-reset-guild', 'reset-user', 'slash-member', 0, 'slash-reset-command', resetNow + 1);
    assert.strictEqual(slashAfter.balance, 0);
    assert.strictEqual(slashAfter.lifetime_earned, slashBefore.lifetime_earned);
    const bulkOne = '123456789012345671';
    const bulkTwo = '123456789012345672';
    service.claimDaily('bulk-guild', bulkOne, 'bulk-prior-earning', resetNow);
    const bulkLifetimeBefore = service.publicMember('bulk-guild', bulkOne).lifetime_earned;
    const bulkPreview = service.previewBulkGrant('bulk-guild', [bulkOne, bulkTwo, bulkOne, 'invalid'], 2500);
    assert.strictEqual(bulkPreview.affectedMembers, 2);
    assert.strictEqual(bulkPreview.totalGrant, 5000);
    const bulkResult = service.executeBulkGrant('bulk-guild', bulkPreview.userIds, 2500, 'bulk-test-batch', resetNow + 1);
    assert.strictEqual(bulkResult.affectedMembers, 2);
    assert.strictEqual(service.publicMember('bulk-guild', bulkOne).balance, 2600);
    assert.strictEqual(service.publicMember('bulk-guild', bulkTwo).balance, 2500);
    assert.strictEqual(service.publicMember('bulk-guild', bulkOne).lifetime_earned, bulkLifetimeBefore);
    assert.strictEqual(service.publicMember('bulk-guild', bulkTwo).lifetime_earned, 0);
    assert(service.audit('bulk-guild', bulkOne).some(row => row.type === 'admin-bulk-add' && row.related === 'batch:bulk-test-batch'));
    assert.throws(() => service.previewBulkGrant('bulk-guild', [bulkOne], 0), /positive Blood Money amount/i);
    service.setSetting('guild', 'leaderboard_panel_message', 'keep-leaderboard-panel');
    service.setSetting('guild', 'heist_panel_message', 'keep-heist-panel');
    service.setSetting('guild', 'rep_panel_message', 'keep-rep-panel');
    service.rewardRepMessage('guild', 'rep-only-member', Date.now());
    const protectedRep = service.repMember('guild', 'rep-only-member').points;
    service.setSetting('guild', 'rep_active_month', 'protected-rep-month');
    service.admin('guild', 'add', 'alice', 250, 'admin-after-rollover');
    const reset = service.resetBeta('guild');
    assert(reset.membersCleared >= 1);
    assert(reset.transactionsCleared >= 1);
    assert.strictEqual(service.stats('guild').members, 0);
    assert.strictEqual(service.stats('guild').transactions, 0);
    assert.strictEqual(service.setting('guild', 'leaderboard_panel_message'), 'keep-leaderboard-panel');
    assert.strictEqual(service.setting('guild', 'heist_panel_message'), 'keep-heist-panel');
    assert.strictEqual(service.setting('guild', 'rep_panel_message'), 'keep-rep-panel');
    assert.strictEqual(service.setting('guild', 'rep_active_month'), 'protected-rep-month');
    assert.strictEqual(service.repMember('guild', 'rep-only-member').points, protectedRep);
    console.log('Economy tests passed.');
} finally {
    service.close();
    fs.rmSync(temp, { recursive: true, force: true });
}
