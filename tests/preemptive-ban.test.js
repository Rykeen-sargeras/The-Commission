const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const listedUserId = '123456789012345678';
const logChannelId = '234567890123456789';
const banReason = 'Blocked by local security list';
const sentMessages = [];
let banOptions;

process.env.DISCORD_TOKEN = 'unit-test-token';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'commission-ban-test-'));
process.env.LOG_CHANNEL_ID = logChannelId;
process.env.PREEMPTIVE_BAN_USER_IDS = `${listedUserId},${listedUserId}`;
process.env.PREEMPTIVE_BAN_REASON = banReason;
process.env.ALT_DETECTION_ENABLED = 'false';

class MockEmbedBuilder {
    constructor() {
        this.data = { fields: [] };
    }
    setColor(value) { this.data.color = value; return this; }
    setTitle(value) { this.data.title = value; return this; }
    setAuthor(value) { this.data.author = value; return this; }
    setThumbnail(value) { this.data.thumbnail = value; return this; }
    addFields(...fields) { this.data.fields.push(...fields); return this; }
    setFooter(value) { this.data.footer = value; return this; }
    setTimestamp() { this.data.timestamp = true; return this; }
}

class MockClient extends EventEmitter {
    constructor() {
        super();
        this.channels = {
            fetch: async id => {
                assert.strictEqual(id, logChannelId);
                return {
                    isTextBased: () => true,
                    send: async payload => sentMessages.push(payload),
                };
            },
        };
        this.guilds = { cache: new Map() };
        global.__commissionTestClient = this;
    }
    login() {
        return Promise.resolve();
    }
}

const discordMock = {
    Client: MockClient,
    EmbedBuilder: MockEmbedBuilder,
    GatewayIntentBits: new Proxy({}, { get: (_target, key) => key }),
    Partials: new Proxy({}, { get: (_target, key) => key }),
    PermissionFlagsBits: new Proxy({}, { get: (_target, key) => key }),
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'discord.js') return discordMock;
    if (request === './discord_features' && parent?.filename?.endsWith('discord_bot.js')) {
        return { installDiscordFeatures: () => {} };
    }
    return originalLoad.call(this, request, parent, isMain);
};

require('../discord_bot.js');

async function run() {
    const client = global.__commissionTestClient;
    assert(client, 'The bot client was not created');

    const joinHandler = client.listeners('guildMemberAdd')[0];
    assert(joinHandler, 'The preemptive-ban join handler was not registered');

    const avatarUrl = 'https://cdn.discordapp.com/avatars/test/snapshot.png';
    const member = {
        displayName: 'Snapshot Display Name',
        user: {
            id: listedUserId,
            username: 'snapshot_user',
            tag: 'snapshot_user',
            globalName: 'Snapshot Global Name',
            createdTimestamp: 1_700_000_000_000,
            displayAvatarURL: options => {
                assert.deepStrictEqual(options, { extension: 'png', size: 256 });
                return avatarUrl;
            },
        },
        ban: async options => {
            banOptions = options;
        },
    };

    await joinHandler(member);

    assert.deepStrictEqual(banOptions, {
        deleteMessageSeconds: 0,
        reason: banReason,
    });
    assert.strictEqual(sentMessages.length, 1);

    const embed = sentMessages[0].embeds[0].data;
    assert.strictEqual(embed.title, 'Preemptive Ban Enforced');
    assert.strictEqual(embed.thumbnail, avatarUrl);
    assert.strictEqual(embed.author.name, 'snapshot_user');
    assert.strictEqual(embed.author.iconURL, avatarUrl);

    const fields = Object.fromEntries(embed.fields.map(field => [field.name, field.value]));
    assert.strictEqual(fields.Username, 'snapshot_user');
    assert.strictEqual(fields['Display Name'], 'Snapshot Display Name');
    assert.strictEqual(fields['User ID'], listedUserId);
    assert.strictEqual(fields.Reason, banReason);
    assert.strictEqual(fields.Result, 'Banned immediately on join');

    console.log('Preemptive ban enforcement and identity snapshot test passed.');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
