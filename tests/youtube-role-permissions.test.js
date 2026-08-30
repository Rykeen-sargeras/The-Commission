'use strict';

const assert = require('assert');
const Module = require('module');

class Client { login() { return Promise.resolve('token'); } }
const Discord = {
    Client,
    Events: { ClientReady: 'ready' },
    OverwriteType: { Role: 0 },
    PermissionsBitField: { All: 15n },
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (request === 'discord.js') return Discord;
    return originalLoad.call(this, request, parent, isMain);
};
const {
    REQUIRED_CATEGORY_IDS,
    integrationId,
    fetchYouTubeIntegrationIds,
    normalizeRoleName,
    planChannelOverwrites,
    syncGuildYouTubeRolePermissions,
    youtubeRoleSet,
} = require('../youtube_role_permissions');
Module._load = originalLoad;

assert.strictEqual(normalizeRoleName('  Scooter—VIP  '), 'scooter vip');
assert.strictEqual(integrationId({ tags: { integrationId: 'youtube-1' } }), 'youtube-1');
assert.deepStrictEqual(REQUIRED_CATEGORY_IDS, [
    '1532513761573863577',
    '1532513763918483497',
    '1532513765701189683',
    '1532513764660871180',
]);

const source = { id: 'source', name: 'Scooter VIP', tags: { integrationId: 'youtube-1' }, permissions: { bitfield: 8n } };
const sibling = { id: 'sibling', name: 'Scooter Member', tags: { integrationId: 'youtube-1' }, permissions: { bitfield: 4n } };
const secondYoutube = { id: 'second', name: 'TammyTen Member', tags: { integrationId: 'youtube-2' }, permissions: { bitfield: 2n } };
const otherIntegration = { id: 'other', name: 'Twitch Subscriber', tags: { integrationId: 'twitch-1' }, permissions: { bitfield: 4n } };
const roleCache = new Map([[source.id, source], [sibling.id, sibling], [secondYoutube.id, secondYoutube], [otherIntegration.id, otherIntegration]]);
const selection = youtubeRoleSet({ roles: { cache: roleCache } }, 'Scooter VIP', new Set(['youtube-1', 'youtube-2']));
assert.strictEqual(selection.source, source);
assert.deepStrictEqual(selection.targets, [sibling, secondYoutube]);

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
    secondYoutube.editable = true;
    secondYoutube.setPermissions = async permissions => { secondYoutube.permissions = permissions; };
    const channel = {
        id: 'channel', parentId: '1532513763918483497', name: 'members',
        permissionsFor: role => role.id === source.id ? { bitfield: 6n } : null,
        permissionOverwrites: {
            cache: overwrites,
            set: async values => { replacementOverwrites = values; },
        },
    };
    let inheritedReplacementOverwrites = null;
    const inheritedTextChannel = {
        id: 'inherited-text', parentId: '1532513763918483497', name: 'general',
        permissionsFor: role => role.id === source.id ? { bitfield: 11n } : null,
        permissionOverwrites: {
            cache: new Map(),
            set: async values => { inheritedReplacementOverwrites = values; },
        },
    };
    const guild = {
        roles: {
            cache: roleCache,
            fetch: async () => null,
        },
        channels: {
            cache: new Map([[channel.id, channel], [inheritedTextChannel.id, inheritedTextChannel]]),
            fetch: async () => null,
        },
        fetchIntegrations: async () => new Map([
            ['youtube-1', { id: 'youtube-1', type: 'youtube' }],
            ['youtube-2', { id: 'youtube-2', type: 'YouTube' }],
            ['twitch-1', { id: 'twitch-1', type: 'twitch' }],
        ]),
    };
    assert.deepStrictEqual(
        [...await fetchYouTubeIntegrationIds(guild, { warn() {} })].sort(),
        ['youtube-1', 'youtube-2'],
    );
    const result = await syncGuildYouTubeRolePermissions(guild, { logger: { log() {}, warn() {} } });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.targetRoleNames, ['Scooter Member', 'TammyTen Member']);
    assert.strictEqual(result.changedRoles, 2);
    assert.strictEqual(result.changedChannels, 2);
    assert.deepStrictEqual(result.requiredCategoryIds, REQUIRED_CATEGORY_IDS);
    assert.strictEqual(copiedBasePermissions, 8n);
    assert.strictEqual(replacementOverwrites.find(item => item.id === 'sibling').allow, 6n);
    assert.strictEqual(replacementOverwrites.find(item => item.id === 'second').allow, 6n);
    assert.strictEqual(replacementOverwrites.find(item => item.id === 'sibling').deny, 9n);
    assert.strictEqual(inheritedReplacementOverwrites.find(item => item.id === 'sibling').allow, 11n);
    assert.strictEqual(inheritedReplacementOverwrites.find(item => item.id === 'sibling').deny, 4n);
    assert.strictEqual(inheritedReplacementOverwrites.find(item => item.id === 'second').allow, 11n);

    console.log('youtube-role-permissions tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

