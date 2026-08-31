'use strict';

const Discord = require('discord.js');
const slots = require('./slots');
const {
    HIGHER_LOWER_MULTIPLIERS,
    DRAGON_TOWER_COLUMNS,
    DRAGON_TOWER_ROWS,
    DRAGON_TOWER_EGGS_PER_ROW,
    higherLowerSuccessProbability,
} = require('./core');

function money(value) {
    return Number(value || 0).toLocaleString('en-US');
}

function duration(milliseconds) {
    const minutes = Math.ceil(milliseconds / 60000);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    const hours = Math.ceil(minutes / 60);
    return `${hours} hour${hours === 1 ? '' : 's'}`;
}

const STAFF_BALANCE_ACTIONS = new Set(['add', 'remove', 'set', 'reset-user']);

function canAdministerEconomy(member, action, staffRoleIds = []) {
    if (member?.permissions?.has?.(Discord.PermissionFlagsBits.Administrator)) return true;
    if (!STAFF_BALANCE_ACTIONS.has(String(action || ''))) return false;
    return staffRoleIds.some(roleId => member?.roles?.cache?.has?.(roleId));
}

function economyCommandData() {
    return [
        new Discord.SlashCommandBuilder().setName('balance').setDescription('View a Blood Money balance')
            .addUserOption(option => option.setName('user').setDescription('Member to view').setRequired(false)),
        new Discord.SlashCommandBuilder().setName('leaderboard').setDescription('View the Blood Money leaderboard')
            .addStringOption(option => option.setName('type').setDescription('Leaderboard type').setRequired(false).addChoices(
                { name: 'Current balance', value: 'balance' }, { name: 'Lifetime earnings', value: 'lifetime' },
                { name: 'Gambling winnings', value: 'gambling' }, { name: 'Voice time', value: 'voice' },
                { name: 'Daily earnings', value: 'daily' }, { name: 'Weekly earnings', value: 'weekly' },
                { name: 'Monthly earnings', value: 'monthly' }, { name: 'REP', value: 'rep' },
            )),
        new Discord.SlashCommandBuilder().setName('daily').setDescription('Claim your daily Blood Money'),
        new Discord.SlashCommandBuilder().setName('economy-stats').setDescription('View server-wide Blood Money statistics'),
        new Discord.SlashCommandBuilder().setName('pay').setDescription('Transfer Blood Money to another member')
            .addUserOption(option => option.setName('user').setDescription('Member to pay').setRequired(true))
            .addIntegerOption(option => option.setName('amount').setDescription('Amount to transfer').setMinValue(1).setRequired(true)),
        new Discord.SlashCommandBuilder().setName('gamble').setDescription('Open the Blood Money game menu'),
        new Discord.SlashCommandBuilder().setName('eco').setDescription('Manage the Blood Money economy')
            .addSubcommandGroup(group => group.setName('manage').setDescription('Blood Money moderation and settings')
                .addSubcommand(sub => sub.setName('add').setDescription('Add Blood Money to a member').addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)).addIntegerOption(o => o.setName('amount').setDescription('Amount').setMinValue(1).setRequired(true)))
                .addSubcommand(sub => sub.setName('remove').setDescription('Remove Blood Money from a member').addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)).addIntegerOption(o => o.setName('amount').setDescription('Amount').setMinValue(1).setRequired(true)))
                .addSubcommand(sub => sub.setName('set').setDescription('Set a member Blood Money balance').addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)).addIntegerOption(o => o.setName('amount').setDescription('Balance').setMinValue(0).setRequired(true)))
                .addSubcommand(sub => sub.setName('give-all').setDescription('Give every human member Blood Money').addIntegerOption(o => o.setName('amount').setDescription('Amount per member').setMinValue(1).setRequired(true)))
                .addSubcommand(sub => sub.setName('reset-user').setDescription('Reset a member economy record').addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)))
                .addSubcommand(sub => sub.setName('reset-daily').setDescription('Reset a member daily limits').addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)))
                .addSubcommand(sub => sub.setName('freeze').setDescription('Freeze a member economy account').addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)))
                .addSubcommand(sub => sub.setName('unfreeze').setDescription('Unfreeze a member economy account').addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)))
                .addSubcommand(sub => sub.setName('audit').setDescription('View recent member transactions').addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)))
                .addSubcommand(sub => sub.setName('exclude-channel').setDescription('Exclude a channel from text rewards').addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)))
                .addSubcommand(sub => sub.setName('include-channel').setDescription('Allow text rewards in a channel').addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)))
                .addSubcommand(sub => sub.setName('disable-gambling').setDescription('Disable all gambling commands'))
                .addSubcommand(sub => sub.setName('enable-gambling').setDescription('Enable all gambling commands'))
                .addSubcommand(sub => sub.setName('settings').setDescription('Show active economy settings'))),
    ].map(command => command.toJSON());
}

const GAMBLE_GAMES = new Set(['slots', 'dice', 'higher-lower', 'dragon-tower', 'poker', 'blackjack', 'duel']);

function gambleMenuPayload(currencyName) {
    const gameButton = (game, label, emoji, style = Discord.ButtonStyle.Secondary) => new Discord.ButtonBuilder()
        .setCustomId(`econ:gamble:choose:${game}`).setLabel(label).setEmoji(emoji).setStyle(style);
    return {
        embeds: [new Discord.EmbedBuilder().setColor(0x9b1c31)
            .setTitle('🎲 The Commission — Gambling')
            .setDescription(`Push a game button, enter your ${currencyName} wager, and play.`)
            .setFooter({ text: 'One command. Seven games.' })],
        components: [
            new Discord.ActionRowBuilder().addComponents(
                gameButton('slots', 'Slots', '🎰'),
                gameButton('dice', 'Dice', '🎲'),
                gameButton('higher-lower', 'Higher / Lower', '🃏'),
                gameButton('dragon-tower', 'Dragon Tower', '🐉'),
            ),
            new Discord.ActionRowBuilder().addComponents(
                gameButton('poker', 'Poker', '♠️'),
                gameButton('blackjack', 'Blackjack', '🃏'),
                gameButton('duel', 'Duel', '⚔️', Discord.ButtonStyle.Danger),
            ),
        ],
        ephemeral: true,
    };
}

function wagerModal(game) {
    const labels = { slots: 'Slots', dice: 'Dice', 'higher-lower': 'Higher / Lower', 'dragon-tower': 'Dragon Tower', poker: 'Poker', blackjack: 'Blackjack', duel: 'Duel' };
    if (!GAMBLE_GAMES.has(game)) throw new Error('That gambling game is not available.');
    const modal = new Discord.ModalBuilder().setCustomId(`econ:gamble:modal:${game}`).setTitle(`${labels[game]} — Wager`);
    modal.addComponents(new Discord.ActionRowBuilder().addComponents(
        new Discord.TextInputBuilder().setCustomId('amount').setLabel('Blood Money wager')
            .setStyle(Discord.TextInputStyle.Short).setPlaceholder('500').setRequired(true).setMinLength(1).setMaxLength(12),
    ));
    if (game === 'duel') {
        modal.addComponents(new Discord.ActionRowBuilder().addComponents(
            new Discord.TextInputBuilder().setCustomId('opponent').setLabel('Opponent @mention or Discord user ID')
                .setStyle(Discord.TextInputStyle.Short).setPlaceholder('@member or 123456789012345678').setRequired(true).setMinLength(2).setMaxLength(40),
        ));
    }
    return modal;
}

function modalWager(interaction) {
    const raw = interaction.fields.getTextInputValue('amount').replace(/[,$\s]/g, '');
    const amount = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(amount) || amount < 1 || String(amount) !== raw) throw new Error('Enter a valid whole-number wager of at least 1 Blood Money.');
    return amount;
}

function duelOpponentId(raw) {
    const match = String(raw || '').match(/\d{17,20}/);
    if (!match) throw new Error('Enter a valid Discord @mention or user ID for the duel opponent.');
    return match[0];
}

function slotsPayload(result, guild, currencyName) {
    const symbols = slots.serverSymbols(guild);
    const board = [0, 3, 6].map(start => result.grid.slice(start, start + 3).map(symbol => symbol.render).join('  ')).join('\n');
    const paytable = symbols.map(symbol => `${symbol.render} **${symbol.multiplier}×**`).join(' · ');
    const wins = result.wins.length
        ? result.wins.map(win => `Line ${win.line}: ${win.symbol.render} ${win.symbol.render} ${win.symbol.render} → **${win.multiplier}×**`).join('\n')
        : 'No matching payline this spin.';
    return { embeds: [new Discord.EmbedBuilder().setColor(result.payout > 0 ? 0x2ea043 : 0x9b1c31)
        .setTitle('🎰 The Commission — 3×3 Slots').setDescription(`${board}\n\n${wins}`).addFields(
            { name: 'Wager', value: `${money(result.wager)} ${currencyName}`, inline: true },
            { name: 'Total multiplier', value: `${result.multiplier}×`, inline: true },
            { name: 'Payout', value: `${money(result.payout)} ${currencyName}`, inline: true },
            { name: 'Balance', value: `${money(result.balance)} ${currencyName}`, inline: true },
            { name: 'Paytable · 3 matching on any line', value: paytable },
        ).setFooter({ text: '8 paylines · winning lines stack' }).setTimestamp()] };
}

function higherLowerPayload(game, userMention, currencyName, note = '') {
    const active = game.status === 'active';
    const currentMultiplier = game.step > 0 ? HIGHER_LOWER_MULTIPLIERS[game.step - 1] : 0;
    const nextMultiplier = active ? HIGHER_LOWER_MULTIPLIERS[game.step] : null;
    const last = game.history?.at(-1);
    const description = active
        ? `${userMention}, is the hidden card **Higher** or **Lower** than **${game.current_card}**?${last?.success ? `\n\n✅ ${last.reference} → ${last.revealed} was correct.` : ''}`
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
            .setFooter({ text: 'Ties lose · inactivity cashes out earned progress' }).setTimestamp()],
        components,
    };
}

function dragonTowerGrid(game) {
    const history = new Map((game.history || []).map(item => [item.row, item]));
    const revealAll = game.status !== 'active';
    const lines = [];
    for (let row = DRAGON_TOWER_ROWS - 1; row >= 0; row -= 1) {
        const played = history.get(row);
        let tiles;
        if (played || revealAll) {
            const traps = played?.traps || game.trapPositions[row];
            tiles = Array.from({ length: DRAGON_TOWER_COLUMNS }, (_, column) => traps.includes(column) ? '🔥' : '🥚');
            if (played) tiles[played.selected] = played.success ? '🐉' : '💥';
        } else if (row === game.row_number) tiles = Array(DRAGON_TOWER_COLUMNS).fill('❓');
        else tiles = Array(DRAGON_TOWER_COLUMNS).fill('⬛');
        lines.push(`**${String(row + 1).padStart(2, '0')}**  ${tiles.join('  ')}`);
    }
    return lines.join('\n');
}

function dragonTowerPayload(game, userMention, currencyName, note = '') {
    const active = game.status === 'active';
    const description = game.status === 'lost'
        ? `${userMention} triggered a trap on row ${game.row_number + 1}. The tower took the wager.`
        : active
            ? `${userMention}, choose one of four tiles on row **${game.row_number + 1}**. Find an egg, then climb again or cash out.`
            : `${userMention} ${game.status === 'completed' ? 'conquered all eight rows' : 'cashed out safely'}.`;
    const eggs = active ? DRAGON_TOWER_EGGS_PER_ROW[game.row_number] : 0;
    const fields = [
        { name: 'Wager', value: `${money(game.wager)} ${currencyName}`, inline: true },
        { name: 'Rows cleared', value: `${game.row_number}/${DRAGON_TOWER_ROWS}`, inline: true },
    ];
    if (active) fields.push(
        { name: 'Current cash-out', value: game.row_number ? `${game.multiplier.toFixed(2)}×` : 'Locked', inline: true },
        { name: 'Next row', value: `${eggs}/4 eggs · ${game.nextMultiplier.toFixed(2)}×`, inline: true },
    );
    else fields.push(
        { name: 'Payout', value: `${money(game.payout)} ${currencyName} · ${Number(game.multiplier || 0).toFixed(2)}×`, inline: true },
        { name: 'Balance', value: `${money(game.balance)} ${currencyName}`, inline: true },
    );
    const components = active ? [
        new Discord.ActionRowBuilder().addComponents(...Array.from({ length: DRAGON_TOWER_COLUMNS }, (_, column) =>
            new Discord.ButtonBuilder().setCustomId(`econ:dragon:${game.game_id}:pick:${column}`).setLabel(`Tile ${column + 1}`).setEmoji('🥚').setStyle(Discord.ButtonStyle.Secondary))),
        new Discord.ActionRowBuilder().addComponents(
            new Discord.ButtonBuilder().setCustomId(`econ:dragon:${game.game_id}:auto`).setLabel('Auto-Pick').setEmoji('🎲').setStyle(Discord.ButtonStyle.Primary),
            new Discord.ButtonBuilder().setCustomId(`econ:dragon:${game.game_id}:cash`).setLabel(game.row_number ? `Cash Out ${game.multiplier.toFixed(2)}×` : 'Cash Out').setEmoji('💰').setStyle(Discord.ButtonStyle.Success).setDisabled(game.row_number < 1),
        ),
    ] : [];
    return {
        embeds: [new Discord.EmbedBuilder().setColor(active ? 0xd29922 : game.status === 'lost' ? 0x9b1c31 : 0x2ea043)
            .setTitle('🐉 Dragon Tower · 4×8').setDescription(`${description}\n\n${dragonTowerGrid(game)}${note ? `\n\n*${note}*` : ''}`).addFields(fields)
            .setFooter({ text: 'Rows 1–5: 3 eggs · Rows 6–8: 1 egg' }).setTimestamp()],
        components,
    };
}

function pokerComponents(game) {
    const cardButtons = game.cards.map((card, index) => new Discord.ButtonBuilder()
        .setCustomId(`econ:poker:${game.gameId}:hold:${index}`)
        .setLabel(`${card} · ${game.held.includes(index) ? 'Unhold' : 'Hold'}`)
        .setStyle(game.held.includes(index) ? Discord.ButtonStyle.Success : Discord.ButtonStyle.Secondary));
    const draw = new Discord.ButtonBuilder().setCustomId(`econ:poker:${game.gameId}:draw`).setLabel('Draw').setStyle(Discord.ButtonStyle.Danger);
    return [
        new Discord.ActionRowBuilder().addComponents(...cardButtons),
        new Discord.ActionRowBuilder().addComponents(draw),
    ];
}

function pokerTableText(game, userMention, currencyName, extra = {}) {
    const cards = game.cards.map((card, index) => game.held?.includes(index) ? `**[${card} · HELD]**` : `[${card}]`).join('  ');
    const lines = [
        '🃏 **THE COMMISSION · PUBLIC POKER TABLE**',
        `Player: ${userMention}`,
        `Wager: **${money(game.wager)} ${currencyName}**`,
        `Hand: ${cards}`,
    ];
    if (extra.balance !== undefined) lines.push(`Balance after wager: **${money(extra.balance)}**`);
    lines.push(
        '',
        '**Paytable:** Tens+ 1.5× · Two Pair 2× · Trips 3× · Straight 5× · Flush 7× · Full House 10× · Quads 25× · Straight Flush 75× · Royal Flush 150×',
        'Only the player may use Hold and Draw. The complete game remains visible to everyone in this channel.',
    );
    return lines.join('\n');
}

function pokerResultText(result, userMention, currencyName) {
    return [
        '🃏 **THE COMMISSION · POKER RESULT**',
        `Player: ${userMention}`,
        `Final hand: **${result.cards.map(card => `[${card}]`).join('  ')}**`,
        `Result: **${result.hand}**`,
        `Wager: **${money(result.wager)} ${currencyName}**`,
        `Payout: **${money(result.payout)} ${currencyName} (${result.multiplier}×)**`,
        `New balance: **${money(result.balance)} ${currencyName}**`,
    ].join('\n');
}

function blackjackPayload(game, userMention, currencyName, note = '') {
    const active = game.status === 'active';
    const dealerCards = active ? `${game.dealerCards[0]}  [hidden]` : game.dealerCards.join('  ');
    const outcomeLabels = {
        blackjack: 'Natural blackjack', win: 'Player wins', push: 'Push — wager returned',
        loss: 'Dealer wins', bust: 'Player busts', 'dealer-blackjack': 'Dealer blackjack — natural 21', cancelled: 'Game cancelled',
    };
    const outcomeText = game.handOutcomes?.length > 1
        ? game.handOutcomes.map((outcome, index) => `Hand ${index + 1}: ${outcomeLabels[outcome] || outcome}`).join(' · ')
        : outcomeLabels[game.outcome] || 'Choose Hit, Stay, Double Down, or Split';
    const automaticNote = game.outcome === 'dealer-blackjack'
        ? '\n\n*The dealer started with a natural 21, so standard blackjack ends the hand before player actions.*'
        : '';
    const description = active
        ? `${userMention}, play **Hand ${game.active_hand + 1}** using **Hit**, **Stay**, **Double Down**, or **Split**. The dealer stays on 17.`
        : `${userMention} — **${outcomeText}**${automaticNote}${note ? `\n\n*${note}*` : ''}`;
    const fields = [
        ...game.hands.map((cards, index) => ({
            name: `${game.hands.length > 1 ? `Hand ${index + 1}` : 'Player'} · ${game.handValues[index].total}${active && index === game.active_hand ? ' · ACTIVE' : ''}`,
            value: `${cards.join('  ')}\nBet: ${money(game.handWagers[index])} ${currencyName}${!active && game.handOutcomes[index] ? ` · ${outcomeLabels[game.handOutcomes[index]] || game.handOutcomes[index]}` : ''}`,
            inline: false,
        })),
        { name: `Dealer · ${active ? '?' : game.dealerHand.total}`, value: dealerCards, inline: false },
        { name: 'Total bet', value: `${money(game.wager)} ${currencyName}`, inline: true },
    ];
    if (!active) {
        fields.push(
            { name: 'Payout', value: `${money(game.payout)} ${currencyName}`, inline: true },
            { name: 'Balance', value: `${money(game.balance)} ${currencyName}`, inline: true },
        );
    }
    const activeWager = game.handWagers[game.active_hand];
    const activeCards = game.hands[game.active_hand];
    const components = active ? [new Discord.ActionRowBuilder().addComponents(
        new Discord.ButtonBuilder().setCustomId(`econ:blackjack:${game.game_id}:hit`).setLabel('Hit').setEmoji('🃏').setStyle(Discord.ButtonStyle.Primary),
        new Discord.ButtonBuilder().setCustomId(`econ:blackjack:${game.game_id}:stand`).setLabel('Stay').setEmoji('✋').setStyle(Discord.ButtonStyle.Danger),
        new Discord.ButtonBuilder().setCustomId(`econ:blackjack:${game.game_id}:double`).setLabel('Double Down').setEmoji('💰').setStyle(Discord.ButtonStyle.Success)
            .setDisabled(activeCards.length !== 2 || Number(game.balance || 0) < activeWager),
        new Discord.ButtonBuilder().setCustomId(`econ:blackjack:${game.game_id}:split`).setLabel('Split').setEmoji('✂️').setStyle(Discord.ButtonStyle.Secondary)
            .setDisabled(!game.canSplit || Number(game.balance || 0) < activeWager),
    )] : [];
    return {
        embeds: [new Discord.EmbedBuilder().setColor(active ? 0x2563eb : ['win', 'blackjack'].includes(game.outcome) ? 0x2ea043 : game.outcome === 'push' ? 0xd29922 : 0x9b1c31)
            .setTitle('🂡 The Commission Blackjack').setDescription(description).addFields(fields)
            .setFooter({ text: 'Opening and daily limits are configured by administrators · Natural blackjack pays 3:2' }).setTimestamp()],
        components,
    };
}

function duelChallengePayload(duel, currencyName) {
    return {
        content: `<@${duel.challenged_id}>`,
        embeds: [new Discord.EmbedBuilder().setColor(0x9b1c31).setTitle('⚔️ Blood Money Duel Challenge')
            .setDescription(`<@${duel.challenger_id}> challenged <@${duel.challenged_id}> to a **50/50 duel**.`)
            .addFields(
                { name: 'Wager per player', value: `${money(duel.wager)} ${currencyName}`, inline: true },
                { name: 'Winner receives', value: `${money(duel.wager * 2)} ${currencyName}`, inline: true },
                { name: 'Respond', value: `Only <@${duel.challenged_id}> may type **!accept** or **!deny** in this channel.`, inline: false },
            ).setFooter({ text: 'Fair 50/50 result · No house fee · Expires in 5 minutes' }).setTimestamp()],
        allowedMentions: { users: [duel.challenged_id] },
    };
}

function duelResultPayload(duel, currencyName) {
    const title = duel.status === 'complete' ? '⚔️ Duel Complete' : duel.status === 'denied' ? '🛑 Duel Denied' : '⌛ Duel Expired';
    const description = duel.status === 'complete'
        ? `<@${duel.winner_id}> defeated their opponent and won **${money(duel.wager * 2)} ${currencyName}**.`
        : `<@${duel.challenged_id}> ${duel.status === 'denied' ? 'denied the challenge' : 'did not answer in time'}. <@${duel.challenger_id}>'s **${money(duel.wager)} ${currencyName}** was refunded.`;
    return {
        content: '',
        embeds: [new Discord.EmbedBuilder().setColor(duel.status === 'complete' ? 0x2ea043 : 0xd29922)
            .setTitle(title).setDescription(description).setFooter({ text: 'The Commission · Player duel' }).setTimestamp()],
        components: [],
    };
}

module.exports = {
    money,
    duration,
    canAdministerEconomy,
    economyCommandData,
    GAMBLE_GAMES,
    gambleMenuPayload,
    wagerModal,
    modalWager,
    duelOpponentId,
    slotsPayload,
    higherLowerPayload,
    dragonTowerGrid,
    dragonTowerPayload,
    pokerComponents,
    pokerTableText,
    pokerResultText,
    blackjackPayload,
    duelChallengePayload,
    duelResultPayload,
};
