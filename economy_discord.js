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
    .map(outcome => `${outcome.multiplier}Ã— at ${outcome.weight / 100}%`)
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
    const menu = new Discord.StringSelectMenuBuilder()
        .setCustomId('econ:gamble:menu')
        .setPlaceholder('Choose a game')
        .addOptions(
            { label: 'Slots', value: 'slots', description: 'Spin the 3Ã—3 Commission slot machine', emoji: 'ğŸ°' },
            { label: 'Dice', value: 'dice', description: 'Roll for weighted multipliers', emoji: 'ğŸ²' },
            { label: 'Higher / Lower', value: 'higher-lower', description: 'Climb the card multiplier ladder', emoji: 'ğŸƒ' },
            { label: 'Dragon Tower', value: 'dragon-tower', description: 'Climb eight rows and cash out', emoji: 'ğŸ‰' },
            { label: 'Poker', value: 'poker', description: 'Play one-draw video poker', emoji: 'â™ ï¸' },
            { label: 'Blackjack', value: 'blackjack', description: 'Play public blackjack', emoji: 'ğŸ‚¡' },
            { label: 'Duel', value: 'duel', description: 'Challenge another member 50/50', emoji: 'âš”ï¸' },
        );
    return {
        embeds: [new Discord.EmbedBuilder().setColor(0x9b1c31)
            .setTitle('ğŸ² The Commission â€” Gambling')
            .setDescription(`Choose a game below, then enter your wager in ${currencyName}.`)
            .addFields(
                { name: 'Casino', value: 'Slots Â· Dice Â· Higher / Lower Â· Dragon Tower Â· Poker Â· Blackjack' },
                { name: 'Player vs Player', value: 'Duel Â· 50/50 Â· no house fee' },
            ).setFooter({ text: 'One command. Every game.' })],
        components: [new Discord.ActionRowBuilder().addComponents(menu)],
        ephemeral: true,
    };
}

function wagerModal(game) {
    const labels = { slots: 'Slots', dice: 'Dice', 'higher-lower': 'Higher / Lower', 'dragon-tower': 'Dragon Tower', poker: 'Poker', blackjack: 'Blackjack', duel: 'Duel' };
    if (!GAMBLE_GAMES.has(game)) throw new Error('That gambling game is not available.');
    const modal = new Discord.ModalBuilder().setCustomId(`econ:gamble:modal:${game}`).setTitle(`${labels[game]} â€” Wager`);
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
    const paytable = symbols.map(symbol => `${symbol.render} **${symbol.multiplier}Ã—**`).join(' Â· ');
    const wins = result.wins.length
        ? result.wins.map(win => `Line ${win.line}: ${win.symbol.render} ${win.symbol.render} ${win.symbol.render} â†’ **${win.multiplier}Ã—**`).join('\n')
        : 'No matching payline this spin.';
    return { embeds: [new Discord.EmbedBuilder().setColor(result.payout > 0 ? 0x2ea043 : 0x9b1c31)
        .setTitle('ğŸ° The Commission â€” 3Ã—3 Slots').setDescription(`${board}\n\n${wins}`).addFields(
            { name: 'Wager', value: `${money(result.wager)} ${currencyName}`, inline: true },
            { name: 'Total multiplier', value: `${result.multiplier}Ã—`, inline: true },
            { name: 'Payout', value: `${money(result.payout)} ${currencyName}`, inline: true },
            { name: 'Balance', value: `${money(result.balance)} ${currencyName}`, inline: true },
            { name: 'Paytable Â· 3 matching on any line', value: paytable },
        ).setFooter({ text: '8 paylines Â· winning lines stack' }).setTimestamp()] };
}

function higherLowerPayload(game, userMention, currencyName, note = '') {
    const active = game.status === 'active';
    const currentMultiplier = game.step > 0 ? HIGHER_LOWER_MULTIPLIERS[game.step - 1] : 0;
    const nextMultiplier = active ? HIGHER_LOWER_MULTIPLIERS[game.step] : null;
    const last = game.history?.at(-1);
    const description = active
        ? `${userMention}, is the hidden card **Higher** or **Lower** than **${game.current_card}**?${last?.success ? `\n\nâœ… ${last.reference} â†’ ${last.revealed} was correct.` : ''}`
        : game.status === 'lost'
            ? `${userMention} guessed **${last?.direction || 'incorrectly'}**: ${last?.reference || '?'} â†’ ${last?.revealed || '?'}. The wager was lost.`
            : `${userMention} cashed out the card ladder${game.status === 'completed' ? ' at the 25Ã— summit' : ''}.`;
    const fields = [
        { name: 'Wager', value: `${money(game.wager)} ${currencyName}`, inline: true },
        { name: 'Correct cards', value: String(game.step), inline: true },
    ];
    if (active) fields.push(
        { name: 'Current cash-out', value: game.step ? `${currentMultiplier}Ã—` : 'Locked', inline: true },
        { name: 'Next win', value: `${nextMultiplier}Ã— Â· ${(higherLowerSuccessProbability(game.step) * 100).toFixed(2)}%`, inline: true },
    );
    else fields.push(
        { name: 'Payout', value: `${money(game.payout)} ${currencyName}`, inline: true },
        { name: 'Balance', value: `${money(game.balance)} ${currencyName}`, inline: true },
    );
    const components = active ? [new Discord.ActionRowBuilder().addComponents(
        new Discord.ButtonBuilder().setCustomId(`econ:hilo:${game.game_id}:higher`).setLabel('Higher').setEmoji('â¬†ï¸').setStyle(Discord.ButtonStyle.Success),
        new Discord.ButtonBuilder().setCustomId(`econ:hilo:${game.game_id}:lower`).setLabel('Lower').setEmoji('â¬‡ï¸').setStyle(Discord.ButtonStyle.Danger),
        new Discord.ButtonBuilder().setCustomId(`econ:hilo:${game.game_id}:cash`).setLabel(game.step ? `Cash Out ${currentMultiplier}Ã—` : 'Cash Out').setEmoji('ğŸ’°').setStyle(Discord.ButtonStyle.Primary).setDisabled(game.step < 1),
    )] : [];
    return {
        embeds: [new Discord.EmbedBuilder().setColor(active ? 0x7c3aed : game.status === 'lost' ? 0x9b1c31 : 0x2ea043)
            .setTitle('ğŸƒ Higher / Lower Cards').setDescription(`${description}${note ? `\n\n*${note}*` : ''}`).addFields(fields)
            .setFooter({ text: '85% RTP Â· 15% house edge Â· ties lose Â· inactivity cashes out earned progress' }).setTimestamp()],
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
            tiles = Array.from({ length: DRAGON_TOWER_COLUMNS }, (_, column) => traps.includes(column) ? 'ğŸ”¥' : 'ğŸ¥š');
            if (played) tiles[played.selected] = played.success ? 'ğŸ‰' : 'ğŸ’¥';
        } else if (row === game.row_number) tiles = Array(DRAGON_TOWER_COLUMNS).fill('â“');
        else tiles = Array(DRAGON_TOWER_COLUMNS).fill('â¬›');
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
        { naÛnüêÚ$z{-®éÜj×’¢V6öæö×’æÆVFW&&ö&B†–çFW&7F–öâæwV–ÆBæ–BÂG—RÂ“°¢6öç7BÆ–æW2Òv—B&öÖ—6RæÆÂ‡&÷w2æÖ†7–æ2‡&÷rÂ–æFW‚’Óâ°¢6öç7BW6W"Òv—B6Æ–VçBçW6W'2æfWF6‚‡&÷rçW6W%ö–B’æ6F6‚‚‚’ÓâçVÆÂ“°¢&WGW&âG—RÓÓÒw&Wp¢ò¢¢G¶–æFW‚²Òâ¢¢G·W6W#òçW6W&æÖRÇÂ&÷rçW6W%ö–GÒ(	B¢¢G¶ÖöæW’‡&÷rçö–çG2—Ò$U¢¦ ¢¢¢¢G¶–æFW‚²Òâ¢¢G·W6W#òçW6W&æÖRÇÂ&÷rçW6W%ö–GÒ(	BG¶ÖöæW’‡&÷rç66÷&R—Ò+rG·&÷rç&æ·Ö°¢Ò’“°¢6öç7BF—FÆRÒG—RÓÓÒw&Wrò~*ÙÖöçF†Ç’$UÆVFW&&ö&Br¢	ú›‚&ÆööBÖöæW’ÆVFW&&ö&B+rG·G—WÖ°¢v—B–çFW&7F–öâç&WÇ’‡²VÖ&VG3¢¶æWrF—66÷&BäVÖ&VD'V–ÆFW"‚’ç6WD6öÆ÷"‡G—RÓÓÒw&Wròƒv36VB¢ƒ–#33’ç6WEF—FÆR‡F—FÆR’ç6WDFW67&—F–öâ†Æ–æW2æ¦ö–â‚uÆâr’ÇÂtæòVÆ–g––ær7F—f—G’–WBâr•ÒÒ“°¢ÒVÇ6R–b†æÖRÓÓÒvV6öæö×’×7FG2r’°¢6öç7B7FG2ÒV6öæö×’ç7FG2†–çFW&7F–öâæwV–ÆBæ–B“°¢v—B–çFW&7F–öâç&WÇ’‡²VÖ&VG3¢¶æWrF—66÷&BäVÖ&VD'V–ÆFW"‚’ç6WD6öÆ÷"ƒƒ–#33’ç6WEF—FÆR‚	ú›‚&ÆööBÖöæW’V6öæö×’r¢æFDf–VÆG2€¢²æÖS¢tÖVÖ&W'2rÂfÇVS¢ÖöæW’‡7FG2æÖVÖ&W'2’Â–æÆ–æS¢G'VRÒÂ²æÖS¢t–â6—&7VÆF–öârÂfÇVS¢ÖöæW’‡7FG2æ6—&7VÆF–öâ’Â–æÆ–æS¢G'VRÒÀ¢²æÖS¢u&–6†W7B&Ææ6RrÂfÇVS¢ÖöæW’‡7FG2ç&–6†W7B’Â–æÆ–æS¢G'VRÒÂ²æÖS¢tÆ–fWF–ÖRvvW&VBrÂfÇVS¢ÖöæW’‡7FG2çvvW&VB’Â–æÆ–æS¢G'VRÒÀ¢²æÖS¢uG&ç67F–öç2rÂfÇVS¢ÖöæW’‡7FG2çG&ç67F–öç2’Â–æÆ–æS¢G'VRÒÂ²æÖS¢t7F—fRö¶W"vÖW2rÂfÇVS¢ÖöæW’‡7FG2æ7F—fUö¶W"’Â–æÆ–æS¢G'VRÒÀ¢²æÖS¢t7F—fR&Æ6¶¦6²rÂfÇVS¢ÖöæW’‡7FG2æ7F—fT&Æ6¶¦6²’Â–æÆ–æS¢G'VRÒÂ²æÖS¢t7F—fR†–v†W"òÆ÷vW"rÂfÇVS¢ÖöæW’‡7FG2æ7F—fT†–v†W$Æ÷vW"’Â–æÆ–æS¢G'VRÒÀ¢²æÖS¢t7F—fRG&vöâF÷vW"rÂfÇVS¢ÖöæW’‡7FG2æ7F—fTG&vöåF÷vW"’Â–æÆ–æS¢G'VRÒÂ²æÖS¢uVæF–ærGVVÇ2rÂfÇVS¢ÖöæW’‡7FG2çVæF–ætGVVÇ2’Â–æÆ–æS¢G'VRÒÀ¢•ÒÒ“°¢ÒVÇ6R–b†æÖRÓÓÒw’r’°¢6öç7BW6W"Ò–çFW&7F–öâæ÷F–öç2ævWEW6W"‚wW6W"rÂG'VR“°¢6öç7BÖ÷VçBÒ–çFW&7F–öâæ÷F–öç2ævWD–çFVvW"‚vÖ÷VçBrÂG'VR“°¢–b‡W6W"æ&÷B’F‡&÷ræWrW'&÷"‚t&÷G26ææ÷B&V6V—fR&ÆööBÖöæW’âr“°¢6öç7B6VæFW"Òv—B–çFW&7F–öâæwV–ÆBæÖVÖ&W'2æfWF6‚†–çFW&7F–öâçW6W"æ–B“°¢6öç7B&V6V—fW"Òv—B–çFW&7F–öâæwV–ÆBæÖVÖ&W'2æfWF6‚‡W6W"æ–B“°¢6öç7BÖ–æ–×VÔ×2ÒV6öæö×’æ6öæf–ræÖ–æ–×VÔÖVÖ&W'6†—F—2¢ƒcC°¢–b„FFRææ÷r‚’Ò6VæFW"æ¦ö–æVEF–ÖW7F×ÂÖ–æ–×VÔ×2ÇÂFFRææ÷r‚’Ò&V6V—fW"æ¦ö–æVEF–ÖW7F×ÂÖ–æ–×VÔ×2’F‡&÷ræWrW'&÷"†&÷F‚ÖVÖ&W'2×W7B&R–âF†R6W'fW"f÷"G¶V6öæö×’æ6öæf–ræÖ–æ–×VÔÖVÖ&W'6†—F—7ÒF—2æ“°¢6öç7B&W7VÇBÒV6öæö×’ç’†–çFW&7F–öâæwV–ÆBæ–BÂ–çFW&7F–öâçW6W"æ–BÂW6W"æ–BÂÖ÷VçBÂ–çFW&7F–öâæ–B“°¢v—B–çFW&7F–öâç&WÇ’‡²6öçFVçC¢	ú›‚G¶–çFW&7F–öâçW6W'Ò–BG·W6W'Ò¢¢G¶ÖöæW’‡&W7VÇBæÖ÷VçB—ÒG¶V6öæö×’æ6öæf–ræ7W'&Væ7”æÖWÒ¢¢â–÷W"&Ææ6S¢¢¢G¶ÖöæW’‡&W7VÇBç6VæFW$&Ææ6R—Ò¢¢æÒ“°¢v—BVF—B†–çFW&7F–öâæwV–ÆBÂt&ÆööBÖöæW’G&ç6fW"rÂG¶–çFW&7F–öâçW6W'Ò–BG·W6W'ÒG¶ÖöæW’‡&W7VÇBæÖ÷VçB—Òâ6VæFW"&Ææ6S¢G¶ÖöæW’‡&W7VÇBç6VæFW$&Ææ6R—Òæ“°¢ÒVÇ6R–b†æÖRÓÓÒvF–6Rr’°¢–b†V6öæö×’æ6öæf–rævÖ&Æ–æt6†ææVÄ–Bbb–çFW&7F–öâæ6†ææVÄ–BÓÒV6öæö×’æ6öæf–rævÖ&Æ–æt6†ææVÄ–B’°¢F‡&÷ræWrW'&÷"†W6RvÖ&Æ–ær6öÖÖæG2–âÂ2G¶V6öæö×’æ6öæf–rævÖ&Æ–æt6†ææVÄ–GÓâæ“°¢Ğ¢6öç7B&W7VÇBÒV6öæö×’æF–6R†–çFW&7F–öâæwV–ÆBæ–BÂ–çFW&7F–öâçW6W"æ–BÂ–çFW&7F–öâæ÷F–öç2ævWD–çFVvW"‚vÖ÷VçBrÂG'VR’Â–çFW&7F–öâæ–B“°¢v—B–çFW&7F–öâç&WÇ’‡²VÖ&VG3¢¶æWrF—66÷&BäVÖ&VD'V–ÆFW"‚’ç6WD6öÆ÷"‡&W7VÇBç–÷WBòƒ&VC2¢ƒ–#33’ç6WEF—FÆR†	øë"F–6R+rG·&W7VÇBæ÷WF6öÖWÒ+rG·&W7VÇBæ×VÇF—Æ–W'Ü9v¢ç6WDFW67&—F–öâ‡&W7VÇBç–÷WBò–÷R&V6V—fVB¢¢G¶ÖöæW’‡&W7VÇBç–÷WB—ÒG¶V6öæö×’æ6öæf–ræ7W'&Væ7”æÖWÒ¢¢æ¢F†R†÷W6RFöö²¢¢G¶ÖöæW’‡&W7VÇBçvvW"—ÒG¶V6öæö×’æ6öæf–ræ7W'&Væ7”æÖWÒ¢¢æ¢æFDf–VÆG2€¢²æÖS¢t÷WF6öÖR6†æ6RrÂfÇVS¢G·&W7VÇBæöFG7ÒVÂ–æÆ–æS¢G'VRÒÀ¢²æÖS¢t&Ææ6RrÂfÇVS¢ÖöæW’‡&W7VÇBæ&Ææ6R’Â–æÆ–æS¢G'VRÒÀ¢•ÒÒ“°¢v—BVF—B†–çFW&7F–öâæwV–ÆBÂtF–6R&W7VÇBrÂG¶–çFW&7F–öâçW6W'ÒvvW&VBG¶ÖöæW’‡&W7VÇBçvvW"—ÒæB&V6V—fVBG¶ÖöæW’‡&W7VÇBç–÷WB—Ò‚G·&W7VÇBæ×VÇF—Æ–W'Ü9r’æ“°¢ÒVÇ6R–b†æÖRÓÓÒv†–v†W"ÖÆ÷vW"r’°¢–b†V6öæö×’æ6öæf–rævÖ&Æ–æt6†ææVÄ–Bbb–çFW&7F–öâæ6†ææVÄ–BÓÒV6öæö×’æ6öæf–rævÖ&Æ–æt6†ææVÄ–B’°¢F‡&÷ræWrW'&÷"†Æ’†–v†W"òÆ÷vW"–âÂ2G¶V6öæö×’æ6öæf–rævÖ&Æ–æt6†ææVÄ–GÓâæ“°¢Ğ¢6öç7BvÖRÒV6öæö×’ç7F'D†–v†W$Æ÷vW"†–çFW&7F–öâæwV–ÆBæ–BÂ–çFW&7F–öâçW6W"æ–BÂ–çFW&7F–öâæ÷F–öç2ævWD–çFVvW"‚vÖ÷VçBrÂG'VR’Â–çFW&7F–öâæ–B“°¢v—B–çFW&7F–öâç&WÇ’††–v†W$Æ÷vW%–ÆöB†vÖRÂG¶–çFW&7F–öâçW6W'ÖÂV6öæö×’æ6öæf–ræ7W'&Væ7”æÖR’“°¢6öç7BvÖTÖW76vRÒv—B–çFW&7F–öâæfWF6…&WÇ’‚“°¢V6öæö×’æGF6„†–v†W$Æ÷vW$ÖW76vR†vÖRævÖUö–BÂ–çFW&7F–öâæ6†ææVÄ–BÂvÖTÖW76vRæ–B“°¢ÒVÇ6R–b†æÖRÓÓÒvG&vöâ×F÷vW"r’°¢–b†V6öæö×’æ6öæf–rævÖ&Æ–æt6†ææVÄ–Bbb–çFW&7F–öâæ6†ææVÄ–BÓÒV6öæö×’æ6öæf–rævÖ&Æ–æt6†ææVÄ–B’°¢F‡&÷ræWrW'&÷"†Æ’G&vöâF÷vW"–âÂ2G¶V6öæö×’æ6öæf–rævÖ&Æ–æt6†ææVÄ–GÓâæ“°¢Ğ¢6öç7BvÖRÒV6öæö×’ç7F'DG&vöåF÷vW"†–çFW&7F–öâæwV–ÆBæ–BÂ–çFW&7F–öâçW6W"æ–BÂ–çFW&7F–öâæ÷F–öç2ævWD–çFVvW"‚vÖ÷VçBrÂG'VR’Â–çFW&7F–öâæ–B“°¢v—B–çFW&7F–öâç&WÇ’†G&vöåF÷vW%–ÆöB†vÖRÂG¶–çFW&7F–öâçW6W'ÖÂV6öæö×’æ6öæf–ræ7W'&Væ7”æÖR’“°¢6öç7BvÖTÖW76vRÒv—B–çFW&7F–öâæfWF6…&WÇ’‚“°¢V6öæö×’æGF6„G&vöåF÷vW$ÖW76vR†vÖRævÖUö–BÂ–çFW&7F–öâæ6†ææVÄ–BÂvÖTÖW76vRæ–B“°¢ÒVÇ6R–b†æÖRÓÓÒwö¶W"r’°¢–b†V6öæö×’æ6öæf–rævÖ&Æ–æt6†ææVÄ–Bbb–çFW&7F–öâæ6†ææVÄ–BÓÒV6öæö×’æ6öæf–rævÖ&Æ–æt6†ææVÄ–B’°¢F‡&÷ræWrW'&÷"†Æ’V&Æ–2ö¶W"–âÂ2G¶V6öæö×’æ6öæf–rævÖ&Æ–æt6†ææVÄ–GÓâæ“°¢Ğ¢6öç7BvÖRÒV6öæö×’ç7F'Eö¶W"†–çFW&7F–öâæwV–ÆBæ–BÂ–çFW&7F–öâçW6W"æ–BÂ–çFW&7F–öâæ÷F–öç2ævWD–çFVvW"‚vÖ÷VçBrÂG'VR’Â–çFW&7F–öâæ–B“°¢v—B–çFW&7F–öâç&WÇ’‡°¢6öçFVçC¢ö¶W%F&ÆUFW‡B†vÖRÂG¶–çFW&7F–öâçW6W'ÖÂV6öæö×’æ6öæf–ræ7W'&Væ7”æÖRÂvÖR’À¢VÖ&VG3¢µÒÀ¢6ö×öæVçG3¢ö¶W$6ö×öæVçG2†vÖR’À¢Ò“°¢6öç7BF&ÆTÖW76vRÒv—B–çFW&7F–öâæfWF6…&WÇ’‚“°¢V6öæö×’æGF6…ö¶W$ÖW76vR†vÖRævÖT–BÂ–çFW&7F–öâæ6†ææVÄ–BÂF&ÆTÖW76vRæ–B“°¢ÒVÇ6R–b†æÖRÓÓÒv&Æ6¶¦6²r’°¢–b†V6öæö×’æ6öæf–rævÖ&Æ–æt6†ææVÄ–Bbb–çFW&7F–öâæ6†ææVÄ–BÓÒV6öæö×’æ6öæf–rævÖ&Æ–æt6†ææVÄ–B’°¢F‡&÷ræWrW'&÷"†Æ’&Æ6¶¦6²–âÂ2G¶V6öæö×’æ6öæf–rævÖ&Æ–æt6†ææVÄ–GÓâæ“°¢Ğ¢6öç7BvÖRÒV6öæö×’ç7F'D&Æ6¶¦6²†–çFW&7F–öâæwV–ÆBæ–BÂ–çFW&7F–öâçW6W"æ–BÂ–çFW&7F–öâæ÷F–öç2ævWD–çFVvW"‚vÖ÷VçBrÂG'VR’Â–çFW&7F–öâæ–B“°¢v—B–çFW&7F–öâç&WÇ’†&Æ6¶¦6µ–ÆöB†vÖRÂG¶–çFW&7F–öâçW6W'ÖÂV6öæö×’æ6öæf–ræ7W'&Væ7”æÖR’“°¢6öç7BvÖTÖW76vRÒv—B–çFW&7F–öâæfWF6…&WÇ’‚“°¢V6öæö×’æGF6„&Æ6¶¦6´ÖW76vR†vÖRævÖUö–BÂ–çFW&7F–öâæ6†ææVÄ–BÂvÖTÖW76vRæ–B“°¢–b†vÖRç7FGW2ÓÒv7F—fRr’v—BVF—B†–çFW&7F–öâæwV–ÆBÂt&Æ6¶¦6²&W7VÇBrÂG¶–çFW&7F–öâçW6W'Ò&WBG¶ÖöæW’†vÖRçvvW"—ÒÂf–æ—6†VBv—F‚G¶vÖRæ÷WF6öÖWÒÂæB&V6V—fVBG¶ÖöæW’†vÖRç–÷WB—Òæ“°¢ÒVÇ6R–b†æÖRÓÓÒvGVVÂr’°¢–b†V6öæö×’æ6öæf–rævÖ&Æ–æt6†ææVÄ–Bbb–çFW&7F–öâæ6†ææVÄ–BÓÒV6öæö×’æ6öæf–rævÖ&Æ–æt6†ææVÄ–B’°¢F‡&÷ræWrW'&÷"†7F'BGVVÇ2–âÂ2G¶V6öæö×’æ6öæf–rævÖ&Æ–æt6†ææVÄ–GÓâæ“°¢Ğ¢6öç7B6†ÆÆVævVBÒ–çFW&7F–öâæ÷F–öç2ævWEW6W"‚wW6W"rÂG'VR“°¢–b†6†ÆÆVævVBæ&÷B’F‡&÷ræWrW'&÷"‚t&÷G26ææ÷B'F–6—FR–âGVVÇ2âr“°¢6öç7BGVVÂÒV6öæö×’æ7&VFTGVVÂ†–çFW&7F–öâæwV–ÆBæ–BÂ–çFW&7F–öâçW6W"æ–BÂ6†ÆÆVævVBæ–BÂ–çFW&7F–öâæ÷F–öç2ævWD–çFVvW"‚vÖ÷VçBrÂG'VR’Â–çFW&7F–öâæ–B“°¢v—B–çFW&7F–öâç&WÇ’†GVVÄ6†ÆÆVævU–ÆöB†GVVÂÂV6öæö×’æ6öæf–ræ7W'&Væ7”æÖR’“°¢6öç7B6†ÆÆVævTÖW76vRÒv—B–çFW&7F–öâæfWF6…&WÇ’‚“°¢V6öæö×’æGF6„GVVÄÖW76vR†GVVÂæGVVÅö–BÂ–çFW&7F–öâæ6†ææVÄ–BÂ6†ÆÆVævTÖW76vRæ–B“°¢v—BVF—B†–çFW&7F–öâæwV–ÆBÂtGVVÂ6†ÆÆVævRrÂG¶–çFW&7F–öâçW6W'Ò6†ÆÆVævVBG¶6†ÆÆVævVGÒf÷"G¶ÖöæW’†GVVÂçvvW"—ÒG¶V6öæö×’æ6öæf–ræ7W'&Væ7”æÖWÒæ“°¢Ğ¢Ò6F6‚†W'&÷"’°¢6öç7B–ÆöBÒ²6öçFVçC¢)ØÂG¶W'&÷"æÖW76vWÖÂW†VÖW&Ã¢G'VRÓ°¢–b†–çFW&7F–öâæFVfW'&VBÇÂ–çFW&7F–öâç&WÆ–VB’v—B–çFW&7F–öâæföÆÆ÷uW‡–ÆöB’æ6F6‚‚‚’Óâ·Ò“²VÇ6Rv—B–çFW&7F–öâç&WÇ’‡–ÆöB’æ6F6‚‚‚’Óâ·Ò“°¢Ğ¢&WGW&âG'VS°¢Ğ ¢gVæ7F–öâ7F÷‚’°¢–b‡fö–6UF–ÖW"’6ÆV$–çFW'fÂ‡fö–6UF–ÖW"“°¢–b‡&Wfö–6UF–ÖW"’6ÆV$–çFW'fÂ‡&Wfö–6UF–ÖW"“°¢–b‡ö¶W%F–ÖW"’6ÆV$–çFW'fÂ‡ö¶W%F–ÖW"“°¢–b‡&öÆÆ÷fW%F–ÖW"’6ÆV$–çFW'fÂ‡&öÆÆ÷fW%F–ÖW"“°¢–b‡æVÅF–ÖW"’6ÆV$–çFW'fÂ‡æVÅF–ÖW"“°¢–b††V—7D&÷VæF'•F–ÖW"’6ÆV%F–ÖV÷WB††V—7D&÷VæF'•F–ÖW"“°¢V6öæö×’æ6Æ÷6R‚“°¢Ğ ¢7–æ2gVæ7F–öâW6„†V—7EæVÂ†wV–ÆD–BÂ6†ææVÄ–BÒrr’°¢–b†6†ææVÄ–B’°¢–b‚õåÆG³rÃ#ÒBòçFW7B…7G&–ær†6†ææVÄ–B’’’F‡&÷ræWrW'&÷"‚uF†RW'6—7FVçB†V—7B6†ææVÂ”B—2–çfÆ–Bâr“°¢V6öæö×’æ6öæf–ræ†V—7D6†ææVÄ–BÒ7G&–ær†6†ææVÄ–B“°¢Ğ¢–b‚V6öæö×’æ6öæf–ræ†V—7D6†ææVÄ–B’F‡&÷ræWrW'&÷"‚u6WBæB6fRF†RW'6—7FVçB†V—7B6†ææVÂ”Bf—'7Bâr“°¢6öç7BwV–ÆBÒ6Æ–VçBæwV–ÆG2æ66†RævWB†wV–ÆD–B’ÇÂv—B6Æ–VçBæwV–ÆG2æfWF6‚†wV–ÆD–B“°¢6öç7BÖW76vRÒv—BWFFT†V—7EæVÂ†wV–ÆB“°¢–b‚ÖW76vR’F‡&÷ræWrW'&÷"‚uF†R†V—7B6†ææVÂ—2Ö—76–ær÷"—2æ÷BFW‡B6†ææVÂâr“°¢&WGW&â²wV–ÆD–C¢wV–ÆBæ–BÂ6†ææVÄ–C¢V6öæö×’æ6öæf–ræ†V—7D6†ææVÄ–BÂÖW76vT–C¢ÖW76vRæ–BÓ°¢Ğ ¢7–æ2gVæ7F–öâ&Wf–Wu&W6WB†wV–ÆD–BÂ7F–öâÂW6W$–BÒrr’°¢6öç7BwV–ÆBÒ6Æ–VçBæwV–ÆG2æ66†RævWB†wV–ÆD–B’ÇÂv—B6Æ–VçBæwV–ÆG2æfWF6‚†wV–ÆD–B“°¢6öç7B&Wf–WrÒV6öæö×’ç&Wf–WtV6öæö×•&W6WB†wV–ÆBæ–BÂ7G&–ær†7F–öâÇÂrr’Â7G&–ær‡W6W$–BÇÂrr’“°¢6öç7BFö¶VâÒ7'—Fòç&æFöÕUT”B‚“°¢6öç7BW‡—&W4BÒFFRææ÷r‚’²ƒR¢c¢“°¢&W6WE&Wf–Ww2ç6WB‡Fö¶VâÂ²wV–ÆD–C¢wV–ÆBæ–BÂ7F–öã¢7G&–ær†7F–öâ’ÂW6W$–C¢7G&–ær‡W6W$–BÇÂrr’Â&Wf–WrÂW‡—&W4BÒ“°¢f÷"†6öç7B¶¶W’ÂfÇVUÒöb&W6WE&Wf–Ww2’–b‡fÇVRæW‡—&W4BÂFFRææ÷r‚’’&W6WE&Wf–Ww2æFVÆWFR†¶W’“°¢6öç7BF—7Æ’Ò'&’æ—4'&’‡&Wf–WræÆVFW'2¢ò²ââç&Wf–WrÂÆVFW'3¢&Wf–WræÆVFW'2æf–ÇFW"‡&÷rÓâ&÷rç66÷&Râ’ç6Æ–6RƒÂ’ÂF÷FÄÆVFW&&ö&E&÷w3¢&Wf–WræÆVFW'2æf–ÇFW"‡&÷rÓâ&÷rç66÷&Râ’æÆVæwF‚Ğ¢¢&Wf–Ws°¢&WGW&â²Fö¶VâÂW‡—&W4BÂ&Wf–Ws¢F—7Æ’Ó°¢Ğ ¢7–æ2gVæ7F–öâW†V7WFU&W6WB†wV–ÆD–BÂFö¶Vâ’°¢6öç7BVæF–ærÒ&W6WE&Wf–Ww2ævWB…7G&–ær‡Fö¶VâÇÂrr’“°¢–b‚VæF–ærÇÂVæF–æræwV–ÆD–BÓÒwV–ÆD–B’F‡&÷ræWrW'&÷"‚uF†B&W6WB&Wf–Wr—2–çfÆ–Bâ7&VFRæWr&Wf–Wrf—'7Bâr“°¢–b‡VæF–æræW‡—&W4BÂFFRææ÷r‚’’°¢&W6WE&Wf–Ww2æFVÆWFR…7G&–ær‡Fö¶Vâ’“°¢F‡&÷ræWrW'&÷"‚uF†B&W6WB&Wf–WrW‡—&VBâ7&VFRæWr&Wf–Wrf—'7Bâr“°¢Ğ¢6öç7BwV–ÆBÒ6Æ–VçBæwV–ÆG2æ66†RævWB†wV–ÆD–B’ÇÂv—B6Æ–VçBæwV–ÆG2æfWF6‚†wV–ÆD–B“°¢–b…²wvVV¶Ç’×&æ¶–æw2rÂvÖöçF†Ç’×&æ¶–æw2uÒæ–æ6ÇVFW2‡VæF–æræ7F–öâ’’°¢v—B&6†—fU&W6WE&Wf–Wr†wV–ÆBÂVæF–ærç&Wf–WrÂVæF–æræ7F–öâç&WÆ6R‚rÒrÂrr’“°¢Ğ¢6öç7B&W7VÇBÒV6öæö×’æW†V7WFTV6öæö×•&W6WB†wV–ÆBæ–BÂVæF–æræ7F–öâÂVæF–ærçW6W$–B“°¢&W6WE&Wf–Ww2æFVÆWFR…7G&–ær‡Fö¶Vâ’“°¢v—BWFFTÆVFW&&ö&EæVÂ†wV–ÆB’æ6F6‚‚‚’Óâ·Ò“°¢v—BWFFT†V—7EæVÂ†wV–ÆB’æ6F6‚‚‚’Óâ·Ò“°¢6öç7BF&vWBÒVæF–ærçW6W$–BòF&vWBÖVÖ&W#¢G·VæF–ærçW6W$–GÒæ¢rs°¢v—BVF—B†wV–ÆBÂt6öæf—&ÖVB&ÆööBÖöæW’&W6WBrÂFW6·F÷FÖ–æ—7G&F÷"6öæf—&ÖVB¢¢G·VæF–æræ7F–öçÒ¢¢â&Wf–Wrv2&WV—&VBâG·F&vWGÒffV7FVBÖVÖ&W'3¢G¶ÖöæW’‡&W7VÇBæffV7FVDÖVÖ&W'2ÇÂ&W7VÇBæÖVÖ&W'2ÇÂ—ÒâÆ–fWF–ÖR7FF—7F–72vW&R&W6W'fVBæ“°¢&WGW&â²ââç&W7VÇBÂwV–ÆD–C¢wV–ÆBæ–BÓ°¢Ğ ¢7–æ2gVæ7F–öâ&Wf–Wt'VÆ´w&çB†wV–ÆD–BÂÖ÷VçB’°¢6öç7BwV–ÆBÒ6Æ–VçBæwV–ÆG2æ66†RævWB†wV–ÆD–B’ÇÂv—B6Æ–VçBæwV–ÆG2æfWF6‚†wV–ÆD–B“°¢6öç7BÖVÖ&W'2Òv—BwV–ÆBæÖVÖ&W'2æfWF6‚‚“°¢6öç7BW6W$–G2ÒÖVÖ&W'2æf–ÇFW"†ÖVÖ&W"ÓâÖVÖ&W"çW6W"æ&÷B’æÖ†ÖVÖ&W"ÓâÖVÖ&W"æ–B“°¢6öç7B&Wf–WrÒV6öæö×’ç&Wf–Wt'VÆ´w&çB†wV–ÆBæ–BÂW6W$–G2ÂÖ÷VçB“°¢6öç7BFö¶VâÒ7'—Fòç&æFöÕUT”B‚“°¢6öç7BW‡—&W4BÒFFRææ÷r‚’²ƒR¢c¢“°¢'VÆ´w&çE&Wf–Ww2ç6WB‡Fö¶VâÂ²wV–ÆD–C¢wV–ÆBæ–BÂW6W$–G3¢&Wf–WrçW6W$–G2ÂÖ÷VçC¢&Wf–WræÖ÷VçEW$ÖVÖ&W"Â&Wf–WrÂW‡—&W4BÒ“°¢f÷"†6öç7B¶¶W’ÂfÇVUÒöb'VÆ´w&çE&Wf–Ww2’–b‡fÇVRæW‡—&W4BÂFFRææ÷r‚’’'VÆ´w&çE&Wf–Ww2æFVÆWFR†¶W’“°¢&WGW&â²Fö¶VâÂW‡—&W4BÂ&Wf–Ws¢²ââç&Wf–WrÂW6W$–G3¢VæFVf–æVBÒÓ°¢Ğ ¢7–æ2gVæ7F–öâW†V7WFT'VÆ´w&çB†wV–ÆD–BÂFö¶Vâ’°¢6öç7BVæF–ærÒ'VÆ´w&çE&Wf–Ww2ævWB…7G&–ær‡Fö¶VâÇÂrr’“°¢–b‚VæF–ærÇÂVæF–æræwV–ÆD–BÓÒwV–ÆD–B’F‡&÷ræWrW'&÷"‚uF†B'VÆ²Öw&çB&Wf–Wr—2–çfÆ–Bâ7&VFRæWr&Wf–Wrf—'7Bâr“°¢–b‡VæF–æræW‡—&W4BÂFFRææ÷r‚’’°¢'VÆ´w&çE&Wf–Ww2æFVÆWFR…7G&–ær‡Fö¶Vâ’“°¢F‡&÷ræWrW'&÷"‚uF†B'VÆ²Öw&çB&Wf–WrW‡—&VBâ7&VFRæWr&Wf–Wrf—'7Bâr“°¢Ğ¢6öç7BwV–ÆBÒ6Æ–VçBæwV–ÆG2æ66†RævWB†wV–ÆD–B’ÇÂv—B6Æ–VçBæwV–ÆG2æfWF6‚†wV–ÆD–B“°¢6öç7B&F6„–BÒ7'—Fòç&æFöÕUT”B‚“°¢6öç7B&W7VÇBÒV6öæö×’æW†V7WFT'VÆ´w&çB†wV–ÆBæ–BÂVæF–ærçW6W$–G2ÂVæF–æræÖ÷VçBÂ&F6„–B“°¢'VÆ´w&çE&Wf–Ww2æFVÆWFR…7G&–ær‡Fö¶Vâ’“°¢v—BWFFTÆVFW&&ö&EæVÂ†wV–ÆB’æ6F6‚‚‚’Óâ·Ò“°¢v—BVF—B†wV–ÆBÂt6öæf—&ÖVB6W'fW"×v–FR&ÆööBÖöæW’w&çBrÂFW6·F÷FÖ–æ—7G&F÷"FFVB¢¢G¶ÖöæW’‡&W7VÇBæÖ÷VçEW$ÖVÖ&W"—ÒG¶V6öæö×’æ6öæf–ræ7W'&Væ7”æÖWÒ¢¢Fò¢¢G¶ÖöæW’‡&W7VÇBæffV7FVDÖVÖ&W'2—Ò‡VÖâÖVÖ&W'2¢¢âF÷FÂ7&VFVC¢¢¢G¶ÖöæW’‡&W7VÇBçF÷FÄw&çB—Ò¢¢â&F6ƒ¢ÆG¶&F6„–GÕÆâ&÷G2vW&RW†6ÇVFVBæ“°¢&WGW&â²ââç&W7VÇBÂW6W$–G3¢VæFVf–æVBÂwV–ÆD–C¢wV–ÆBæ–BÓ°¢Ğ ¢&WGW&â²†æFÆT'WGFöâÂ†æFÆT6öÖÖæBÂVF—BÂ&Wv&Efö–6RÂWFFT†V—7EæVÂÂW6„†V—7EæVÂÂ&Wf–Wu&W6WBÂW†V7WFU&W6WBÂ&Wf–Wt'VÆ´w&çBÂW†V7WFT'VÆ´w&çBÂ7F÷Ó°§Ğ ¦ÖöGVÆRæW‡÷'G2Ò²V6öæö×”6öÖÖæDFFÂ7&VFTV6öæö×”–çFVw&F–öâÂö¶W$6ö×öæVçG2Â6äFÖ–æ—7FW$V6öæö×’ÂvÖ&ÆTÖVçU–ÆöBÂvvW$ÖöFÂÓ°