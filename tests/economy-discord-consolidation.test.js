'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Discord = require('discord.js');
const { economyCommandData, createEconomyIntegration, gambleMenuPayload, wagerModal } = require('../economy_discord');
const { findDoxWord, bannedWordAction } = require('../moderation_word_policy');

const oldGames = new Set(['slots', 'dice', 'higher-lower', 'dragon-tower', 'poker', 'blackjack', 'duel']);
const commands = economyCommandData();
assert.strictEqual(commands.filter(command => command.name === 'gamble').length, 1);
assert.strictEqual(commands.filter(command => oldGames.has(command.name)).length, 0);
assert.strictEqual(commands.filter(command => command.name === 'eco').length, 1);
const manage = commands.find(command => command.name === 'eco').options.find(option => option.name === 'manage');
assert.deepStrictEqual(manage.options.map(option => option.name), [
    'add', 'remove', 'set', 'give-all', 'reset-user', 'reset-daily', 'freeze', 'unfreeze', 'audit',
    'exclude-channel', 'include-channel', 'disable-gambling', 'enable-gambling', 'settings',
]);

const menu = gambleMenuPayload('Blood Money');
assert.strictEqual(menu.ephemeral, true);
assert.strictEqual(menu.components[0].components[0].data.custom_id, 'econ:gamble:menu');
assert.deepStrictEqual(menu.components[0].components[0].options.map(option => option.data.value), [...oldGames]);
assert.strictEqual(wagerModal('slots').components.length, 1);
assert.strictEqual(wagerModal('duel').components.length, 2);

function baseEconomy(overrides = {}) {
    return {
        config: { currencyName: 'Blood Money', gamblingChannelId: '', auditChannelId: '' },
        close() {},
        ...overrides,
    };
}

function baseClient() {
    return {
        on() {},
        once() {},
        users: { fetch: async id => ({ id, bot: false, toString: () => `<@${id}>` }) },
        channels: { fetch: async () => null },
        guilds: { cache: new Map(), fetch: async () => null },
    };
}

(async () => {
    const commandIntegration = createEconomyIntegration(baseClient(), baseEconomy());
    let commandReply = null;
    assert.strictEqual(await commandIntegration.handleCommand({
        commandName: 'gamble',
        channelId: 'gambling',
        isChatInputCommand: () => true,
        reply: async payload => { commandReply = payload; },
    }), true);
    assert.strictEqual(commandReply.ephemeral, true);
    assert.strictEqual(commandReply.components[0].components[0].data.custom_id, 'econ:gamble:menu');

    const selectIntegration = createEconomyIntegration(baseClient(), baseEconomy());
    let shownModal = null;
    const selectHandled = await selectIntegration.handleButton({
        isStringSelectMenu: () => true,
        isModalSubmit: () => false,
        customId: 'econ:gamble:menu',
        values: ['blackjack'],
        showModal: async modal => { shownModal = modal; },
    });
    assert.strictEqual(selectHandled, true);
    assert.strictEqual(shownModal.data.custom_id, 'econ:gamble:modal:blackjack');

    for (const game of oldGames) {
        let dispatched = false;
        const method = {
            slots: 'slots', dice: 'dice', 'higher-lower': 'startHigherLower', 'dragon-tower': 'startDragonTower',
            poker: 'startPoker', blackjack: 'startBlackjack', duel: 'createDuel',
        }[game];
        const economy = baseEconomy({ [method]: () => { dispatched = true; throw new Error('dispatch verified'); } });
        const integration = createEconomyIntegration(baseClient(), economy);
        const replies = [];
        const interaction = {
            id: `interaction-${game}`,
            customId: `econ:gamble:modal:${game}`,
            channelId: 'gambling',
            user: { id: '111111111111111111', toString: () => '<@111111111111111111>' },
            guild: {
                id: 'guild',
                emojis: { cache: new Map() },
                members: { fetch: async () => ({ id: '222222222222222222' }) },
            },
            fields: { getTextInputValue: id => id === 'amount' ? '500' : '<@222222222222222222>' },
            isStringSelectMenu: () => false,
            isModalSubmit: () => true,
            isButton: () => false,
            reply: async payload => { replies.push(payload); interaction.replied = true; },
            followUp: async payload => { replies.push(payload); },
        };
        assert.strictEqual(await integration.handleButton(interaction), true);
        assert.strictEqual(dispatched, true, `${game} modal did not dispatch to ${method}`);
        assert.match(replies.at(-1).content, /dispatch verified/);
    }

    const routedButtons = new Set();
    const buttonEconomy = baseEconomy({
        higherLowerGame: () => ({ status: 'active', user_id: 'player' }),
        playHigherLower: () => { routedButtons.add('higher-lower'); throw new Error('button verified'); },
        dragonTowerGame: () => ({ status: 'active', user_id: 'player' }),
        pickDragonTower: () => { routedButtons.add('dragon-tower'); throw new Error('button verified'); },
        blackjackGame: () => ({ status: 'active', user_id: 'player' }),
        hitBlackjack: () => { routedButtons.add('blackjack'); throw new Error('button verified'); },
        pokerGame: () => ({ status: 'active', user_id: 'player' }),
        togglePokerHold: () => {
            routedButtons.add('poker');
            return { gameId: 'p', cards: ['A♠', 'K♠', 'Q♠', 'J♠', '10♠'], held: [0], wager: 500 };
        },
    });
    const buttonIntegration = createEconomyIntegration(baseClient(), buttonEconomy);
    for (const [game, customId] of [
        ['higher-lower', 'econ:hilo:h:higher'],
        ['dragon-tower', 'econ:dragon:d:pick:1'],
        ['blackjack', 'econ:blackjack:b:hit'],
        ['poker', 'econ:poker:p:hold:0'],
    ]) {
        const handled = await buttonIntegration.handleButton({
            customId,
            user: { id: 'player', toString: () => '<@player>' },
            isStringSelectMenu: () => false,
            isModalSubmit: () => false,
            isButton: () => true,
            reply: async () => {},
            update: async () => {},
        });
        assert.strictEqual(handled, true, `${game} button was not handled`);
    }
    assert.deepStrictEqual([...routedButtons].sort(), ['blackjack', 'dragon-tower', 'higher-lower', 'poker']);

    let grantedIds = null;
    const economy = baseEconomy({
        previewBulkGrant: (_guildId, userIds, amount) => ({ userIds, amountPerMember: amount }),
        executeBulkGrant: (_guildId, userIds, amount) => {
            grantedIds = userIds;
            return { amountPerMember: amount, affectedMembers: userIds.length, totalGrant: amount * userIds.length };
        },
    });
    const integration = createEconomyIntegration(baseClient(), economy);
    const members = new Discord.Collection([
        ['human-a', { id: 'human-a', user: { bot: false } }],
        ['bot', { id: 'bot', user: { bot: true } }],
        ['human-b', { id: 'human-b', user: { bot: false } }],
    ]);
    let grantReply = '';
    await integration.handleCommand({
        commandName: 'eco',
        isChatInputCommand: () => true,
        member: { permissions: { has: permission => permission === Discord.PermissionFlagsBits.Administrator } },
        options: { getSubcommand: () => 'give-all', getInteger: () => 250 },
        guild: { id: 'guild', members: { fetch: async () => members } },
        user: { toString: () => '<@admin>' },
        deferReply: async () => {},
        editReply: async payload => { grantReply = payload; },
    });
    assert.deepStrictEqual(grantedIds, ['human-a', 'human-b']);
    assert.match(grantReply, /2 human members/);
    assert.match(grantReply, /500/);

    assert.strictEqual(findDoxWord('please dox nobody'), 'dox');
    assert.strictEqual(findDoxWord('doxxing is forbidden'), 'doxxing');
    assert.strictEqual(findDoxWord('ordinary message'), null);
    assert.deepStrictEqual(bannedWordAction('doxxed'), { deleteMessage: true, postScold: true, incrementOffense: false, jail: false });
    assert.deepStrictEqual(bannedWordAction('truly-banned-word'), { deleteMessage: true, postScold: false, incrementOffense: true, jail: true });

    const root = path.join(__dirname, '..');
    const bootstrap = fs.readFileSync(path.join(root, 'discord_bootstrap.js'), 'utf8');
    const railway = fs.readFileSync(path.join(root, 'railway_start.js'), 'utf8');
    const botSource = fs.readFileSync(path.join(root, 'discord_bot.js'), 'utf8');
    assert.doesNotMatch(bootstrap, /economy_command_cleanup_patch|gamble_interaction_patch|dox_word_policy_patch/);
    assert.match(railway, /fork\(path\.join\(__dirname,'discord_bootstrap\.js'/);
    assert.doesNotMatch(railway, /fork\(path\.join\(__dirname,'discord_bot\.js'/);
    assert.match(botSource, /No offense recorded and no jail applied/);
    console.log('economy Discord consolidation tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
