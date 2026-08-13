'use strict';

const Discord = require('discord.js');
const discordEconomy = require('./economy_discord');
const slotsPatch = require('./economy_slots_patch');

const OLD_GAMBLE_COMMANDS = new Set(['dice', 'higher-lower', 'dragon-tower', 'poker', 'blackjack', 'duel', 'slots']);
const STAFF_ACTIONS = new Set(['add', 'remove', 'set', 'reset-user']);

function money(value) {
    return Number(value || 0).toLocaleString('en-US');
}

function gambleMenuPayload(currencyName) {
    const menu = new Discord.StringSelectMenuBuilder()
        .setCustomId('econ:gamble:menu')
        .setPlaceholder('Choose a game')
        .addOptions(
            { label: 'Slots', value: 'slots', description: 'Spin the 3×3 Commission slot machine', emoji: '🎰' },
            { label: 'Dice', value: 'dice', description: 'Roll for weighted multipliers', emoji: '🎲' },
            { label: 'Higher / Lower', value: 'higher-lower', description: 'Climb the card multiplier ladder', emoji: '🃏' },
            { label: 'Dragon Tower', value: 'dragon-tower', description: 'Climb eight rows and cash out', emoji: '🐉' },
            { label: 'Poker', value: 'poker', description: 'Play one-draw video poker', emoji: '♠️' },
            { label: 'Blackjack', value: 'blackjack', description: 'Play public blackjack', emoji: '🂡' },
            { label: 'Duel', value: 'duel', description: 'Challenge another member 50/50', emoji: '⚔️' },
        );

    return {
        embeds: [new Discord.EmbedBuilder()
            .setColor(0x9b1c31)
            .setTitle('🎲 The Commission · Gambling')
            .setDescription(`Choose a game below, then enter your wager in ${currencyName}.`)
            .addFields(
                { name: 'Casino', value: 'Slots · Dice · Higher / Lower · Dragon Tower · Poker · Blackjack', inline: false },
                { name: 'Player vs Player', value: 'Duel · 50/50 · no house fee', inline: false },
            )
            .setFooter({ text: 'One command. Every game.' })],
        components: [new Discord.ActionRowBuilder().addComponents(menu)],
        ephemeral: true,
    };
}

function wagerModal(game) {
    const labels = {
        slots: 'Slots',
        dice: 'Dice',
        'higher-lower': 'Higher / Lower',
        'dragon-tower': 'Dragon Tower',
        poker: 'Poker',
        blackjack: 'Blackjack',
        duel: 'Duel',
    };
    const modal = new Discord.ModalBuilder()
        .setCustomId(`econ:gamble:modal:${game}`)
        .setTitle(`${labels[game] || 'Gamble'} · Wager`);

    const wager = new Discord.TextInputBuilder()
        .setCustomId('amount')
        .setLabel('Blood Money wager')
        .setStyle(Discord.TextInputStyle.Short)
        .setPlaceholder('Example: 500')
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(12);
    modal.addComponents(new Discord.ActionRowBuilder().addComponents(wager));

    if (game === 'duel') {
        const opponent = new Discord.TextInputBuilder()
            .setCustomId('opponent')
            .setLabel('Opponent @mention or Discord user ID')
            .setStyle(Discord.TextInputStyle.Short)
            .setPlaceholder('@member or 123456789012345678')
            .setRequired(true)
            .setMinLength(2)
            .setMaxLength(40);
        modal.addComponents(new Discord.ActionRowBuilder().addComponents(opponent));
    }
    return modal;
}

function parseAmount(interaction) {
    const raw = interaction.fields.getTextInputValue('amount').replace(/[,$\s]/g, '');
    const amount = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('Enter a valid wager of at least 1 Blood Money.');
    return amount;
}

function parseUserId(raw) {
    const match = String(raw || '').match(/\d{17,20}/);
    if (!match) throw new Error('Enter a valid Discord @mention or user ID for the duel opponent.');
    return match[0];
}

function slotsPayload(result, guild, currencyName) {
    const symbols = slotsPatch.serverSymbols(guild);
    const board = [0, 3, 6].map(start => result.grid.slice(start, start + 3).map(symbol => symbol.render).join('  ')).join('\n');
    const paytable = symbols.map(symbol => `${symbol.render} **${symbol.multiplier}×**`).join('  ·  ');
    const wins = result.wins.length
        ? result.wins.map(win => `Line ${win.line}: ${win.symbol.render} ${win.symbol.render} ${win.symbol.render} → **${win.multiplier}×**`).join('\n')
        : 'No matching payline this spin.';
    return {
        embeds: [new Discord.EmbedBuilder()
            .setColor(result.payout > 0 ? 0x2ea043 : 0x9b1c31)
            .setTitle('🎰 The Commission · 3×3 Slots')
            .setDescription(`${board}\n\n${wins}`)
            .addFields(
                { name: 'Wager', value: `${money(result.wager)} ${currencyName}`, inline: true },
                { name: 'Total multiplier', value: `${result.multiplier}×`, inline: true },
                { name: 'Payout', value: `${money(result.payout)} ${currencyName}`, inline: true },
                { name: 'Balance', value: `${money(result.balance)} ${currencyName}`, inline: true },
                { name: 'Paytable · 3 matching on any line', value: paytable, inline: false },
            )
            .setFooter({ text: '8 paylines · winning lines stack' })
            .setTimestamp()],
    };
}

function buildEcoCommand() {
    return new Discord.SlashCommandBuilder()
        .setName('eco')
        .setDescription('Manage the Blood Money economy')
        .addSubcommandGroup(group => group.setName('manage').setDescription('Blood Money moderation and settings')
            .addSubcommand(sub => sub.setName('add').setDescription('Add Blood Money to a member')
                .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
                .addIntegerOption(o => o.setName('amount').setDescription('Amount').setMinValue(1).setRequired(true)))
            .addSubcommand(sub => sub.setName('remove').setDescription('Remove Blood Money from a member')
                .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
                .addIntegerOption(o => o.setName('amount').setDescription('Amount').setMinValue(1).setRequired(true)))
            .addSubcommand(sub => sub.setName('set').setDescription('Set a member Blood Money balance')
                .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
                .addIntegerOption(o => o.setName('amount').setDescription('Balance').setMinValue(0).setRequired(true)))
            .addSubcommand(sub => sub.setName('give-all').setDescription('Give every human member Blood Money')
                .addIntegerOption(o => o.setName('amount').setDescription('Amount per member').setMinValue(1).setRequired(true)))
            .addSubcommand(sub => sub.setName('reset-user').setDescription('Reset a member economy record')
                .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)))
            .addSubcommand(sub => sub.setName('reset-daily').setDescription('Reset a member daily limits')
                .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)))
            .addSubcommand(sub => sub.setName('freeze').setDescription('Freeze a member economy account')
                .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)))
            .addSubcommand(sub => sub.setName('unfreeze').setDescription('Unfreeze a member economy account')
                .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)))
            .addSubcommand(sub => sub.setName('audit').setDescription('View recent member transactions')
                .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)))
            .addSubcommand(sub => sub.setName('exclude-channel').setDescription('Exclude a channel from text rewards')
                .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)))
            .addSubcommand(sub => sub.setName('include-channel').setDescription('Allow text rewards in a channel')
                .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)))
            .addSubcommand(sub => sub.setName('disable-gambling').setDescription('Disable all gambling'))
            .addSubcommand(sub => sub.setName('enable-gambling').setDescription('Enable all gambling'))
            .addSubcommand(sub => sub.setName('settings').setDescription('Show active economy settings')))
        .toJSON();
}

const priorCommandData = discordEconomy.economyCommandData;
discordEconomy.economyCommandData = function consolidatedCommandData() {
    const commands = priorCommandData().filter(command => !OLD_GAMBLE_COMMANDS.has(command.name) && command.name !== 'economy');
    commands.push(new Discord.SlashCommandBuilder().setName('gamble').setDescription('Open the Blood Money game menu').toJSON());
    commands.push(buildEcoCommand());
    return commands;
};

const priorCreateIntegration = discordEconomy.createEconomyIntegration;
discordEconomy.createEconomyIntegration = function createConsolidatedIntegration(client, economy, options = {}) {
    const integration = priorCreateIntegration(client, economy, options);
    const priorHandleCommand = integration.handleCommand;

    async function handleGambleModal(interaction) {
        const game = interaction.customId.split(':').at(-1);
        const amount = parseAmount(interaction);
        if (economy.config.gamblingChannelId && interaction.channelId !== economy.config.gamblingChannelId) {
            throw new Error(`Play gambling games in <#${economy.config.gamblingChannelId}>.`);
        }

        if (game === 'slots') {
            const symbols = slotsPatch.serverSymbols(interaction.guild);
            const result = economy.slots(interaction.guild.id, interaction.user.id, amount, interaction.id, symbols);
            await interaction.reply(slotsPayload(result, interaction.guild, economy.config.currencyName));
            await integration.audit(interaction.guild, 'Slots result', `${interaction.user} wagered ${money(result.wager)} and received ${money(result.payout)} (${result.multiplier}×).`);
            return;
        }
        if (game === 'dice') {
            const result = economy.dice(interaction.guild.id, interaction.user.id, amount, interaction.id);
            await interaction.reply({ embeds: [new Discord.EmbedBuilder().setColor(result.payout ? 0x2ea043 : 0x9b1c31)
                .setTitle(`🎲 Dice · ${result.outcome} · ${result.multiplier}×`)
                .setDescription(result.payout ? `You received **${money(result.payout)} ${economy.config.currencyName}**.` : `The house took **${money(result.wager)} ${economy.config.currencyName}**.`)
                .addFields({ name: 'Outcome chance', value: `${result.odds}%`, inline: true }, { name: 'Balance', value: money(result.balance), inline: true })] });
            await integration.audit(interaction.guild, 'Dice result', `${interaction.user} wagered ${money(result.wager)} and received ${money(result.payout)} (${result.multiplier}×).`);
            return;
        }
        if (game === 'higher-lower') {
            const started = economy.startHigherLower(interaction.guild.id, interaction.user.id, amount, interaction.id);
            const currentMultiplier = started.step > 0 ? started.multiplier : 0;
            const components = [new Discord.ActionRowBuilder().addComponents(
                new Discord.ButtonBuilder().setCustomId(`econ:hilo:${started.game_id}:higher`).setLabel('Higher').setEmoji('⬆️').setStyle(Discord.ButtonStyle.Success),
                new Discord.ButtonBuilder().setCustomId(`econ:hilo:${started.game_id}:lower`).setLabel('Lower').setEmoji('⬇️').setStyle(Discord.ButtonStyle.Danger),
                new Discord.ButtonBuilder().setCustomId(`econ:hilo:${started.game_id}:cash`).setLabel(currentMultiplier ? `Cash Out ${currentMultiplier}×` : 'Cash Out').setEmoji('💰').setStyle(Discord.ButtonStyle.Primary).setDisabled(started.step < 1),
            )];
            await interaction.reply({ embeds: [new Discord.EmbedBuilder().setColor(0x7c3aed).setTitle('🃏 Higher / Lower Cards')
                .setDescription(`${interaction.user}, is the hidden card **Higher** or **Lower** than **${started.current_card}**?`)
                .addFields({ name: 'Wager', value: `${money(started.wager)} ${economy.config.currencyName}`, inline: true }, { name: 'Correct cards', value: String(started.step), inline: true })
                .setFooter({ text: '85% RTP · ties lose · inactivity cashes out earned progress' }).setTimestamp()], components });
            const message = await interaction.fetchReply();
            economy.attachHigherLowerMessage(started.game_id, interaction.channelId, message.id);
            return;
        }
        if (game === 'dragon-tower') {
            const started = economy.startDragonTower(interaction.guild.id, interaction.user.id, amount, interaction.id);
            const rows = Array.from({ length: 8 }, (_, index) => `**${String(8 - index).padStart(2, '0')}**  ${8 - index === 1 ? '❓  ❓  ❓  ❓' : '⬛  ⬛  ⬛  ⬛'}`).join('\n');
            const components = [
                new Discord.ActionRowBuilder().addComponents(...Array.from({ length: 4 }, (_, column) => new Discord.ButtonBuilder().setCustomId(`econ:dragon:${started.game_id}:pick:${column}`).setLabel(`Tile ${column + 1}`).setEmoji('🥚').setStyle(Discord.ButtonStyle.Secondary))),
                new Discord.ActionRowBuilder().addComponents(
                    new Discord.ButtonBuilder().setCustomId(`econ:dragon:${started.game_id}:auto`).setLabel('Auto-Pick').setEmoji('🎲').setStyle(Discord.ButtonStyle.Primary),
                    new Discord.ButtonBuilder().setCustomId(`econ:dragon:${started.game_id}:cash`).setLabel('Cash Out').setEmoji('💰').setStyle(Discord.ButtonStyle.Success).setDisabled(true)),
            ];
            await interaction.reply({ embeds: [new Discord.EmbedBuilder().setColor(0xd29922).setTitle('🐉 Dragon Tower · 4×8')
                .setDescription(`${interaction.user}, choose one of four tiles on row **1**.\n\n${rows}`)
                .addFields({ name: 'Wager', value: `${money(started.wager)} ${economy.config.currencyName}`, inline: true }, { name: 'Rows cleared', value: '0/8', inline: true })
                .setFooter({ text: 'Cash out after any cleared row · 85% RTP' }).setTimestamp()], components });
            const message = await interaction.fetchReply();
            economy.attachDragonTowerMessage(started.game_id, interaction.channelId, message.id);
            return;
        }
        if (game === 'poker') {
            const started = economy.startPoker(interaction.guild.id, interaction.user.id, amount, interaction.id);
            const cards = started.cards.map((card, index) => `[${card}]`).join('  ');
            await interaction.reply({
                content: `🃏 **THE COMMISSION · PUBLIC POKER TABLE**\nPlayer: ${interaction.user}\nWager: **${money(started.wager)} ${economy.config.currencyName}**\nHand: ${cards}\n\nChoose cards to hold, then Draw.`,
                components: discordEconomy.pokerComponents(started),
            });
            const message = await interaction.fetchReply();
            economy.attachPokerMessage(started.gameId, interaction.channelId, message.id);
            return;
        }
        if (game === 'blackjack') {
            const started = economy.startBlackjack(interaction.guild.id, interaction.user.id, amount, interaction.id);
            const active = started.status === 'active';
            const dealerCards = active ? `${started.dealerCards[0]}  [hidden]` : started.dealerCards.join('  ');
            const components = active ? [new Discord.ActionRowBuilder().addComponents(
                new Discord.ButtonBuilder().setCustomId(`econ:blackjack:${started.game_id}:hit`).setLabel('Hit').setEmoji('🃏').setStyle(Discord.ButtonStyle.Primary),
                new Discord.ButtonBuilder().setCustomId(`econ:blackjack:${started.game_id}:stand`).setLabel('Stay').setEmoji('✋').setStyle(Discord.ButtonStyle.Danger),
                new Discord.ButtonBuilder().setCustomId(`econ:blackjack:${started.game_id}:double`).setLabel('Double Down').setEmoji('💰').setStyle(Discord.ButtonStyle.Success),
                new Discord.ButtonBuilder().setCustomId(`econ:blackjack:${started.game_id}:split`).setLabel('Split').setEmoji('✂️').setStyle(Discord.ButtonStyle.Secondary).setDisabled(!started.canSplit),
            )] : [];
            await interaction.reply({ embeds: [new Discord.EmbedBuilder().setColor(active ? 0x2563eb : 0x9b1c31).setTitle('🂡 The Commission Blackjack')
                .setDescription(`${interaction.user}, play your hand.`)
                .addFields(
                    { name: `Player · ${started.handValues[0].total}`, value: started.hands[0].join('  '), inline: false },
                    { name: `Dealer · ${active ? '?' : started.dealerHand.total}`, value: dealerCards, inline: false },
                    { name: 'Total bet', value: `${money(started.wager)} ${economy.config.currencyName}`, inline: true },
                ).setTimestamp()], components });
            const message = await interaction.fetchReply();
            economy.attachBlackjackMessage(started.game_id, interaction.channelId, message.id);
            return;
        }
        if (game === 'duel') {
            const opponentId = parseUserId(interaction.fields.getTextInputValue('opponent'));
            if (opponentId === interaction.user.id) throw new Error('You cannot duel yourself.');
            const challenged = await client.users.fetch(opponentId).catch(() => null);
            if (!challenged) throw new Error('I could not find that Discord user.');
            if (challenged.bot) throw new Error('Bots cannot participate in duels.');
            await interaction.guild.members.fetch(opponentId).catch(() => { throw new Error('That user is not a member of this server.'); });
            const duel = economy.createDuel(interaction.guild.id, interaction.user.id, challenged.id, amount, interaction.id);
            await interaction.reply({
                content: `<@${duel.challenged_id}>`,
                embeds: [new Discord.EmbedBuilder().setColor(0x9b1c31).setTitle('⚔️ Blood Money Duel Challenge')
                    .setDescription(`<@${duel.challenger_id}> challenged <@${duel.challenged_id}> to a **50/50 duel**.`)
                    .addFields(
                        { name: 'Wager per player', value: `${money(duel.wager)} ${economy.config.currencyName}`, inline: true },
                        { name: 'Winner receives', value: `${money(duel.wager * 2)} ${economy.config.currencyName}`, inline: true },
                        { name: 'Respond', value: `Only <@${duel.challenged_id}> may type **!accept** or **!deny** in this channel.`, inline: false },
                    ).setFooter({ text: 'Fair 50/50 result · no house fee · expires in 5 minutes' }).setTimestamp()],
                allowedMentions: { users: [duel.challenged_id] },
            });
            const message = await interaction.fetchReply();
            economy.attachDuelMessage(duel.duel_id, interaction.channelId, message.id);
            await integration.audit(interaction.guild, 'Duel challenge', `${interaction.user} challenged ${challenged} for ${money(duel.wager)} ${economy.config.currencyName}.`);
            return;
        }
        throw new Error('That gambling game is not available.');
    }

    async function handleEco(interaction) {
        const action = interaction.options.getSubcommand();
        const isAdministrator = interaction.member?.permissions?.has?.(Discord.PermissionFlagsBits.Administrator);
        const allowedByStaffRole = STAFF_ACTIONS.has(action) && (options.staffRoleIds || []).some(roleId => interaction.member?.roles?.cache?.has?.(roleId));
        if (!isAdministrator && !allowedByStaffRole) {
            throw new Error(STAFF_ACTIONS.has(action)
                ? 'A configured staff role or Administrator permission is required to edit Blood Money balances.'
                : 'Administrator permission is required for this economy action.');
        }

        if (action === 'give-all') {
            const amount = interaction.options.getInteger('amount', true);
            await interaction.deferReply({ ephemeral: true });
            const members = await interaction.guild.members.fetch();
            const userIds = members.filter(member => !member.user.bot).map(member => member.id);
            const preview = economy.previewBulkGrant(interaction.guild.id, userIds, amount);
            const batchId = Discord.SnowflakeUtil.generate().toString();
            const result = economy.executeBulkGrant(interaction.guild.id, preview.userIds, preview.amountPerMember, batchId);
            await integration.audit(interaction.guild, 'Server-wide Blood Money grant', `${interaction.user} added **${money(result.amountPerMember)} ${economy.config.currencyName}** to **${money(result.affectedMembers)} human members**. Total created: **${money(result.totalGrant)}**. Bots were excluded.`);
            await interaction.editReply(`✅ Gave **${money(result.amountPerMember)} ${economy.config.currencyName}** to **${money(result.affectedMembers)} members**. Total created: **${money(result.totalGrant)}**. Bots were excluded.`);
            return;
        }
        if (action === 'settings') {
            const c = economy.config;
            await interaction.reply({ content: `🩸 **Blood Money settings**\nText rewards: ${c.messageRewardMin}-${c.messageRewardMax}\nVoice rewards: ${c.voiceRewardMin}-${c.voiceRewardMax}\nDaily base: ${c.dailyBase}\nGambling: ${c.gamblingEnabled ? 'enabled' : 'disabled'}\nGambling channel: ${c.gamblingChannelId ? `<#${c.gamblingChannelId}>` : 'not restricted'}`, ephemeral: true });
            return;
        }
        if (action === 'disable-gambling' || action === 'enable-gambling') {
            economy.config.gamblingEnabled = action === 'enable-gambling';
            await interaction.reply({ content: `Gambling is now ${economy.config.gamblingEnabled ? 'enabled' : 'disabled'}.`, ephemeral: true });
            await integration.audit(interaction.guild, 'Gambling setting changed', `${interaction.user} ${economy.config.gamblingEnabled ? 'enabled' : 'disabled'} gambling.`);
            return;
        }
        if (action === 'exclude-channel' || action === 'include-channel') {
            const channel = interaction.options.getChannel('channel', true);
            if (action === 'exclude-channel') economy.excludedChannels.add(channel.id); else economy.excludedChannels.delete(channel.id);
            await interaction.reply({ content: `${channel} is now ${action === 'exclude-channel' ? 'excluded from' : 'included in'} text rewards until changed in desktop settings.`, ephemeral: true });
            await integration.audit(interaction.guild, 'Economy channel changed', `${interaction.user} used ${action} for ${channel}.`);
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
        await integration.audit(interaction.guild, 'Economy administration', `${interaction.user} used **${action}** on ${user} ${amount ? `for ${money(amount)}` : ''}. New balance: ${money(member.balance)}.`);
    }

    integration.handleCommand = async interaction => {
        if (!interaction.isChatInputCommand()) return priorHandleCommand(interaction);
        if (interaction.commandName === 'gamble') {
            await interaction.reply(gambleMenuPayload(economy.config.currencyName));
            return true;
        }
        if (interaction.commandName === 'eco') {
            try {
                await handleEco(interaction);
            } catch (error) {
                const payload = { content: `❌ ${error.message}`, ephemeral: true };
                if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {}); else await interaction.reply(payload).catch(() => {});
            }
            return true;
        }
        return priorHandleCommand(interaction);
    };

    client.on('interactionCreate', async interaction => {
        try {
            if (interaction.isStringSelectMenu() && interaction.customId === 'econ:gamble:menu') {
                await interaction.showModal(wagerModal(interaction.values[0]));
                return;
            }
            if (interaction.isModalSubmit() && interaction.customId.startsWith('econ:gamble:modal:')) {
                await handleGambleModal(interaction);
            }
        } catch (error) {
            const payload = { content: `❌ ${error.message}`, ephemeral: true };
            if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {}); else await interaction.reply(payload).catch(() => {});
        }
    });

    return integration;
};

module.exports = { gambleMenuPayload, wagerModal, buildEcoCommand };
