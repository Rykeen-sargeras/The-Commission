'use strict';

const assert = require('assert');
const {
    findExistingJailChannel,
    installManualJailRoleWorkflow,
    wasJailRoleAdded,
} = require('../manual_jail_role');

function memberWithRoles(...roles) {
    return { roles: { cache: new Map(roles.map(id => [id, true])) } };
}

assert.strictEqual(wasJailRoleAdded(memberWithRoles(), memberWithRoles('jail'), 'jail'), true);
assert.strictEqual(wasJailRoleAdded(memberWithRoles('jail'), memberWithRoles('jail'), 'jail'), false);

const existing = {
    id: 'existing',
    name: 'jail-member-1234',
    parentId: 'category',
    permissionOverwrites: { cache: new Map([['member', true]]) },
};
assert.strictEqual(findExistingJailChannel(new Map([['existing', existing]]), 'member', 'category'), existing);

class EmbedBuilder {
    setColor() { return this; }
    setTitle() { return this; }
    setDescription() { return this; }
    setThumbnail() { return this; }
    addFields() { return this; }
    setTimestamp() { return this; }
}

const Discord = {
    AuditLogEvent: { MemberRoleUpdate: 25 },
    ChannelType: { GuildCategory: 4, GuildText: 0 },
    PermissionFlagsBits: {
        ViewChannel: 1n,
        SendMessages: 2n,
        ReadMessageHistory: 4n,
        ManageMessages: 8n,
    },
    EmbedBuilder,
};

(async () => {
    let listener;
    let created = 0;
    let modNotices = 0;
    let jailNotice = '';
    let createOptions;
    const modChannel = { isTextBased: () => true, send: async () => { modNotices += 1; } };
    const category = { id: 'category', type: Discord.ChannelType.GuildCategory };
    const channels = new Map([['category', category]]);
    const roles = new Map([['staff', { id: 'staff' }]]);
    const guild = {
        id: 'guild',
        roles: {
            everyone: { id: 'everyone' },
            cache: roles,
            fetch: async () => roles,
        },
        fetchAuditLogs: async () => ({ entries: new Map() }),
        channels: {
            fetch: async id => id === 'mods' ? modChannel : channels,
            create: async options => {
                createOptions = options;
                const resolvableIds = new Set(['everyone', 'member', 'staff']);
                if (options.permissionOverwrites.some(overwrite => !resolvableIds.has(overwrite.id))) {
                    throw new TypeError('Supplied parameter is not a cached User or Role.');
                }
                created += 1;
                const channel = {
                    id: 'new-jail',
                    name: options.name,
                    parentId: options.parent,
                    permissionOverwrites: { cache: new Map([['member', true]]) },
                    send: async message => { jailNotice = message.content; },
                };
                channels.set(channel.id, channel);
                return channel;
            },
        },
    };
    const oldMember = { ...memberWithRoles(), id: 'member' };
    const newMember = {
        ...memberWithRoles('jail'),
        id: 'member',
        guild,
        user: {
            username: 'Member_Name',
            tag: 'Member_Name#0001',
            displayAvatarURL: () => 'https://example.test/avatar.png',
        },
    };
    const client = { on: (_event, handler) => { listener = handler; } };

    installManualJailRoleWorkflow(client, Discord, {
        jailRoleId: 'jail',
        jailCategoryId: 'category',
        modChannelId: 'mods',
        staffRoleIds: ['staff', 'stale-role', 'staff', ''],
    }, { delayMs: 0, reconcileOnReady: false });

    await listener(oldMember, newMember);
    assert.strictEqual(created, 1);
    assert.strictEqual(modNotices, 1);
    assert.deepStrictEqual(createOptions.permissionOverwrites.map(overwrite => overwrite.id), ['everyone', 'member', 'staff']);
    assert.strictEqual(jailNotice, '<@&staff> <@member>');

    const before = created;
    await listener(newMember, newMember);
    assert.strictEqual(created, before);
    console.log('manual-jail-role tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
