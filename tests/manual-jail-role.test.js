'use strict';

const assert = require('assert');
const {
    findExistingJailChannel,
    installManualJailRoleWorkflow,
    resolveStaffRoles,
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
const existingByTopic = {
    id: 'existing-topic',
    name: 'jail-member-5678',
    parentId: 'category',
    topic: 'commission-jail-user:member;jailed-at:123',
    permissionOverwrites: { cache: new Map() },
};
assert.strictEqual(findExistingJailChannel(new Map([['existing-topic', existingByTopic]]), 'member', 'category'), existingByTopic);

const Discord = {
    AuditLogEvent: { MemberRoleUpdate: 25 },
    Events: { ClientReady: 'ready' },
};

(async () => {
    const roles = new Map([
        ['staff', { id: 'staff', name: 'Staff' }],
        ['mods', { id: 'mods', name: 'Moderators' }],
    ]);
    const resolved = await resolveStaffRoles({
        id: 'guild',
        roles: { cache: roles, fetch: async () => roles },
    }, ['staff', 'missing']);
    assert.deepStrictEqual(resolved.map(role => role.id), ['staff', 'mods']);

    let listener;
    let received = null;
    const actor = { id: 'moderator', tag: 'Moderator#0001' };
    const guild = {
        id: 'guild',
        fetchAuditLogs: async () => ({
            entries: new Map([['entry', {
                target: { id: 'member' },
                executor: actor,
                reason: 'Manual review required',
                createdTimestamp: Date.now(),
            }]]),
        }),
    };
    const oldMember = { ...memberWithRoles(), id: 'member', guild };
    const newMember = { ...memberWithRoles('jail'), id: 'member', guild, user: { id: 'member' } };
    const client = { on: (_event, handler) => { listener = handler; }, once() {} };

    installManualJailRoleWorkflow(client, Discord, { jailRoleId: 'jail' }, {
        delayMs: 0,
        reconcileOnReady: false,
        onJailRoleAdded: async (member, details) => { received = { member, details }; },
    });
    await listener(oldMember, newMember);
    assert.strictEqual(received.member, newMember);
    assert.strictEqual(received.details.actor, actor);
    assert.strictEqual(received.details.reason, 'Manual review required');

    received = null;
    await listener(newMember, newMember);
    assert.strictEqual(received, null, 'an unchanged role must not dispatch');

    let skippedListener;
    installManualJailRoleWorkflow({ on: (_event, handler) => { skippedListener = handler; }, once() {} }, Discord, {
        jailRoleId: 'jail',
    }, {
        delayMs: 0,
        reconcileOnReady: false,
        shouldSkip: member => member.id === 'member',
        onJailRoleAdded: async () => { throw new Error('should not run'); },
    });
    await skippedListener(oldMember, newMember);
    console.log('manual-jail-role tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
