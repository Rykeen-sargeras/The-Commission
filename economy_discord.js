const crypto = require('crypto');
const Discord = require('discord.js');
const slots = require('./economy_slots_patch');
const {
    DICE_PAYOUT_TABLE,
    HIGHER_LOWER_MULTIPLIERS,
    DRAGON_TOWER_COLUMNS,
    DRAGON_TOWER_ROWS,
    DRAGON_TOWER_EGGS_PER_ROW,
    diceExpectedReturn,
    diceHouseEdge,
    higherLowerSuccessProbability,
} = require('./economy');

const DICE_ODDS_TEXT = [...DICE_PAYOUT_TABLE]
    .reverse()
    .map(outcome => `${outcome.multiplier}× at ${outcome.weight / 100}%`)
    .join(', ');

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
            .setFooter({ text: '85% RTP · 15% house edge · ties lose · inactivity cashes out earned progress' }).setTimestamp()],
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
            .setFooter({ text: 'Rows 1–5: 3 eggs · Rows 6–8: 1 egg · 85% RTP · 15% house edge' }).setTimestamp()],
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

function createEconomyIntegration(client, economy, options = {}) {
    let voiceTimer = null;
    let repVoiceTimer = null;
    let pokerTimer = null;
    let rolloverTimer = null;
    let panelTimer = null;
    let heistBoundaryTimer = null;
    const resetPreviews = new Map();
    const bulkGrantPreviews = new Map();

    async function audit(guild, title, description, color = 0x9b1c31) {
        const channelId = economy.config.auditChannelId || options.auditChannelId;
        if (!channelId) return;
        const channel = await guild.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased()) return;
        await channel.send({ embeds: [new Discord.EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setTimestamp()] }).catch(() => {});
    }

    function archiveLines(title, preview) {
        const lines = [title, '='.repeat(60), ''];
        if (Array.isArray(preview.leaders)) {
            lines.push(...(preview.leaders.length
                ? preview.leaders.map((row, index) => `${index + 1}. ${row.user_id} — ${money(row.score)} earned — balance ${money(row.balance)} — ${row.rank}`)
                : ['No qualifying earnings were recorded.']));
        }
        if (preview.activity) lines.push('', `Activity transactions: ${money(preview.activity.transactions)}`, `Activity members: ${money(preview.activity.members)}`, `Activity earned: ${money(preview.activity.earned)}`);
        if (preview.gambling) lines.push('', `Gambling transactions: ${money(preview.gambling.transactions)}`, `Wagered: ${money(preview.gambling.wagered)}`, `Payouts: ${money(preview.gambling.payouts)}`);
        lines.push('', `Snapshot: ${new Date(preview.archivedAt || Date.now()).toISOString()}`, 'Lifetime statistics were preserved.');
        return lines;
    }

    async function archiveResetPreview(guild, preview, label) {
        const channelId = economy.config.archiveChannelId || economy.config.auditChannelId || options.auditChannelId;
        const channel = await guild.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased()) throw new Error('The configured Blood Money archive channel is missing or is not a text channel. Nothing was reset.');
        const safeLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const attachment = new Discord.AttachmentBuilder(Buffer.from(archiveLines(`BLOOD MONEY ${label.toUpperCase()}`, preview).join('\n'), 'utf8'), {
            name: `blood-money-${safeLabel}-${Date.now()}.txt`,
        });
        await channel.send({ content: `🩸 Final **${label}** snapshot saved before the confirmed reset.`, files: [attachment] });
    }

    async function prizeExcludedIds(guild) {
        const excluded = new Set(economy.excludedLeaderboardUsers);
        excluded.add(guild.ownerId);
        if (options.ownerUserId) excluded.add(options.ownerUserId);
        const members = await guild.members.fetch().catch(() => guild.members.cache);
        for (const member of members.values()) {
            const staffRole = (options.staffRoleIds || []).some(roleId => member.roles.cache.has(roleId));
            if (member.user.bot || staffRole || member.permissions.has(Discord.PermissionFlagsBits.Administrator)) excluded.add(member.id);
        }
        return excluded;
    }

    function prizeEnabledFor(monthKey) {
        const configured = String(economy.config.prizeMonths || '').split(/[\s,]+/).filter(Boolean);
        const monthNumber = String(Number(monthKey.slice(5, 7)));
        return configured.includes(monthKey) || configured.includes(monthNumber) || configured.includes(monthKey.slice(5, 7));
    }

    function eligibleAccount(user) {
        return Date.now() - user.createdTimestamp >= economy.config.minimumAccountAgeDays * 86400000;
    }

    async function upsertPanel(guild, channelId, settingKey, payload) {
        if (!channelId) return null;
        const channel = await guild.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased()) return null;
        const storedId = economy.setting(guild.id, settingKey);
        let message = storedId ? await channel.messages.fetch(storedId).catch(() => null) : null;
        if (message) await message.edit(payload);
        else {
            message = await channel.send(payload);
            economy.setSetting(guild.id, settingKey, message.id);
        }
        return message;
    }

    function leaderboardLines(rows) {
        return rows.length
            ? rows.slice(0, 5).map((row, index) => `**${index + 1}.** <@${row.user_id}> — **${money(row.score)}**`).join('\n')
            : 'No qualifying activity yet.';
    }

    async function updateLeaderboardPanel(guild) {
        if (!economy.config.leaderboardChannelId) return;
        const balance = economy.leaderboard(guild.id, 'balance', 5);
        const daily = economy.leaderboard(guild.id, 'daily', 5);
        const weekly = economy.leaderboard(guild.id, 'weekly', 5);
        const monthly = economy.leaderboard(guild.id, 'monthly', 5);
        const embed = new Discord.EmbedBuilder().setColor(0x9b1c31).setTitle('🩸 Blood Money Leaderboards')
            .setDescription('This board updates automatically. Rankings exclude configured staff and bot accounts.')
            .addFields(
                { name: '💰 Current Balance', value: leaderboardLines(balance) },
                { name: '📅 Daily Earnings', value: leaderboardLines(daily) },
                { name: '🗓️ Weekly Earnings', value: leaderboardLines(weekly) },
                { name: '🌙 Monthly Earnings', value: leaderboardLines(monthly) },
            ).setFooter({ text: 'The Commission · Persistent leaderboard' }).setTimestamp();
        const components = [new Discord.ActionRowBuilder().addComponents(
            new Discord.ButtonBuilder().setCustomId('econ:leaderboard:balance').setLabel('My Balance').setStyle(Discord.ButtonStyle.Secondary),
            new Discord.ButtonBuilder().setCustomId('econ:leaderboard:refresh').setLabel('Refresh').setStyle(Discord.ButtonStyle.Danger),
        )];
        await upsertPanel(guild, economy.config.leaderboardChannelId, 'leaderboard_panel_message', { embeds: [embed], components });
    }

    async function updateRepLeaderboardPanel(guild) {
        if (!economy.config.leaderboardChannelId) return;
        const leaders = economy.repLeaderboard(guild.id, 10);
        const lines = leaders.length
            ? leaders.map(row => `**${row.position}.** <@${row.user_id}> — **${money(row.points)} REP**`).join('\n')
            : 'No REP has been earned this month yet.';
        const embed = new Discord.EmbedBuilder().setColor(0x7c3aed).setTitle('⭐ Monthly REP Leaderboard')
            .setDescription(lines)
            .addFields(
                { name: 'Text REP', value: '+1 after each 2-minute personal cooldown', inline: true },
                { name: 'Voice REP', value: '+10 per 30 qualifying minutes with 2+ people', inline: true },
            )
            .setFooter({ text: 'Locked system · Resets on the 1st at 8:00 AM Eastern' }).setTimestamp();
        const components = [new Discord.ActionRowBuilder().addComponents(
            new Discord.ButtonBuilder().setCustomId('econ:rep:mine').setLabel('My REP').setStyle(Discord.ButtonStyle.Secondary),
            new Discord.ButtonBuilder().setCustomId('econ:rep:refresh').setLabel('Refresh').setStyle(Discord.ButtonStyle.Primary),
        )];
        await upsertPanel(guild, economy.config.leaderboardChannelId, 'rep_panel_message', { embeds: [embed], components });
    }

    function heistPanelPayload(state) {
        const round = state.round;
        const signup = state.phase === 'signup';
        const chance = Math.min(
            economy.config.heistMaximumSuccessChance,
            economy.config.heistBaseSuccessChance + (Math.max(0, round.participantCount - 1) * economy.config.heistChancePerExtraPlayer),
        );
        let title = signup ? '🔫 The Commission Heist · Entry Open' : '🚬 The Commission Heist · Crew Cooling Down';
        let description;
        if (signup) {
            const freeEntry = round.entry_fee === 0;
            const projectedShare = freeEntry
                ? economy.config.heistFreeSuccessReward
                : (round.participantCount ? Math.floor((round.pot * economy.config.heistPayoutMultiplier) / round.participantCount) : 0);
            const projectedPayout = freeEntry ? projectedShare * round.participantCount : round.pot * economy.config.heistPayoutMultiplier;
            description = `Entry closes <t:${Math.floor(state.nextAt / 1000)}:R> · <t:${Math.floor(state.nextAt / 1000)}:T>\n\nPress **${freeEntry ? 'Enter Free Heist' : 'Enter Heist'}** to join this crew. Press **My Entry Status** to privately check whether you are entered.`;
            return {
                embeds: [new Discord.EmbedBuilder().setColor(0x9b1c31).setTitle(title).setDescription(description)
                    .addFields(
                        { name: 'Entry fee', value: freeEntry ? 'FREE' : `${money(round.entry_fee)} ${economy.config.currencyName}`, inline: true },
                        { name: 'Crew entered', value: `${round.participantCount} / ${economy.config.heistMinimumPlayers} minimum`, inline: true },
                        { name: 'Current success chance', value: `${chance}%`, inline: true },
                        { name: 'Current crew pot', value: money(round.pot), inline: true },
                        { name: 'Projected total payout', value: money(projectedPayout), inline: true },
                        { name: 'Reward per member on success', value: money(projectedShare), inline: true },
                    ).setFooter({ text: `Round ${round.round_id.slice(0, 8)} · ${freeEntry ? 'No Blood Money required' : 'No daily wager cap'}` }).setTimestamp()],
                components: [new Discord.ActionRowBuilder().addComponents(
                    new Discord.ButtonBuilder().setCustomId(`econ:heist:join:${round.round_id}`).setLabel(freeEntry ? 'Enter Free Heist' : 'Enter Heist').setEmoji('🔫').setStyle(Discord.ButtonStyle.Danger),
                    new Discord.ButtonBuilder().setCustomId(`econ:heist:status:${round.round_id}`).setLabel('My Entry Status').setStyle(Discord.ButtonStyle.Secondary),
                )],
            };
        }
        const cancelled = round.status === 'cancelled';
        const won = round.success === 1;
        title = cancelled ? '↩️ Heist Cancelled · Entries Refunded' : won ? '💼 Heist Successful' : '🚔 Heist Failed';
        description = `The next crew opens <t:${Math.floor(state.nextAt / 1000)}:R> · <t:${Math.floor(state.nextAt / 1000)}:T>`;
        return {
            embeds: [new Discord.EmbedBuilder().setColor(cancelled ? 0xd29922 : won ? 0x2ea043 : 0x9b1c31).setTitle(title).setDescription(description)
                .addFields(
                    { name: 'Crew size', value: money(round.participantCount), inline: true },
                    { name: 'Success chance', value: `${round.success_chance || 0}%`, inline: true },
                    { name: 'Total payout', value: money(round.payout_total), inline: true },
                ).setFooter({ text: `Round ${round.round_id.slice(0, 8)} · Persistent heist panel` }).setTimestamp()],
            components: [new Discord.ActionRowBuilder().addComponents(
                new Discord.ButtonBuilder().setCustomId(`econ:heist:status:${round.round_id}`).setLabel('My Result').setStyle(Discord.ButtonStyle.Secondary),
            )],
        };
    }

    async function updateHeistPanel(guild) {
        if (!economy.config.heistChannelId) return;
        const state = economy.heistState(guild.id);
        const message = await upsertPanel(guild, economy.config.heistChannelId, 'heist_panel_message', heistPanelPayload(state));
        if (state.phase === 'cooldown' && economy.setting(guild.id, 'heist_last_announced_round') !== state.round.round_id) {
            const outcome = state.round.status === 'cancelled' ? 'cancelled and refunded' : state.round.success ? 'successful' : 'failed';
            await audit(guild, 'Heist result', `Heist ${state.round.round_id.slice(0, 8)} was ${outcome}. Crew: ${state.round.participantCount}. Pot: ${money(state.round.pot)}. Payout: ${money(state.round.payout_total)}.`);
            economy.setSetting(guild.id, 'heist_last_announced_round', state.round.round_id);
        }
        return message;
    }

    async function updatePersistentPanels() {
        for (const guild of client.guilds.cache.values()) {
            await updateLeaderboardPanel(guild).catch(error => console.error(`Leaderboard panel error in ${guild.name}:`, error.message));
            await updateRepLeaderboardPanel(guild).catch(error => console.error(`REP panel error in ${guild.name}:`, error.message));
            await updateHeistPanel(guild).catch(error => console.error(`Heist panel error in ${guild.name}:`, error.message));
        }
    }

    function scheduleHeistBoundaryRefresh() {
        const now = Date.now();
        const hour = 60 * 60 * 1000;
        const hourStart = Math.floor(now / hour) * hour;
        const closeAt = hourStart + (58 * 60000);
        const nextHour = hourStart + hour;
        const target = now < closeAt ? closeAt : nextHour;
        heistBoundaryTimer = setTimeout(async () => {
            for (const guild of client.guilds.cache.values()) {
                await updateHeistPanel(guild).catch(error => console.error(`Heist boundary refresh failed in ${guild.name}:`, error.message));
            }
            scheduleHeistBoundaryRefresh();
        }, Math.max(250, target - now + 250));
    }

    async function editDuelMessage(duel) {
        if (!duel.channel_id || !duel.message_id) return;
        const channel = await client.channels.fetch(duel.channel_id).catch(() => null);
        const challengeMessage = channel?.isTextBased() ? await channel.messages.fetch(duel.message_id).catch(() => null) : null;
        if (challengeMessage) await challengeMessage.edit(duelResultPayload(duel, economy.config.currencyName)).catch(() => {});
    }

    async function handleDuelResponse(message, response) {
        const pending = economy.pendingDuelFor(message.guild.id, message.author.id);
        if (!pending) {
            await message.reply('❌ You do not have a pending duel challenge.');
            return;
        }
        if (pending.channel_id && pending.channel_id !== message.channel.id) {
            await message.reply(`❌ Respond in <#${pending.channel_id}>, where the duel was posted.`);
            return;
        }
        try {
            const result = economy.respondToDuel(message.guild.id, message.author.id, response, message.id);
            await editDuelMessage(result);
            if (result.status === 'complete') {
                await message.reply(`⚔️ Duel accepted. <@${result.winner_id}> won **${money(result.payout)} ${economy.config.currencyName}**.`);
                await audit(message.guild, 'Duel result', `<@${result.challenger_id}> and <@${result.challenged_id}> dueled for ${money(result.wager)} each. Winner: <@${result.winner_id}>.`);
            } else if (result.status === 'denied') {
                await message.reply(`🛑 Duel denied. <@${result.challenger_id}>'s ${money(result.wager)} ${economy.config.currencyName} was refunded.`);
            } else {
                await message.reply(`⌛ That duel expired. <@${result.challenger_id}>'s wager was refunded.`);
            }
        } catch (error) {
            await message.reply(`❌ ${error.message}`);
        }
    }

    client.on('messageCreate', async message => {
        if (!message.guild || message.author.bot) return;
        const repResult = economy.rewardRepMessage(message.guild.id, message.author.id);
        if (repResult) console.log(`⭐ ${message.author.tag} earned 1 REP from text activity.`);
        const duelResponse = /^!(accept|deny)\s*$/i.exec(message.content)?.[1]?.toLowerCase();
        if (duelResponse) {
            await handleDuelResponse(message, duelResponse);
            return;
        }
        if (!eligibleAccount(message.author)) return;
        const result = economy.rewardMessage({
            guildId: message.guild.id, userId: message.author.id, messageId: message.id,
            content: message.content, channelId: message.channel.id,
        });
        if (result) console.log(`🩸 ${message.author.tag} earned ${result.reward} ${economy.config.currencyName} from text activity.`);

        const attachments = [...message.attachments.values()];
        const imageLink = /(https?:\/\/\S+\.(?:png|jpe?g|gif|webp|mp4|mov))(?:\?\S*)?/i.exec(message.content)?.[1];
        if (!attachments.length && !imageLink) return;
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify(attachments.map(item => [item.name, item.size, item.contentType]).sort()) + (imageLink || '')).digest('hex');
        setTimeout(async () => {
            const stillThere = await message.channel.messages.fetch(message.id).catch(() => null);
            if (!stillThere) return;
            const mediaResult = economy.rewardMedia({
                guildId: message.guild.id, userId: message.author.id, messageId: message.id,
                channelId: message.channel.id, fingerprint,
            });
            if (mediaResult) console.log(`🩸 ${message.author.tag} earned ${mediaResult.reward} ${economy.config.currencyName} from media activity.`);
        }, 5 * 60 * 1000);
    });

    client.on('messageDelete', message => {
        if (!message.guild || !message.author || message.author.bot) return;
        const result = economy.reverseDeletedMessage(message.guild.id, message.author.id, message.id);
        if (result?.removed) console.log(`🩸 Reversed ${result.removed} ${economy.config.currencyName} after a rewarded message was deleted.`);
    });

    async function rewardVoice() {
        for (const guild of client.guilds.cache.values()) {
            const afkId = guild.afkChannelId;
            for (const channel of guild.channels.cache.values()) {
                if (!channel.isVoiceBased() || channel.id === afkId || economy.excludedVoiceChannels.has(channel.id)) continue;
                const eligible = channel.members.filter(member => !member.user.bot && !member.voice.selfDeaf && !member.voice.serverDeaf && eligibleAccount(member.user));
                if (eligible.size < 2) continue;
                for (const member of eligible.values()) {
                    const result = economy.rewardVoice(guild.id, member.id, economy.config.voiceIntervalMinutes);
                    if (result) console.log(`🩸 ${member.user.tag} earned ${result.reward} ${economy.config.currencyName} from voice activity.`);
                }
            }
        }
    }

    async function rewardRepVoice() {
        for (const guild of client.guilds.cache.values()) {
            const afkId = guild.afkChannelId;
            for (const channel of guild.channels.cache.values()) {
                if (!channel.isVoiceBased() || channel.id === afkId) continue;
                const eligible = channel.members.filter(member => !member.user.bot);
                if (eligible.size < 2) continue;
                for (const member of eligible.values()) {
                    const result = economy.rewardRepVoice(guild.id, member.id, 1);
                    if (result.reward) console.log(`⭐ ${member.user.tag} earned ${result.reward} REP from voice activity.`);
                }
            }
        }
    }

    async function runMonthlyRollover() {
        for (const guild of client.guilds.cache.values()) {
            const rollover = economy.rolloverMonth(guild.id);
            if (!rollover) continue;
            const archiveId = economy.config.archiveChannelId || '1532792745385529455';
            const channel = await guild.channels.fetch(archiveId).catch(() => null);
            if (!channel?.isTextBased()) {
                console.error(`Blood Money monthly archive channel ${archiveId} is missing or is not a text channel. Archive remains queued.`);
                continue;
            }
            const excluded = await prizeExcludedIds(guild);
            const eligible = rollover.leaders.filter(row => row.score > 0 && !excluded.has(row.user_id));
            const prizeEnabled = prizeEnabledFor(rollover.archivedMonth);
            const lines = [
                `BLOOD MONEY MONTHLY LEADERBOARD — ${rollover.archivedMonth}`,
                '============================================================',
                '',
                ...rollover.leaders.map((row, index) => `${index + 1}. ${row.user_id} — ${money(row.score)} earned — ending balance ${money(row.balance)} — ${row.rank}`),
                '',
                `Members reset: ${rollover.resetMembers}`,
                `Blood Money removed from circulation: ${money(rollover.resetTotal)}`,
                `Archived: ${new Date().toISOString()}`,
            ];
            lines.push('', `Activity earned: ${money(rollover.activity?.earned)}`, `Gambling wagered: ${money(rollover.gambling?.wagered)}`, `Gambling payouts: ${money(rollover.gambling?.payouts)}`);
            if (prizeEnabled) lines.push('', 'PRIZE-ELIGIBLE LEADERS (staff, administrators, owners, bots, and excluded accounts removed)',
                ...(eligible.length ? eligible.map((row, index) => `${index + 1}. ${row.user_id} — ${money(row.score)} earned`) : ['No eligible members.']));
            const attachment = new Discord.AttachmentBuilder(Buffer.from(lines.join('\n'), 'utf8'), {
                name: `blood-money-leaderboard-${rollover.archivedMonth}.txt`,
            });
            const top = rollover.leaders.slice(0, 10).map((row, index) => `**${index + 1}.** <@${row.user_id}> — ${money(row.score)}`).join('\n') || 'No qualifying earnings were recorded.';
            try {
                await channel.send({
                    embeds: [new Discord.EmbedBuilder().setColor(0x9b1c31).setTitle(`🩸 Blood Money Archive · ${rollover.archivedMonth}`)
                        .setDescription(top).addFields(
                            { name: 'Accounts reset', value: money(rollover.resetMembers), inline: true },
                            { name: 'Removed from circulation', value: money(rollover.resetTotal), inline: true },
                        ).setFooter({ text: 'Lifetime statistics and transaction history were preserved.' }).setTimestamp()],
                    files: [attachment],
                });
                if (prizeEnabled) {
                    await channel.send({ content: eligible[0]
                        ? `🎁 Prize month result: <@${eligible[0].user_id}> placed first among eligible members with **${money(eligible[0].score)} ${economy.config.currencyName}**. Staff, administrators, and owners were excluded.`
                        : '🎁 Prize month result: no eligible member recorded earnings.' });
                }
                economy.completeMonthlyArchive(guild.id);
                console.log(`🩸 Archived ${rollover.archivedMonth} Blood Money leaderboard and reset ${rollover.resetMembers} account(s).`);
            } catch (error) {
                console.error(`Blood Money monthly archive failed and remains queued: ${error.message}`);
            }
        }
    }

    async function runWeeklyRollover() {
        for (const guild of client.guilds.cache.values()) {
            const rollover = economy.rolloverWeek(guild.id);
            if (!rollover) continue;
            const channelId = economy.config.archiveChannelId || economy.config.auditChannelId || options.auditChannelId;
            const channel = await guild.channels.fetch(channelId).catch(() => null);
            if (!channel?.isTextBased()) {
                console.error(`Blood Money weekly archive channel ${channelId || '(not set)'} is missing. Archive remains queued.`);
                continue;
            }
            const attachment = new Discord.AttachmentBuilder(Buffer.from(archiveLines(`BLOOD MONEY WEEKLY LEADERBOARD — ${rollover.archivedWeek}`, rollover).join('\n'), 'utf8'), {
                name: `blood-money-weekly-${rollover.archivedWeek}.txt`,
            });
            const top = rollover.leaders.filter(row => row.score > 0).slice(0, 10)
                .map((row, index) => `**${index + 1}.** <@${row.user_id}> — ${money(row.score)}`).join('\n') || 'No qualifying earnings were recorded.';
            try {
                await channel.send({
                    embeds: [new Discord.EmbedBuilder().setColor(0x9b1c31).setTitle(`🩸 Weekly Blood Money Archive · ${rollover.archivedWeek}`)
                        .setDescription(top).setFooter({ text: 'Balances and lifetime statistics were preserved.' }).setTimestamp()],
                    files: [attachment],
                });
                economy.completeWeeklyArchive(guild.id);
            } catch (error) {
                console.error(`Blood Money weekly archive failed and remains queued: ${error.message}`);
            }
        }
    }

    async function runRepRollover() {
        for (const guild of client.guilds.cache.values()) {
            let archive = economy.rolloverRepMonth(guild.id);
            if (!archive) continue;

            if (!archive.announced) {
                const repChannel = await guild.channels.fetch(economy.config.leaderboardChannelId).catch(() => null);
                if (!repChannel?.isTextBased()) {
                    console.error(`Shared leaderboard channel ${economy.config.leaderboardChannelId || '(not set)'} is missing. The REP top-five announcement remains queued.`);
                } else {
                    const topFive = archive.leaders.slice(0, 5);
                    const winners = topFive.length
                        ? topFive.map((row, index) => `**${index + 1}.** <@${row.user_id}> — **${money(row.points)} REP**`).join('\n')
                        : 'No REP was earned during this period.';
                    await repChannel.send({
                        embeds: [new Discord.EmbedBuilder().setColor(0x7c3aed)
                            .setTitle(`⭐ REP Winners · ${archive.archivedMonth}`)
                            .setDescription(winners)
                            .setFooter({ text: 'Monthly REP reset completed at 8:00 AM Eastern.' }).setTimestamp()],
                    });
                    economy.updateRepArchiveStatus(guild.id, 'announcement');
                    console.log(`⭐ Announced the top REP members for ${archive.archivedMonth}.`);
                }
            }

            archive = economy.pendingRepArchive(guild.id);
            if (archive && !archive.logged) {
                const logChannelId = economy.config.auditChannelId || options.auditChannelId;
                const logChannel = await guild.channels.fetch(logChannelId).catch(() => null);
                if (!logChannel?.isTextBased()) {
                    console.error(`Blood Money log channel ${logChannelId || '(not set)'} is missing. The full REP archive remains queued.`);
                } else {
                    const rows = await Promise.all(archive.leaders.map(async (row, index) => {
                        const user = await client.users.fetch(row.user_id).catch(() => null);
                        return `${index + 1}. ${user?.tag || user?.username || 'Unknown user'} (${row.user_id}) — ${row.points} REP`;
                    }));
                    const lines = [
                        `THE COMMISSION REP LEADERBOARD — ${archive.archivedMonth}`,
                        '============================================================',
                        '',
                        ...(rows.length ? rows : ['No REP was earned during this period.']),
                        '',
                        `Accounts tracked: ${archive.memberCount}`,
                        `Reset completed: ${new Date(archive.resetAt).toISOString()}`,
                    ];
                    const attachment = new Discord.AttachmentBuilder(Buffer.from(lines.join('\n'), 'utf8'), {
                        name: `rep-leaderboard-${archive.archivedMonth}.txt`,
                    });
                    await logChannel.send({
                        content: `⭐ Full REP leaderboard archive for **${archive.archivedMonth}**`,
                        files: [attachment],
                    });
                    economy.updateRepArchiveStatus(guild.id, 'log');
                    console.log(`⭐ Saved the full ${archive.archivedMonth} REP leaderboard to the Blood Money log channel.`);
                }
            }
            await updateRepLeaderboardPanel(guild).catch(error => console.error(`REP panel refresh failed in ${guild.name}:`, error.message));
        }
    }

    client.once('ready', async () => {
        await runWeeklyRollover().catch(error => console.error('Economy weekly rollover error:', error));
        await runMonthlyRollover().catch(error => console.error('Economy monthly rollover error:', error));
        await runRepRollover().catch(error => console.error('REP monthly rollover error:', error));
        await updatePersistentPanels().catch(error => console.error('Economy panel startup error:', error));
        scheduleHeistBoundaryRefresh();
        voiceTimer = setInterval(() => rewardVoice().catch(error => console.error('Economy voice reward error:', error)), economy.config.voiceIntervalMinutes * 60000);
        repVoiceTimer = setInterval(() => rewardRepVoice().catch(error => console.error('REP voice reward error:', error)), 60000);
        rolloverTimer = setInterval(async () => {
            await runWeeklyRollover().catch(error => console.error('Economy weekly rollover error:', error));
            await runMonthlyRollover().catch(error => console.error('Economy monthly rollover error:', error));
            await runRepRollover().catch(error => console.error('REP monthly rollover error:', error));
        }, 60000);
        panelTimer = setInterval(() => updatePersistentPanels().catch(error => console.error('Economy panel update error:', error)), 30000);
        pokerTimer = setInterval(async () => {
            const expired = economy.expirePokerGames();
            for (const result of expired) {
                if (!result.channelId || !result.messageId) continue;
                const channel = await client.channels.fetch(result.channelId).catch(() => null);
                const message = channel?.isTextBased() ? await channel.messages.fetch(result.messageId).catch(() => null) : null;
                if (message) await message.edit({
                    content: `${pokerResultText(result, `<@${result.userId}>`, economy.config.currencyName)}\n\n*The 60-second timer expired; all unheld cards were drawn automatically.*`,
                    embeds: [],
                    components: [],
                }).catch(() => {});
            }
            if (expired.length) console.log(`🩸 Completed ${expired.length} timed-out public poker game(s).`);

            const expiredBlackjack = economy.expireBlackjackGames();
            for (const result of expiredBlackjack) {
                if (!result.channel_id || !result.message_id) continue;
                const channel = await client.channels.fetch(result.channel_id).catch(() => null);
                const message = channel?.isTextBased() ? await channel.messages.fetch(result.message_id).catch(() => null) : null;
                if (message) await message.edit(blackjackPayload(result, `<@${result.user_id}>`, economy.config.currencyName, 'The two-minute timer expired, so the hand automatically stood.')).catch(() => {});
            }
            if (expiredBlackjack.length) console.log(`🂡 Completed ${expiredBlackjack.length} timed-out blackjack game(s).`);

            const expiredProgressive = economy.expireProgressiveGames();
            for (const result of expiredProgressive.higherLower) {
                if (!result.channel_id || !result.message_id) continue;
                const channel = await client.channels.fetch(result.channel_id).catch(() => null);
                const message = channel?.isTextBased() ? await channel.messages.fetch(result.message_id).catch(() => null) : null;
                if (message) await message.edit(higherLowerPayload(result, `<@${result.user_id}>`, economy.config.currencyName,
                    result.step ? 'The two-minute timer expired, so your earned multiplier was cashed out automatically.' : 'The two-minute timer expired before the first guess.')).catch(() => {});
            }
            for (const result of expiredProgressive.dragonTower) {
                if (!result.channel_id || !result.message_id) continue;
                const channel = await client.channels.fetch(result.channel_id).catch(() => null);
                const message = channel?.isTextBased() ? await channel.messages.fetch(result.message_id).catch(() => null) : null;
                if (message) await message.edit(dragonTowerPayload(result, `<@${result.user_id}>`, economy.config.currencyName,
                    result.row_number ? 'The two-minute timer expired, so your cleared rows were cashed out automatically.' : 'The two-minute timer expired before the first pick.')).catch(() => {});
            }
            if (expiredProgressive.higherLower.length || expiredProgressive.dragonTower.length) {
                console.log(`🎮 Completed ${expiredProgressive.higherLower.length + expiredProgressive.dragonTower.length} timed-out progressive game(s).`);
            }

            const expiredDuels = economy.expireDuels();
            for (const duel of expiredDuels) await editDuelMessage(duel);
            if (expiredDuels.length) console.log(`⚔️ Refunded ${expiredDuels.length} expired duel challenge(s).`);
        }, 15000);
    });

    async function startGamble(interaction) {
        const game = interaction.customId.split(':').at(-1);
        if (!GAMBLE_GAMES.has(game)) throw new Error('That gambling game is not available.');
        if (economy.config.gamblingChannelId && interaction.channelId !== economy.config.gamblingChannelId) {
            throw new Error(`Play gambling games in <#${economy.config.gamblingChannelId}>.`);
        }
        const amount = modalWager(interaction);
        if (game === 'slots') {
            const symbols = slots.serverSymbols(interaction.guild);
            const result = economy.slots(interaction.guild.id, interaction.user.id, amount, interaction.id, symbols);
            await interaction.reply(slotsPayload(result, interaction.guild, economy.config.currencyName));
            await audit(interaction.guild, 'Slots result', `${interaction.user} wagered ${money(result.wager)} and received ${money(result.payout)} (${result.multiplier}×).`);
            return;
        }
        if (game === 'dice') {
            const result = economy.dice(interaction.guild.id, interaction.user.id, amount, interaction.id);
            await interaction.reply({ embeds: [new Discord.EmbedBuilder().setColor(result.payout ? 0x2ea043 : 0x9b1c31)
                .setTitle(`🎲 Dice · ${result.outcome} · ${result.multiplier}×`)
                .setDescription(result.payout ? `You received **${money(result.payout)} ${economy.config.currencyName}**.` : `The house took **${money(result.wager)} ${economy.config.currencyName}**.`)
                .addFields({ name: 'Outcome chance', value: `${result.odds}%`, inline: true }, { name: 'Balance', value: money(result.balance), inline: true })] });
            await audit(interaction.guild, 'Dice result', `${interaction.user} wagered ${money(result.wager)} and received ${money(result.payout)} (${result.multiplier}×).`);
            return;
        }
        if (game === 'higher-lower') {
            const started = economy.startHigherLower(interaction.guild.id, interaction.user.id, amount, interaction.id);
            await interaction.reply(higherLowerPayload(started, `${interaction.user}`, economy.config.currencyName));
            const message = await interaction.fetchReply();
            economy.attachHigherLowerMessage(started.game_id, interaction.channelId, message.id);
            return;
        }
        if (game === 'dragon-tower') {
            const started = economy.startDragonTower(interaction.guild.id, interaction.user.id, amount, interaction.id);
            await interaction.reply(dragonTowerPayload(started, `${interaction.user}`, economy.config.currencyName));
            const message = await interaction.fetchReply();
            economy.attachDragonTowerMessage(started.game_id, interaction.channelId, message.id);
            return;
        }
        if (game === 'poker') {
            const started = economy.startPoker(interaction.guild.id, interaction.user.id, amount, interaction.id);
            await interaction.reply({ content: pokerTableText(started, `${interaction.user}`, economy.config.currencyName, started), embeds: [], components: pokerComponents(started) });
            const message = await interaction.fetchReply();
            economy.attachPokerMessage(started.gameId, interaction.channelId, message.id);
            return;
        }
        if (game === 'blackjack') {
            const started = economy.startBlackjack(interaction.guild.id, interaction.user.id, amount, interaction.id);
            await interaction.reply(blackjackPayload(started, `${interaction.user}`, economy.config.currencyName));
            const message = await interaction.fetchReply();
            economy.attachBlackjackMessage(started.game_id, interaction.channelId, message.id);
            if (started.status !== 'active') await audit(interaction.guild, 'Blackjack result', `${interaction.user} bet ${money(started.wager)}, finished with ${started.outcome}, and received ${money(started.payout)}.`);
            return;
        }
        const opponentId = duelOpponentId(interaction.fields.getTextInputValue('opponent'));
        if (opponentId === interaction.user.id) throw new Error('You cannot duel yourself.');
        const challenged = await client.users.fetch(opponentId).catch(() => null);
        if (!challenged) throw new Error('I could not find that Discord user.');
        if (challenged.bot) throw new Error('Bots cannot participate in duels.');
        await interaction.guild.members.fetch(opponentId).catch(() => { throw new Error('That user is not a member of this server.'); });
        const duel = economy.createDuel(interaction.guild.id, interaction.user.id, challenged.id, amount, interaction.id);
        await interaction.reply(duelChallengePayload(duel, economy.config.currencyName));
        const message = await interaction.fetchReply();
        economy.attachDuelMessage(duel.duel_id, interaction.channelId, message.id);
        await audit(interaction.guild, 'Duel challenge', `${interaction.user} challenged ${challenged} for ${money(duel.wager)} ${economy.config.currencyName}.`);
    }

    async function handleButton(interaction) {
        if (interaction.isButton?.() && interaction.customId.startsWith('econ:gamble:choose:')) {
            try {
                await interaction.showModal(wagerModal(interaction.customId.split(':').at(-1)));
            } catch (error) {
                if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: `❌ ${error.message}`, ephemeral: true }).catch(() => {});
            }
            return true;
        }
        if (interaction.isModalSubmit?.() && interaction.customId.startsWith('econ:gamble:modal:')) {
            try {
                await startGamble(interaction);
            } catch (error) {
                const payload = { content: `❌ ${error.message}`, ephemeral: true };
                if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {}); else await interaction.reply(payload).catch(() => {});
            }
            return true;
        }
        if (!interaction.isButton() || !interaction.customId.startsWith('econ:')) return false;
        if (interaction.customId === 'econ:leaderboard:balance') {
            const row = economy.publicMember(interaction.guild.id, interaction.user.id);
            await interaction.reply({ content: `🩸 Your balance is **${money(row.balance)} ${economy.config.currencyName}** · ${row.rank}.`, ephemeral: true });
            return true;
        }
        if (interaction.customId === 'econ:leaderboard:refresh') {
            await interaction.deferReply({ ephemeral: true });
            await updateLeaderboardPanel(interaction.guild);
            await interaction.editReply('Leaderboard refreshed.');
            return true;
        }
        if (interaction.customId === 'econ:rep:mine') {
            const row = economy.repMember(interaction.guild.id, interaction.user.id);
            const ranking = row.position ? ` and are ranked **#${row.position}**` : ' and are not ranked yet';
            await interaction.reply({ content: `⭐ You have **${money(row.points)} REP** this month${ranking}.`, ephemeral: true });
            return true;
        }
        if (interaction.customId === 'econ:rep:refresh') {
            await interaction.deferReply({ ephemeral: true });
            await updateRepLeaderboardPanel(interaction.guild);
            await interaction.editReply('REP leaderboard refreshed.');
            return true;
        }
        if (interaction.customId.startsWith('econ:heist:')) {
            const [, , action, roundId] = interaction.customId.split(':');
            if (action === 'status') {
                const status = economy.heistEntryStatus(roundId, interaction.user.id);
                if (!status) await interaction.reply({ content: 'That heist round no longer exists.', ephemeral: true });
                else if (!status.entered) await interaction.reply({ content: `You ${status.round.status === 'signup' ? 'have **not entered** this heist yet.' : 'did not enter this heist.'}`, ephemeral: true });
                else {
                    const result = status.round.status === 'signup'
                        ? status.entry.entry_fee === 0
                            ? `You are **entered in this free heist**. Entry closes <t:${Math.floor(status.round.signup_ends_at / 1000)}:R>.`
                            : `You are **entered** for ${money(status.entry.entry_fee)} ${economy.config.currencyName}. Entry closes <t:${Math.floor(status.round.signup_ends_at / 1000)}:R>.`
                        : status.round.status === 'cancelled'
                            ? status.entry.entry_fee === 0
                                ? 'You entered this free heist. It was cancelled because the minimum crew size was not reached.'
                                : `You entered this heist. It was cancelled and your ${money(status.entry.entry_fee)} entry was refunded.`
                            : `You entered this heist and received **${money(status.entry.payout)} ${economy.config.currencyName}**.`;
                    await interaction.reply({ content: `🔫 ${result}`, ephemeral: true });
                }
                return true;
            }
            if (action === 'join') {
                try {
                    if (!eligibleAccount(interaction.user)) throw new Error(`Your Discord account must be at least ${economy.config.minimumAccountAgeDays} days old.`);
                    const result = economy.joinHeist(interaction.guild.id, interaction.user.id, roundId, interaction.id);
                    if (result.alreadyEntered) await interaction.reply({ content: 'You are already entered in this heist.', ephemeral: true });
                    else {
                        const confirmation = result.round.entry_fee === 0
                            ? '🔫 You entered the **free heist**. No Blood Money was deducted.'
                            : `🔫 You entered the heist for **${money(result.round.entry_fee)} ${economy.config.currencyName}**. Balance: **${money(result.balance)}**.`;
                        await interaction.reply({ content: confirmation, ephemeral: true });
                        await audit(interaction.guild, 'Heist entry', `${interaction.user} entered heist ${roundId.slice(0, 8)} for ${money(result.round.entry_fee)}.`);
                    }
                    await updateHeistPanel(interaction.guild);
                } catch (error) {
                    await interaction.reply({ content: `❌ ${error.message}`, ephemeral: true }).catch(() => {});
                }
                return true;
            }
        }
        if (interaction.customId.startsWith('econ:hilo:')) {
            const [, , gameId, action] = interaction.customId.split(':');
            const game = economy.higherLowerGame(gameId);
            if (!game || game.status !== 'active') {
                await interaction.reply({ content: 'This Higher / Lower game is no longer active.', ephemeral: true });
                return true;
            }
            if (game.user_id !== interaction.user.id) {
                await interaction.reply({ content: 'This is not your Higher / Lower game.', ephemeral: true });
                return true;
            }
            try {
                const result = action === 'cash'
                    ? economy.cashOutHigherLower(gameId, interaction.user.id)
                    : economy.playHigherLower(gameId, interaction.user.id, action);
                await interaction.update(higherLowerPayload(result, `${interaction.user}`, economy.config.currencyName));
                if (result.status !== 'active') {
                    await audit(interaction.guild, 'Higher / Lower result', `${interaction.user} wagered ${money(result.wager)} and received ${money(result.payout)} after ${result.step} correct card(s).`);
                }
            } catch (error) {
                await interaction.reply({ content: `❌ ${error.message}`, ephemeral: true }).catch(() => {});
            }
            return true;
        }
        if (interaction.customId.startsWith('econ:dragon:')) {
            const [, , gameId, action, column] = interaction.customId.split(':');
            const game = economy.dragonTowerGame(gameId);
            if (!game || game.status !== 'active') {
                await interaction.reply({ content: 'This Dragon Tower game is no longer active.', ephemeral: true });
                return true;
            }
            if (game.user_id !== interaction.user.id) {
                await interaction.reply({ content: 'This is not your Dragon Tower game.', ephemeral: true });
                return true;
            }
            try {
                const result = action === 'cash'
                    ? economy.cashOutDragonTower(gameId, interaction.user.id)
                    : action === 'auto'
                        ? economy.autoPickDragonTower(gameId, interaction.user.id)
                        : economy.pickDragonTower(gameId, interaction.user.id, column);
                await interaction.update(dragonTowerPayload(result, `${interaction.user}`, economy.config.currencyName));
                if (result.status !== 'active') {
                    await audit(interaction.guild, 'Dragon Tower result', `${interaction.user} wagered ${money(result.wager)}, cleared ${result.row_number} row(s), and received ${money(result.payout)}.`);
                }
            } catch (error) {
                await interaction.reply({ content: `❌ ${error.message}`, ephemeral: true }).catch(() => {});
            }
            return true;
        }
        if (interaction.customId.startsWith('econ:blackjack:')) {
            const [, , gameId, action] = interaction.customId.split(':');
            const game = economy.blackjackGame(gameId);
            if (!game || game.status !== 'active') {
                await interaction.reply({ content: 'This blackjack game is no longer active.', ephemeral: true });
                return true;
            }
            if (game.user_id !== interaction.user.id) {
                await interaction.reply({ content: 'This is not your blackjack game.', ephemeral: true });
                return true;
            }
            try {
                const result = action === 'hit'
                    ? economy.hitBlackjack(gameId, interaction.user.id)
                    : action === 'double'
                        ? economy.doubleBlackjack(gameId, interaction.user.id, interaction.id)
                        : action === 'split'
                            ? economy.splitBlackjack(gameId, interaction.user.id, interaction.id)
                        : economy.standBlackjack(gameId, interaction.user.id);
                await interaction.update(blackjackPayload(result, `${interaction.user}`, economy.config.currencyName));
                if (result.status !== 'active') {
                    await audit(interaction.guild, 'Blackjack result', `${interaction.user} bet ${money(result.wager)}, finished with ${result.outcome}, and received ${money(result.payout)}.`);
                }
            } catch (error) {
                await interaction.reply({ content: `❌ ${error.message}`, ephemeral: true }).catch(() => {});
            }
            return true;
        }
        if (!interaction.customId.startsWith('econ:poker:')) return false;
        const [, , gameId, action, index] = interaction.customId.split(':');
        const game = economy.pokerGame(gameId);
        if (!game || game.status !== 'active') {
            await interaction.reply({ content: 'This poker game is no longer active.', ephemeral: true });
            return true;
        }
        if (game.user_id !== interaction.user.id) {
            await interaction.reply({ content: 'This is not your poker game.', ephemeral: true });
            return true;
        }
        if (action === 'hold') {
            const updated = economy.togglePokerHold(gameId, interaction.user.id, index);
            await interaction.update({
                content: pokerTableText(updated, `${interaction.user}`, economy.config.currencyName),
                embeds: [],
                components: pokerComponents(updated),
            });
            return true;
        }
        if (action === 'draw') {
            const result = economy.drawPoker(gameId, interaction.user.id);
            await interaction.update({
                content: pokerResultText(result, `${interaction.user}`, economy.config.currencyName),
                embeds: [],
                components: [],
            });
            await audit(interaction.guild, 'Poker result', `${interaction.user} wagered ${money(result.wager)} and received ${money(result.payout)} (${result.hand}).`);
            return true;
        }
        return false;
    }

    async function handleAdmin(interaction) {
        const action = interaction.options.getSubcommand();
        if (!canAdministerEconomy(interaction.member, action, options.staffRoleIds || [])) {
            await interaction.reply({ content: STAFF_BALANCE_ACTIONS.has(action)
                ? 'A configured staff role or Administrator permission is required to edit Blood Money balances.'
                : 'Administrator permission is required for this economy action.', ephemeral: true });
            return;
        }
        if (action === 'give-all') {
            const amount = interaction.options.getInteger('amount', true);
            await interaction.deferReply({ ephemeral: true });
            const members = await interaction.guild.members.fetch();
            const userIds = members.filter(member => !member.user.bot).map(member => member.id);
            const preview = economy.previewBulkGrant(interaction.guild.id, userIds, amount);
            const batchId = crypto.randomUUID();
            const result = economy.executeBulkGrant(interaction.guild.id, preview.userIds, preview.amountPerMember, batchId);
            await audit(interaction.guild, 'Server-wide Blood Money grant', `${interaction.user} added **${money(result.amountPerMember)} ${economy.config.currencyName}** to **${money(result.affectedMembers)} human members**. Total created: **${money(result.totalGrant)}**. Batch: \`${batchId}\`. Bots were excluded.`);
            await interaction.editReply(`✅ Gave **${money(result.amountPerMember)} ${economy.config.currencyName}** to **${money(result.affectedMembers)} human members**. Total created: **${money(result.totalGrant)}**. Bots were excluded.`);
            return;
        }
        if (action === 'settings') {
            const c = economy.config;
            await interaction.reply({ content: `🩸 **Blood Money settings**\nText: ${c.messageRewardMin}-${c.messageRewardMax}, ${c.messageChance}% chance, ${c.messageCooldownSeconds}s cooldown, ${c.messageDailyCap}/day\nMedia: ${c.mediaRewardMin}-${c.mediaRewardMax}, ${c.mediaDailyCap}/day\nVoice: ${c.voiceRewardMin}-${c.voiceRewardMax} every ${c.voiceIntervalMinutes}m, ${c.voiceDailyCap}/day\nDaily: ${c.dailyBase} base, ${c.dailyStreakMaximum} maximum\nGambling: **${money(c.gamblingHourlyWagerCap)} ${c.currencyName} wagered per rolling hour** across all games. No separate per-game maximums.\nDice: ${DICE_ODDS_TEXT}. RTP ${(diceExpectedReturn() * 100).toFixed(1)}%; house edge ${(diceHouseEdge() * 100).toFixed(1)}%.\nHigher / Lower: ${HIGHER_LOWER_MULTIPLIERS.join('× · ')}× ladder. RTP 85%; house edge 15%.\nDragon Tower: 4×8; rows 1–5 have 3 eggs, rows 6–8 have 1 egg. Cash out after any cleared row. RTP 85%; house edge 15%.`, ephemeral: true });
            return;
        }
        if (action === 'disable-gambling' || action === 'enable-gambling') {
            economy.config.gamblingEnabled = action === 'enable-gambling';
            await interaction.reply({ content: `Gambling is now ${economy.config.gamblingEnabled ? 'enabled' : 'disabled'}.`, ephemeral: true });
            await audit(interaction.guild, 'Gambling setting changed', `${interaction.user} ${economy.config.gamblingEnabled ? 'enabled' : 'disabled'} gambling.`);
            return;
        }
        if (action === 'exclude-channel' || action === 'include-channel') {
            const channel = interaction.options.getChannel('channel', true);
            if (action === 'exclude-channel') economy.excludedChannels.add(channel.id); else economy.excludedChannels.delete(channel.id);
            await interaction.reply({ content: `${channel} is now ${action === 'exclude-channel' ? 'excluded from' : 'included in'} text rewards until changed in the desktop settings.`, ephemeral: true });
            await audit(interaction.guild, 'Economy channel changed', `${interaction.user} used ${action} for ${channel}.`);
            return;
        }
        const user = interaction.options.getUser('user', true);
        if (action === 'audit') {
            const rows = economy.audit(interaction.guild.id, user.id, 15);
            const text = rows.length ? rows.map(row => `<t:${Math.floor(row.created_at / 1000)}:R> ${row.type}: ${row.amount >= 0 ? '+' : ''}${money(row.amount)} → ${money(row.balance_after)}`).join('\n') : 'No transactions recorded.';
            await interaction.reply({ content: `🩸 **Audit for ${user.tag}**\n${text}`, ephemeral: true });
            return;
        }
        const amount = interaction.options.getInteger('amount') || 0;
        const member = economy.admin(interaction.guild.id, action, user.id, amount, interaction.id);
        await interaction.reply({ content: `✅ ${action} completed for ${user.tag}. Balance: ${money(member.balance)} ${economy.config.currencyName}. Frozen: ${member.frozen ? 'yes' : 'no'}.`, ephemeral: true });
        await audit(interaction.guild, 'Economy administration', `${interaction.user} used **${action}** on ${user} ${amount ? `for ${money(amount)}` : ''}. New balance: ${money(member.balance)}.`);
    }

    async function handleCommand(interaction) {
        if (!interaction.isChatInputCommand()) return false;
        const name = interaction.commandName;
        if (!['balance','leaderboard','daily','economy-stats','pay','gamble','eco'].includes(name)) return false;
        try {
            if (name === 'gamble') {
                if (economy.config.gamblingChannelId && interaction.channelId !== economy.config.gamblingChannelId) {
                    throw new Error(`Play gambling games in <#${economy.config.gamblingChannelId}>.`);
                }
                await interaction.reply(gambleMenuPayload(economy.config.currencyName));
            } else if (name === 'eco') {
                await handleAdmin(interaction);
            } else if (name === 'balance') {
                const user = interaction.options.getUser('user') || interaction.user;
                const row = economy.publicMember(interaction.guild.id, user.id);
                await interaction.reply({ embeds: [new Discord.EmbedBuilder().setColor(0x9b1c31).setTitle(`🩸 ${user.username}'s Blood Money`)
                    .setThumbnail(user.displayAvatarURL()).addFields(
                        { name: 'Balance', value: money(row.balance), inline: true }, { name: 'Rank', value: row.rank, inline: true },
                        { name: 'Lifetime earned', value: money(row.lifetime_earned), inline: true }, { name: 'Lifetime spent', value: money(row.lifetime_spent), inline: true },
                        { name: 'Gambling wins / losses', value: `${row.gambling_wins} / ${row.gambling_losses}`, inline: true }, { name: 'Voice time', value: `${money(row.voice_minutes)} minutes`, inline: true },
                    )] });
            } else if (name === 'daily') {
                const result = economy.claimDaily(interaction.guild.id, interaction.user.id, interaction.id);
                if (result.cooldown) await interaction.reply({ content: `Your next daily collection is available in ${duration(result.cooldown)}.`, ephemeral: true });
                else await interaction.reply({ content: `🩸 You collected **${money(result.reward)} ${economy.config.currencyName}**. Streak: **${result.streak}**. Balance: **${money(result.balance)}**.` });
            } else if (name === 'leaderboard') {
                const type = interaction.options.getString('type') || 'balance';
                const rows = type === 'rep' ? economy.repLeaderboard(interaction.guild.id, 10) : economy.leaderboard(interaction.guild.id, type, 10);
                const lines = await Promise.all(rows.map(async (row, index) => {
                    const user = await client.users.fetch(row.user_id).catch(() => null);
                    return type === 'rep'
                        ? `**${index + 1}.** ${user?.username || row.user_id} — **${money(row.points)} REP**`
                        : `**${index + 1}.** ${user?.username || row.user_id} — ${money(row.score)} · ${row.rank}`;
                }));
                const title = type === 'rep' ? '⭐ Monthly REP Leaderboard' : `🩸 Blood Money Leaderboard · ${type}`;
                await interaction.reply({ embeds: [new Discord.EmbedBuilder().setColor(type === 'rep' ? 0x7c3aed : 0x9b1c31).setTitle(title).setDescription(lines.join('\n') || 'No qualifying activity yet.')] });
            } else if (name === 'economy-stats') {
                const stats = economy.stats(interaction.guild.id);
                await interaction.reply({ embeds: [new Discord.EmbedBuilder().setColor(0x9b1c31).setTitle('🩸 Blood Money Economy')
                    .addFields(
                        { name: 'Members', value: money(stats.members), inline: true }, { name: 'In circulation', value: money(stats.circulation), inline: true },
                        { name: 'Richest balance', value: money(stats.richest), inline: true }, { name: 'Lifetime wagered', value: money(stats.wagered), inline: true },
                        { name: 'Transactions', value: money(stats.transactions), inline: true }, { name: 'Active poker games', value: money(stats.activePoker), inline: true },
                        { name: 'Active blackjack', value: money(stats.activeBlackjack), inline: true }, { name: 'Active Higher / Lower', value: money(stats.activeHigherLower), inline: true },
                        { name: 'Active Dragon Tower', value: money(stats.activeDragonTower), inline: true }, { name: 'Pending duels', value: money(stats.pendingDuels), inline: true },
                    )] });
            } else if (name === 'pay') {
                const user = interaction.options.getUser('user', true);
                const amount = interaction.options.getInteger('amount', true);
                if (user.bot) throw new Error('Bots cannot receive Blood Money.');
                const sender = await interaction.guild.members.fetch(interaction.user.id);
                const receiver = await interaction.guild.members.fetch(user.id);
                const minimumMs = economy.config.minimumMembershipDays * 86400000;
                if (Date.now() - sender.joinedTimestamp < minimumMs || Date.now() - receiver.joinedTimestamp < minimumMs) throw new Error(`Both members must be in the server for ${economy.config.minimumMembershipDays} days.`);
                const result = economy.pay(interaction.guild.id, interaction.user.id, user.id, amount, interaction.id);
                await interaction.reply({ content: `🩸 ${interaction.user} paid ${user} **${money(result.amount)} ${economy.config.currencyName}**. Your balance: **${money(result.senderBalance)}**.` });
                await audit(interaction.guild, 'Blood Money transfer', `${interaction.user} paid ${user} ${money(result.amount)}. Sender balance: ${money(result.senderBalance)}.`);
            } else if (name === 'dice') {
                if (economy.config.gamblingChannelId && interaction.channelId !== economy.config.gamblingChannelId) {
                    throw new Error(`Use gambling commands in <#${economy.config.gamblingChannelId}>.`);
                }
                const result = economy.dice(interaction.guild.id, interaction.user.id, interaction.options.getInteger('amount', true), interaction.id);
                await interaction.reply({ embeds: [new Discord.EmbedBuilder().setColor(result.payout ? 0x2ea043 : 0x9b1c31).setTitle(`🎲 Dice · ${result.outcome} · ${result.multiplier}×`)
                    .setDescription(result.payout ? `You received **${money(result.payout)} ${economy.config.currencyName}**.` : `The house took **${money(result.wager)} ${economy.config.currencyName}**.`)
                    .addFields(
                        { name: 'Outcome chance', value: `${result.odds}%`, inline: true },
                        { name: 'Balance', value: money(result.balance), inline: true },
                    )] });
                await audit(interaction.guild, 'Dice result', `${interaction.user} wagered ${money(result.wager)} and received ${money(result.payout)} (${result.multiplier}×).`);
            } else if (name === 'higher-lower') {
                if (economy.config.gamblingChannelId && interaction.channelId !== economy.config.gamblingChannelId) {
                    throw new Error(`Play Higher / Lower in <#${economy.config.gamblingChannelId}>.`);
                }
                const game = economy.startHigherLower(interaction.guild.id, interaction.user.id, interaction.options.getInteger('amount', true), interaction.id);
                await interaction.reply(higherLowerPayload(game, `${interaction.user}`, economy.config.currencyName));
                const gameMessage = await interaction.fetchReply();
                economy.attachHigherLowerMessage(game.game_id, interaction.channelId, gameMessage.id);
            } else if (name === 'dragon-tower') {
                if (economy.config.gamblingChannelId && interaction.channelId !== economy.config.gamblingChannelId) {
                    throw new Error(`Play Dragon Tower in <#${economy.config.gamblingChannelId}>.`);
                }
                const game = economy.startDragonTower(interaction.guild.id, interaction.user.id, interaction.options.getInteger('amount', true), interaction.id);
                await interaction.reply(dragonTowerPayload(game, `${interaction.user}`, economy.config.currencyName));
                const gameMessage = await interaction.fetchReply();
                economy.attachDragonTowerMessage(game.game_id, interaction.channelId, gameMessage.id);
            } else if (name === 'poker') {
                if (economy.config.gamblingChannelId && interaction.channelId !== economy.config.gamblingChannelId) {
                    throw new Error(`Play public poker in <#${economy.config.gamblingChannelId}>.`);
                }
                const game = economy.startPoker(interaction.guild.id, interaction.user.id, interaction.options.getInteger('amount', true), interaction.id);
                await interaction.reply({
                    content: pokerTableText(game, `${interaction.user}`, economy.config.currencyName, game),
                    embeds: [],
                    components: pokerComponents(game),
                });
                const tableMessage = await interaction.fetchReply();
                economy.attachPokerMessage(game.gameId, interaction.channelId, tableMessage.id);
            } else if (name === 'blackjack') {
                if (economy.config.gamblingChannelId && interaction.channelId !== economy.config.gamblingChannelId) {
                    throw new Error(`Play blackjack in <#${economy.config.gamblingChannelId}>.`);
                }
                const game = economy.startBlackjack(interaction.guild.id, interaction.user.id, interaction.options.getInteger('amount', true), interaction.id);
                await interaction.reply(blackjackPayload(game, `${interaction.user}`, economy.config.currencyName));
                const gameMessage = await interaction.fetchReply();
                economy.attachBlackjackMessage(game.game_id, interaction.channelId, gameMessage.id);
                if (game.status !== 'active') await audit(interaction.guild, 'Blackjack result', `${interaction.user} bet ${money(game.wager)}, finished with ${game.outcome}, and received ${money(game.payout)}.`);
            } else if (name === 'duel') {
                if (economy.config.gamblingChannelId && interaction.channelId !== economy.config.gamblingChannelId) {
                    throw new Error(`Start duels in <#${economy.config.gamblingChannelId}>.`);
                }
                const challenged = interaction.options.getUser('user', true);
                if (challenged.bot) throw new Error('Bots cannot participate in duels.');
                const duel = economy.createDuel(interaction.guild.id, interaction.user.id, challenged.id, interaction.options.getInteger('amount', true), interaction.id);
                await interaction.reply(duelChallengePayload(duel, economy.config.currencyName));
                const challengeMessage = await interaction.fetchReply();
                economy.attachDuelMessage(duel.duel_id, interaction.channelId, challengeMessage.id);
                await audit(interaction.guild, 'Duel challenge', `${interaction.user} challenged ${challenged} for ${money(duel.wager)} ${economy.config.currencyName}.`);
            }
        } catch (error) {
            const payload = { content: `❌ ${error.message}`, ephemeral: true };
            if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {}); else await interaction.reply(payload).catch(() => {});
        }
        return true;
    }

    function stop() {
        if (voiceTimer) clearInterval(voiceTimer);
        if (repVoiceTimer) clearInterval(repVoiceTimer);
        if (pokerTimer) clearInterval(pokerTimer);
        if (rolloverTimer) clearInterval(rolloverTimer);
        if (panelTimer) clearInterval(panelTimer);
        if (heistBoundaryTimer) clearTimeout(heistBoundaryTimer);
        economy.close();
    }

    async function pushHeistPanel(guildId, channelId = '') {
        if (channelId) {
            if (!/^\d{17,20}$/.test(String(channelId))) throw new Error('The Persistent heist channel ID is invalid.');
            economy.config.heistChannelId = String(channelId);
        }
        if (!economy.config.heistChannelId) throw new Error('Set and save the Persistent heist channel ID first.');
        const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
        const message = await updateHeistPanel(guild);
        if (!message) throw new Error('The heist channel is missing or is not a text channel.');
        return { guildId: guild.id, channelId: economy.config.heistChannelId, messageId: message.id };
    }

    async function previewReset(guildId, action, userId = '') {
        const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
        const preview = economy.previewEconomyReset(guild.id, String(action || ''), String(userId || ''));
        const token = crypto.randomUUID();
        const expiresAt = Date.now() + (5 * 60 * 1000);
        resetPreviews.set(token, { guildId: guild.id, action: String(action), userId: String(userId || ''), preview, expiresAt });
        for (const [key, value] of resetPreviews) if (value.expiresAt < Date.now()) resetPreviews.delete(key);
        const display = Array.isArray(preview.leaders)
            ? { ...preview, leaders: preview.leaders.filter(row => row.score > 0).slice(0, 10), totalLeaderboardRows: preview.leaders.filter(row => row.score > 0).length }
            : preview;
        return { token, expiresAt, preview: display };
    }

    async function executeReset(guildId, token) {
        const pending = resetPreviews.get(String(token || ''));
        if (!pending || pending.guildId !== guildId) throw new Error('That reset preview is invalid. Create a new preview first.');
        if (pending.expiresAt < Date.now()) {
            resetPreviews.delete(String(token));
            throw new Error('That reset preview expired. Create a new preview first.');
        }
        const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
        if (['weekly-rankings', 'monthly-rankings'].includes(pending.action)) {
            await archiveResetPreview(guild, pending.preview, pending.action.replace('-', ' '));
        }
        const result = economy.executeEconomyReset(guild.id, pending.action, pending.userId);
        resetPreviews.delete(String(token));
        await updateLeaderboardPanel(guild).catch(() => {});
        await updateHeistPanel(guild).catch(() => {});
        const target = pending.userId ? ` Target member: ${pending.userId}.` : '';
        await audit(guild, 'Confirmed Blood Money reset', `Desktop administrator confirmed **${pending.action}**. A preview was required.${target} Affected members: ${money(result.affectedMembers || result.members || 0)}. Lifetime statistics were preserved.`);
        return { ...result, guildId: guild.id };
    }

    async function previewBulkGrant(guildId, amount) {
        const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
        const members = await guild.members.fetch();
        const userIds = members.filter(member => !member.user.bot).map(member => member.id);
        const preview = economy.previewBulkGrant(guild.id, userIds, amount);
        const token = crypto.randomUUID();
        const expiresAt = Date.now() + (5 * 60 * 1000);
        bulkGrantPreviews.set(token, { guildId: guild.id, userIds: preview.userIds, amount: preview.amountPerMember, preview, expiresAt });
        for (const [key, value] of bulkGrantPreviews) if (value.expiresAt < Date.now()) bulkGrantPreviews.delete(key);
        return { token, expiresAt, preview: { ...preview, userIds: undefined } };
    }

    async function executeBulkGrant(guildId, token) {
        const pending = bulkGrantPreviews.get(String(token || ''));
        if (!pending || pending.guildId !== guildId) throw new Error('That bulk-grant preview is invalid. Create a new preview first.');
        if (pending.expiresAt < Date.now()) {
            bulkGrantPreviews.delete(String(token));
            throw new Error('That bulk-grant preview expired. Create a new preview first.');
        }
        const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
        const batchId = crypto.randomUUID();
        const result = economy.executeBulkGrant(guild.id, pending.userIds, pending.amount, batchId);
        bulkGrantPreviews.delete(String(token));
        await updateLeaderboardPanel(guild).catch(() => {});
        await audit(guild, 'Confirmed server-wide Blood Money grant', `Desktop administrator added **${money(result.amountPerMember)} ${economy.config.currencyName}** to **${money(result.affectedMembers)} human members**. Total created: **${money(result.totalGrant)}**. Batch: \`${batchId}\`. Bots were excluded.`);
        return { ...result, userIds: undefined, guildId: guild.id };
    }

    return { handleButton, handleCommand, audit, rewardVoice, updateHeistPanel, pushHeistPanel, previewReset, executeReset, previewBulkGrant, executeBulkGrant, stop };
}

module.exports = { economyCommandData, createEconomyIntegration, pokerComponents, canAdministerEconomy, gambleMenuPayload, wagerModal };
