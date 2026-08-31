'use strict';

const fs = require('fs');
const path = require('path');
const Discord = require('discord.js');

const FIRST_TICKET_NUMBER = 30001;
const TICKET_TOPIC_PREFIX = 'commission-ticket-user:';
const CLOSED_TICKET_TOPIC_PREFIX = 'commission-ticket-closed-user:';
const INSTALL_KEY = Symbol.for('the-commission.dm-tickets-installed');

function safeChannelPart(value) {
    return String(value || 'member')
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) || 'member';
}

function splitIds(value) {
    const values = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
    return [...new Set(values.map(id => String(id).trim()).filter(Boolean))];
}

function createTicketNumberAllocator(dataDir, options = {}) {
    const fileSystem = options.fileSystem || fs;
    const firstTicketNumber = options.firstTicketNumber || FIRST_TICKET_NUMBER;
    const counterPath = path.join(dataDir, 'dm-ticket-counter.json');
    let nextTicketNumber = firstTicketNumber;

    try {
        const saved = JSON.parse(fileSystem.readFileSync(counterPath, 'utf8'));
        if (Number.isSafeInteger(saved.nextTicketNumber) && saved.nextTicketNumber >= firstTicketNumber) {
            nextTicketNumber = saved.nextTicketNumber;
        }
    } catch (_error) {
        // Missing or invalid state starts a new sequence at FIRST_TICKET_NUMBER.
    }

    return function allocateTicketNumber() {
        const ticketNumber = nextTicketNumber;
        nextTicketNumber += 1;
        fileSystem.mkdirSync(dataDir, { recursive: true });
        fileSystem.writeFileSync(counterPath, `${JSON.stringify({ nextTicketNumber }, null, 2)}\n`, 'utf8');
        return ticketNumber;
    };
}

function findOpenTicketChannel(channels, userId, categoryId) {
    return [...channels.values()].find(channel => (
        String(channel.parentId || '') === String(categoryId || '')
        && String(channel.name || '').startsWith('ticket-')
        && channel.topic === `${TICKET_TOPIC_PREFIX}${userId}`
    )) || null;
}

function messageSummary(message) {
    const text = String(message.content || '').trim() || '(No text was included.)';
    const attachments = [...(message.attachments?.values?.() || [])]
        .map(attachment => attachment.url)
        .filter(Boolean);
    return {
        text: text.slice(0, 1024),
        attachments: attachments.length ? attachments.join('\n').slice(0, 1024) : '',
    };
}

function defaultConfig() {
    return {
        categoryId: process.env.TICKET_CATEGORY_ID || process.env.REPORT_CATEGORY_ID || '',
        staffRoleIds: splitIds(process.env.STAFF_ROLE_IDS),
        ownerUserId: process.env.OWNER_USER_ID || '',
        dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
    };
}

function createDMTicketSystem(client, config = defaultConfig(), options = {}) {
    const categoryId = String(config.categoryId || '');
    const staffRoleIds = splitIds(config.staffRoleIds);
    const ownerUserId = String(config.ownerUserId || '');
    const allocateTicketNumber = options.allocateTicketNumber
        || createTicketNumberAllocator(config.dataDir || path.join(__dirname, 'data'), options);
    const closeDelayMs = Number.isFinite(options.closeDelayMs) ? Math.max(0, options.closeDelayMs) : 5000;
    const queues = new Map();

    function configuredStaffRoles(guild) {
        return staffRoleIds.map(id => guild.roles.cache.get(id)).filter(Boolean);
    }

    async function memberGuild(userId) {
        for (const guild of client.guilds.cache.values()) {
            const cached = guild.members.cache.has(userId);
            if (cached) return guild;
            const member = await guild.members.fetch(userId).catch(() => null);
            if (member) return guild;
        }
        return null;
    }

    async function processMessage(message) {
        const user = message.author;
        const guild = await memberGuild(user.id);
        if (!guild) {
            await message.reply('You must be a member of the server before I can open a private ticket for you.');
            return null;
        }
        if (!categoryId) {
            await message.reply('The mod ticket category has not been configured yet. Please contact a server administrator.');
            return null;
        }

        const channels = await guild.channels.fetch();
        const category = channels.get(categoryId);
        if (!category || category.type !== Discord.ChannelType.GuildCategory) {
            await message.reply('The configured mod ticket category is unavailable. Please contact a server administrator.');
            return null;
        }

        const summary = messageSummary(message);
        const existingChannel = findOpenTicketChannel(channels, user.id, categoryId);
        if (existingChannel) {
            const embed = new Discord.EmbedBuilder()
                .setColor('#5865F2')
                .setTitle(`New DM from ${user.username}`)
                .setDescription(summary.text)
                .setTimestamp();
            if (summary.attachments) embed.addFields({ name: 'Attachments', value: summary.attachments });
            await existingChannel.send({ embeds: [embed], allowedMentions: { parse: [] } });
            await message.reply(`Your message was added to <#${existingChannel.id}>.`);
            return existingChannel;
        }

        const ticketNumber = allocateTicketNumber();
        const staffRoles = configuredStaffRoles(guild);
        const channel = await guild.channels.create({
            name: `ticket-${ticketNumber}-${safeChannelPart(user.username)}`,
            type: Discord.ChannelType.GuildText,
            parent: categoryId,
            topic: `${TICKET_TOPIC_PREFIX}${user.id}`,
            permissionOverwrites: [
                { id: guild.roles.everyone.id, deny: [Discord.PermissionFlagsBits.ViewChannel] },
                {
                    id: user.id,
                    allow: [
                        Discord.PermissionFlagsBits.ViewChannel,
                        Discord.PermissionFlagsBits.SendMessages,
                        Discord.PermissionFlagsBits.ReadMessageHistory,
                        Discord.PermissionFlagsBits.AttachFiles,
                    ],
                },
                ...staffRoles.map(role => ({
                    id: role.id,
                    allow: [
                        Discord.PermissionFlagsBits.ViewChannel,
                        Discord.PermissionFlagsBits.SendMessages,
                        Discord.PermissionFlagsBits.ReadMessageHistory,
                        Discord.PermissionFlagsBits.ManageMessages,
                    ],
                })),
            ],
            reason: `DM ticket #${ticketNumber} opened by ${user.tag}`,
        });

        const embed = new Discord.EmbedBuilder()
            .setColor('#5865F2')
            .setTitle(`Ticket #${ticketNumber} (${user.username})`)
            .setThumbnail(user.displayAvatarURL())
            .addFields(
                { name: 'Opened By', value: `<@${user.id}> (${user.tag})` },
                { name: 'First DM', value: summary.text },
                { name: 'Status', value: 'Open — awaiting moderator response' },
            )
            .setFooter({ text: 'Staff: use !close in this channel to remove the member’s access' })
            .setTimestamp();
        if (summary.attachments) embed.addFields({ name: 'Attachments', value: summary.attachments });

        const mentions = [];
        if (ownerUserId) mentions.push(`<@${ownerUserId}>`);
        mentions.push(...staffRoles.map(role => `<@&${role.id}>`), `<@${user.id}>`);
        await channel.send({
            content: mentions.join(' '),
            embeds: [embed],
            allowedMentions: {
                users: [ownerUserId, user.id].filter(Boolean),
                roles: staffRoles.map(role => role.id),
            },
        });

        options.onAudit?.(
            'DM Ticket Created',
            { tag: user.tag, id: user.id },
            `Ticket #${ticketNumber} opened from a direct message`,
            'warning',
        );
        await message.reply(`Your private ticket is ready: <#${channel.id}>. Continue the conversation there.`);
        return channel;
    }

    async function handleDirectMessage(message) {
        const userId = message.author.id;
        const previous = queues.get(userId) || Promise.resolve();
        const task = previous
            .catch(() => {})
            .then(() => processMessage(message))
            .catch(async error => {
                console.error('[DM tickets] Could not process message:', error);
                await message.reply('I could not open your ticket. Please contact a server administrator.').catch(() => null);
                return null;
            })
            .finally(() => {
                if (queues.get(userId) === task) queues.delete(userId);
            });
        queues.set(userId, task);
        return task;
    }

    function canClose(message) {
        if (String(message.author.id) === ownerUserId) return true;
        if (message.member?.permissions?.has?.(Discord.PermissionFlagsBits.ManageChannels)) return true;
        return staffRoleIds.some(id => message.member?.roles?.cache?.has?.(id));
    }

    async function handleClose(message) {
        if (!message.guild || !message.channel) return false;
        const topic = String(message.channel.topic || '');
        const openTicket = topic.startsWith(TICKET_TOPIC_PREFIX);
        const closedTicket = topic.startsWith(CLOSED_TICKET_TOPIC_PREFIX);
        if (!openTicket && !closedTicket) return false;
        if (!/^\s*[!/](?:ticket-?)?close\s*$/iu.test(String(message.content || ''))) return false;
        if (!canClose(message)) {
            await message.reply('Only configured staff can close this ticket.');
            return true;
        }

        if (closedTicket) {
            await message.channel.delete?.(`Delete previously closed DM ticket at ${message.author.tag}`);
            return true;
        }

        const userId = topic.slice(TICKET_TOPIC_PREFIX.length);
        await message.channel.permissionOverwrites.edit(userId, {
            ViewChannel: false,
            SendMessages: false,
            ReadMessageHistory: false,
        }, { reason: `Ticket closed by ${message.author.tag}` });
        if (message.channel.setTopic) {
            await message.channel.setTopic(`${CLOSED_TICKET_TOPIC_PREFIX}${userId}`, 'Archive closed DM ticket');
        }
        if (message.channel.setName && !message.channel.name.startsWith('closed-')) {
            await message.channel.setName(`closed-${message.channel.name}`.slice(0, 100), 'Archive closed DM ticket');
        }
        await message.channel.send({
            content: `🔒 Ticket closed by <@${message.author.id}>. The submitting member’s temporary access was removed.`,
            allowedMentions: { users: [message.author.id] },
        });
        const deleteTicket = () => message.channel.delete?.('Delete closed DM ticket')
            .catch(error => console.error(`[DM tickets] Could not delete ${message.channel.name}:`, error));
        if (closeDelayMs === 0) {
            await deleteTicket();
        } else {
            const timer = setTimeout(deleteTicket, closeDelayMs);
            timer.unref?.();
        }
        return true;
    }

    return { handleClose, handleDirectMessage, processMessage };
}

function installDMTicketSystem(client, config = defaultConfig(), options = {}) {
    if (!client || client[INSTALL_KEY]) return client;
    client[INSTALL_KEY] = true;
    const system = createDMTicketSystem(client, config, options);
    client.on(Discord.Events.MessageCreate || 'messageCreate', async message => {
        if (!message?.author || message.author.bot) return;
        if (!message.guild) return system.handleDirectMessage(message);
        await system.handleClose(message);
    });
    return client;
}

module.exports = {
    CLOSED_TICKET_TOPIC_PREFIX,
    FIRST_TICKET_NUMBER,
    TICKET_TOPIC_PREFIX,
    createDMTicketSystem,
    createTicketNumberAllocator,
    defaultConfig,
    findOpenTicketChannel,
    installDMTicketSystem,
    messageSummary,
    safeChannelPart,
    splitIds,
};

