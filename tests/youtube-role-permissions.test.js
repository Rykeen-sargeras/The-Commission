'use strict';

const assert = require('assert');
const Module = require('module');

class Client { login() { return Promise.resolve('token'); } }
const Discord = {
    Client,
    Events: { ClientReady: 'ready' },
    OverwriteType: { Role: 0 },
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (request === 'discord.js') return Discord;
    return originalLoad.call(this, request, parent, isMain);
};
const {
    integrationId,
    normalizeRoleName,
    planChannelOverwrites,
    syncGuildYouTubeRolePermissions,
    youtubeRoleSet,
} = require('../youtube_role_permissions');
Module._load = originalLoad;

assert.strictEqual(normalizeRoleName('  Scooter—VIP  '), 'scooter vip');
assert.strictEqual(integrationId({ tags: { integrationId: 'youtube-1' } }), 'youtube-1');

const source = { id: 'source', name: 'Scooter VIP', tags: { integrationId: 'youtube-1' }, permissions: { bitfield: 8n } };
const sibling = { id: 'sibling', name: 'Scooter Member', tags: { integrationId: 'youtube-1' }, permissions: { bitfield: 4n } };
const otherIntegration = { id: 'other', name: 'Twitch Subscriber', tags: { integrationId: 'twitch-1' }, permissions: { bitfield: 4n } };
const selection = youtubeRoleSet({ roles: { cache: new Map([[source.id, source], [sibling.id, sibling], [otherIntegration.id, otherIntegration]]) } });
assert.strictEqual(selection.source, source);
assert.deepStrictEqual(selection.targets, [sibling]);

const overwrites = new Map([
    ['everyone', { id: 'everyone', type: 0, allow: { bitfield: 0n }, deny: { bitfield: 1n } }],
    ['source', { id: 'source', type: 0, allow: { bitfield: 6n }, deny: { bitfield: 8n } }],
    ['sibling', { id: 'sibling', type: 0, allow: { bitfield: 2n }, deny: { bitfield: 0n } }],
]);
const plan = planChannelOverwrites(overwrites, 'source', ['sibling']);
assert.strictEqual(plan.changed, true);
const plannedSibling = plan.overwrites.find(item => item.id === 'sibling');
assert.strictEqual(plannedSibling.allow, 6n);
assert.strictEqual(plannedSibling.deny, 8n);
assert.strictEqual(plan.overwrites.find(item => item.id === 'everyone').deny, 1n);

const inheritedPlan = planChannelOverwrites(
    new Map([['sibling', { id: 'sibling', type: 0, allow: { bitfield: 1n }, deny: { bitfield: 0n } }]]),
    'source',
    ['sibling'],
);
assert.strictEqual(inheritedPlan.changed, true);
assert.strictEqual(inheritedPlan.overwrites.some(item => item.id === 'sibling'), false);

(async () => {
    let copiedBasePermissions = null;
    let replacementOverwrites = null;
    sibling.editable = true;
    sibling.setPermissions = async permissions => { copiedBasePermissions = permissions.bitfield; sibling.permissions = permissions; };
    const channel = {
        id: 'channel', name: 'members',
        permissionOverwrites: {
            cache: overwrites,
            set: async values => { replacementOverwrites = values; },
        },
    };
    const guild = {
        roles: {
            cache: new Map([[source.id, source], [sibling.id, sibling], [otherIntegration.id, otherIntegration]]),
            fetch: async () => null,
        },
        channels: { cache: new Map([[channel.id, channel]]), fetch: async () => null },
    };
    const result = await syncGuildYouTubeRolePermissions(guild, { logger: { log() {}, warn() {} } });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.targetRoleNames, ['Scooter Member']);
    assert.strictEqual(result.changedRoles, 1);
    assert.strictEqual(result.changedChannels, 1);
    assert.strictEqual(copiedBasePermissions, 8n);
    assert.strictEqual(replacementOverwrites.find(item => item.id === 'sibling').allow, 6n);

    console.log('youtube-role-permissions tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

