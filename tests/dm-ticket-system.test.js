'use strict';

const assert = require('assert');
const Module = require('module');

class EmbedBuilder {
    setColor() { return this; }
    setTitle(value) { this.title = value; return this; }
    setDescription(value) { this.description = value; return this; }
    setThumbnail() { return this; }
    addFields(...fields) { this.fields = [...(this.fields || []), ...fields]; return this; }
    setFooter() { return this; }
    setTimestamp() { return this; }
}

class Client { login() { return Promise.resolve('token'); } }
const Discord = {
    ChannelType: { GuildCategory: 4, GuildText: 0 },
    Client,
    EmbedBuilder,
    Events: { MessageCreate: 'messageCreate' },
    PermissionFlagsBits: {
        ViewChannel: 1n,
        SendMessages: 2n,
        ReadMessageHistory: 4n,
        AttachFiles: 8n,
        ManageMessages: 16n,
        ManageChannels: 32n,
    },
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (request === 'discord.js') return Discord;
    return originalLoad.call(this, request, parent, isMain);
};
const {
    CLOSED_TICKET_TOPIC_PREFIX,
    createDMTicketSystem,
    createTicketNumberAllocator,
    findOpenTicketChannel,
    safeChannelPart,
} = require('../dm_ticket_system');
Module._load = originalLoad;

function createMemoryFileSystem() {
    const files = new Map();
    return {
        mkdirSync() {},
        readFileSync(filePath) {
            if (!files.has(filePath)) throw new Error('ENOENT');
            return files.get(filePath);
        },
        writeFileSync(filePath, value) { files.set(filePath, value); },
    };
}

assert.strictEqual(safeChannelPart('Some User_Name!'), 'some-user-name');
const memoryFileSystem = createMemoryFileSystem();
let allocate = createTicketNumberAllocator('/data', { fileSystem: memoryFileSystem });
assert.strictEqual(allocate(), 30001);
assert.strictEqual(allocate(), 30002);
allocate = createTicketNumberAllocator('/data', { fileSystem: memoryFileSystem });
assert.strictEqual(allocate(), 30003);

(async () => {
    let createCount = 0;
    let deleteCount = 0;
    const replies = [];
    const channelMessages = [];
    const permissionEdits = [];
    const category = { id: 'mod-category', type: Discord.ChannelType.GuildCategory };
    const channels = new Map([[category.id, category]]);
    const roles = new Map([['staff', { id: 'staff' }]]);
    const guild = {
        id: 'guild',
        roles: { everyone: { id: 'everyone' }, cache: roles },
        members: { cache: new Map([['member', true]]), fetch: async id => ({ id }) },
        channels: {
            fetch: async () => channels,
            create: async options => {
                createCount += 1;
                assert.deepStrictEqual(options.permissionOverwrites.map(item => item.id), ['everyone', 'member', 'staff']);
                const channel = {
                    id: 'ticket-channel',
                    name: options.name,
                    parentId: options.parent,
                    topic: options.topic,
                    permissionOverwrites: { edit: async (...args) => { permissionEdits.push(args); } },
                    send: async payload => { channelMessages.push(payload); },
                    setName: async value => { channel.name = value; },
                    setTopic: async value => { channel.topic = value; },
                    delete: async () => { deleteCount += 1; },
                };
                channels.set(channel.id, channel);
                return channel;
            },
        },
    };
    const guildCache = new Map([['guild', guild]]);
    const client = { guilds: { cache: guildCache } };
    const user = {
        id: 'member', username: 'Some_User', tag: 'Some_User#0001', bot: false,
        displayAvatarURL: () => 'https://example.test/avatar.png',
    };
    const system = createDMTicketSystem(client, {
        categoryId: 'mod-category', dataDir: '/data', staffRoleIds: ['staff', 'stale-role'], ownerUserId: 'owner',
    }, { allocateTicketNumber: () => 30001, closeDelayMs: 0 });

    const firstMessage = {
        author: user, content: 'I need help.', attachments: new Map(),
        reply: async value => { replies.push(value); },
    };
    await system.handleDirectMessage(firstMessage);
    const channel = channels.get('ticket-channel');
    assert.strictEqual(createCount, 1);
    assert.strictEqual(channel.name, 'ticket-30001-some-user');
    assert.strictEqual(channel.topic, 'commission-ticket-user:member');
    assert.strictEqual(channelMessages[0].embeds[0].title, 'Ticket #30001 (Some_User)');
    assert.match(replies[0], /private ticket is ready/);
    assert.strictEqual(findOpenTicketChannel(channels, 'member', 'mod-category'), channel);

    await system.handleDirectMessage({ ...firstMessage, content: 'Another detail.' });
    assert.strictEqual(createCount, 1);
    assert.strictEqual(channelMessages[1].embeds[0].description, 'Another detail.');

    const closed = await system.handleClose({
        author: { id: 'moderator', tag: 'Mod#0001' }, guild, channel, content: '!close',
        member: { roles: { cache: new Map([['staff', true]]) }, permissions: { has: () => false } },
        reply: async () => {},
    });
    assert.strictEqual(closed, true);
    assert.strictEqual(permissionEdits[0][0], 'member');
    assert.strictEqual(channel.topic, `${CLOSED_TICKET_TOPIC_PREFIX}member`);
    assert.strictEqual(channel.name, 'closed-ticket-30001-some-user');
    assert.strictEqual(findOpenTicketChannel(channels, 'member', 'mod-category'), null);
    assert.strictEqual(deleteCount, 1);

    console.log('dm-ticket-system tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

