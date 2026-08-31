'use strict';

const assert = require('assert');
const Module = require('module');

class Client { login() { return Promise.resolve('token'); } }
const originalLogin = Client.prototype.login;
const permissionNames = [
    'ViewChannel', 'Connect', 'SendMessages', 'ReadMessageHistory', 'AddReactions',
    'EmbedLinks', 'AttachFiles', 'UseExternalEmojis', 'UseExternalStickers',
    'CreatePublicThreads', 'CreatePrivateThreads', 'SendMessagesInThreads',
    'Speak', 'Stream', 'UseVAD', 'MentionEveryone', 'ManageMessages',
    'ManageThreads', 'MuteMembers', 'DeafenMembers',
];
const PermissionFlagsBits = Object.fromEntries(permissionNames.map((name, index) => [name, 1n << BigInt(index)]));
const allPermissions = Object.values(PermissionFlagsBits).reduce((value, flag) => value | flag, 0n);
const Discord = {
    Client,
    Events: { ClientReady: 'ready' },
    OverwriteType: { Role: 0 },
    PermissionFlagsBits,
    PermissionsBitField: { All: allPermissions },
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (request === 'discord.js') return Discord;
    return originalLoad.call(this, request, parent, isMain);
};
const {
    CATEGORY_IDS,
    TARGET_ROLE_IDS,
    permissionBits,
    permissionProfileForChannel,
    planRoleOverwrites,
    syncConfiguredRolePermissions,
} = require('../youtube_role_permissions');
Module._load = originalLoad;

assert.strictEqual(Client.prototype.login, originalLogin, 'importing the module must not patch Discord.Client.login');

assert.strictEqual(TARGET_ROLE_IDS.length, 14);
assert.deepStrictEqual(CATEGORY_IDS, {
    announcement: '1532513761573863577',
    text: '1532513763918483497',
    liveOnAir: '1532513765701189683',
    voice: '1532513764660871180',
});

const readOnly = permissionBits(['ViewChannel', 'ReadMessageHistory', 'AddReactions', 'UseExternalEmojis']);
assert.strictEqual(permissionProfileForChannel({ id: CATEGORY_IDS.announcement, name: 'ANNOUNCEMENT' }), readOnly);
assert.strictEqual(permissionProfileForChannel({ parentId: CATEGORY_IDS.announcement, name: 'rules' }), readOnly);
assert.strictEqual(
    permissionProfileForChannel({ parentId: CATEGORY_IDS.announcement, name: 'verify-membership' }),
    permissionBits(['ViewChannel', 'ReadMessageHistory']),
);
assert.strictEqual(
    permissionProfileForChannel({ parentId: CATEGORY_IDS.liveOnAir, name: 'LIVE 1' }) & PermissionFlagsBits.Connect,
    0n,
);
assert.notStrictEqual(
    permissionProfileForChannel({ parentId: CATEGORY_IDS.liveOnAir, name: 'Waiting' }) & PermissionFlagsBits.Connect,
    0n,
);
assert.strictEqual(permissionProfileForChannel({ parentId: 'outside', name: 'private' }), null);

const existing = new Map([
    ['everyone', { id: 'everyone', type: 0, allow: 1n, deny: 2n }],
    [TARGET_ROLE_IDS[0], { id: TARGET_ROLE_IDS[0], type: 0, allow: 0n, deny: 0n }],
]);
const plan = planRoleOverwrites(existing, TARGET_ROLE_IDS.slice(0, 2), readOnly);
assert.strictEqual(plan.changed, true);
assert.strictEqual(plan.overwrites.find(item => item.id === 'everyone').allow, 1n);
assert.strictEqual(plan.overwrites.find(item => item.id === TARGET_ROLE_IDS[0]).allow, readOnly);
assert.strictEqual(plan.overwrites.find(item => item.id === TARGET_ROLE_IDS[1]).deny, allPermissions & ~readOnly);

(async () => {
    const roleCache = new Map([
        [TARGET_ROLE_IDS[0], { id: TARGET_ROLE_IDS[0] }],
        [TARGET_ROLE_IDS[1], { id: TARGET_ROLE_IDS[1] }],
        ['unrelated-role', { id: 'unrelated-role' }],
    ]);
    const writes = new Map();
    const makeChannel = (id, name, parentId) => ({
        id, name, parentId,
        permissionOverwrites: {
            cache: new Map([['unrelated-role', { id: 'unrelated-role', type: 0, allow: 3n, deny: 0n }]]),
            set: async values => writes.set(id, values),
        },
    });
    const announcement = makeChannel('announcement-child', 'rules', CATEGORY_IDS.announcement);
    const text = makeChannel('text-child', 'main', CATEGORY_IDS.text);
    const live = makeChannel('live-child', 'LIVE 1', CATEGORY_IDS.liveOnAir);
    const outside = makeChannel('outside-child', 'mod-chat', 'outside-category');
    const channels = new Map([
        [announcement.id, announcement], [text.id, text], [live.id, live], [outside.id, outside],
    ]);
    const guild = {
        roles: { cache: roleCache, fetch: async () => null },
        channels: { cache: channels, fetch: async () => null },
    };
    const result = await syncConfiguredRolePermissions(guild, {
        targetRoleIds: TARGET_ROLE_IDS.slice(0, 2),
        logger: { log() {}, warn() {} },
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.changedChannels, 3);
    assert.strictEqual(writes.has(outside.id), false);
    assert.strictEqual(writes.get(text.id).filter(item => TARGET_ROLE_IDS.includes(item.id)).length, 2);
    assert.strictEqual(writes.get(text.id).find(item => item.id === 'unrelated-role').allow, 3n);

    console.log('configured-role-permissions tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

