'use strict';

const assert = require('assert');
const Module = require('module');

class Client { login() { return Promise.resolve('token'); } }
const Discord = {
    Client,
    ChannelType: { GuildVoice: 2 },
    OverwriteType: { Role: 0 },
    PermissionFlagsBits: {
        ViewChannel: 1n,
        Connect: 2n,
        Speak: 4n,
        Stream: 8n,
        UseVAD: 16n,
    },
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (request === 'discord.js') return Discord;
    return originalLoad.call(this, request, parent, isMain);
};
const { OPEN_PANEL_NAME, ensureOpenPanel, isOpenPanel } = require('../open_panel_preload');
Module._load = originalLoad;

assert.strictEqual(OPEN_PANEL_NAME, '🟢 OPEN PANEL 🟢');

(async () => {
    const channel = {
        id: 'open',
        name: '🟢 OPEN PANNEL 🟢',
        parentId: '1532513765701189683',
        rawPosition: 1,
        permissionOverwrites: { set: async () => null },
        setName: async value => { channel.name = value; },
    };
    assert.strictEqual(isOpenPanel(channel), true);
    const guild = {
        id: 'guild',
        channels: {
            cache: new Map([[channel.id, channel]]),
            fetch: async () => null,
            create: async () => { throw new Error('should reuse existing misspelled channel'); },
            setPositions: async () => null,
        },
        roles: {
            cache: new Map(),
            everyone: { id: 'everyone' },
            fetch: async () => null,
        },
    };
    await ensureOpenPanel(guild);
    assert.strictEqual(channel.name, OPEN_PANEL_NAME);
    console.log('open-panel-preload tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

