'use strict';

const assert = require('assert');
const {
    CONNECT,
    LiveVoicePairManager,
    MOVE_MEMBERS,
    VIEW_CHANNEL,
    describeManagedChannel,
    numberedName,
} = require('../live_voice_pairs');

const APPRENTICE_ROLE_ID = '1538688329451573300';
const CATEGORY_ID = '1532513765701189683';

function overwrite(id, allow, deny, type = 0) {
    return { id, type, allow: { bitfield: BigInt(allow) }, deny: { bitfield: BigInt(deny) } };
}

function channel(id, name, numberOfMembers = 0, permissionOverwrites = []) {
    const overwriteCache = new Map(permissionOverwrites.map(item => [item.id, item]));
    const value = {
        id,
        name,
        parentId: CATEGORY_ID,
        type: 2,
        bitrate: 64000,
        userLimit: 0,
        members: { size: numberOfMembers },
        permissionOverwrites: {
            cache: overwriteCache,
            async edit(roleId, permissions) {
                let allow = 0n;
                let deny = 0n;
                const flags = { ViewChannel: VIEW_CHANNEL, Connect: CONNECT, MoveMembers: MOVE_MEMBERS };
                for (const [key, bit] of Object.entries(flags)) {
                    if (permissions[key] === true) allow |= bit;
                    if (permissions[key] === false) deny |= bit;
                }
                overwriteCache.set(roleId, overwrite(roleId, allow, deny));
            },
        },
        deleted: false,
        async delete() { this.deleted = true; },
        async setName(nextName) { this.name = nextName; },
    };
    return value;
}

function guildWith(initialChannels) {
    const cache = new Map(initialChannels.map(item => [item.id, item]));
    let nextId = 100;
    const guild = {
        id: 'guild-1',
        name: 'Test Guild',
        channels: {
            cache,
            async fetch() { return cache; },
            async create(options) {
                const created = channel(String(nextId++), options.name, 0, options.permissionOverwrites);
                created.createdOptions = options;
                created.guild = guild;
                cache.set(created.id, created);
                return created;
            },
        },
    };
    for (const item of cache.values()) item.guild = guild;
    return guild;
}

function findChannel(guild, name) {
    return Array.from(guild.channels.cache.values()).find(item => item.name === name);
}

function roleOverwrite(item) {
    return item.permissionOverwrites.cache.get(APPRENTICE_ROLE_ID);
}

function allowBits(item) {
    const value = roleOverwrite(item)?.allow;
    return BigInt(value?.bitfield ?? value ?? 0n);
}

function denyBits(item) {
    const value = roleOverwrite(item)?.deny;
    return BigInt(value?.bitfield ?? value ?? 0n);
}

(async () => {
    assert.strictEqual(numberedName('LIVE 1', 2, 'room', 'live'), 'LIVE 2');
    assert.strictEqual(numberedName('Waiting 1', 3, 'waiting', 'live'), 'Waiting 3');
    assert.strictEqual(numberedName('Waiting', 2, 'waiting', 'live'), 'Waiting 2');
    assert.strictEqual(numberedName('Apprentice 1', 2, 'room', 'apprentice'), 'Apprentice 2');
    assert.strictEqual(numberedName('Apprentice Waiting 1', 2, 'waiting', 'apprentice'), 'Apprentice Waiting 2');
    assert.strictEqual(numberedName('💛 Apprentice 1 💛', 2, 'room', 'apprentice'), '💛 Apprentice 2 💛');
    assert.strictEqual(numberedName('⬆️ Apprentice Waiting ⬆️', 2, 'waiting', 'apprentice'), '⬆️ Apprentice Waiting 2 ⬆️');
    assert.deepStrictEqual(describeManagedChannel(channel('aw', '⬆️ Apprentice Waiting ⬆️'), CATEGORY_ID), {
        family: 'apprentice', kind: 'waiting', number: 1,
    });
    assert.deepStrictEqual(describeManagedChannel(channel('a', 'Apprentice Waiting 3'), CATEGORY_ID), {
        family: 'apprentice', kind: 'waiting', number: 3,
    });

    // A startup reconciliation creates and permanently maintains both pair 1s.
    const guild = guildWith([]);
    const manager = new LiveVoicePairManager({}, {
        categoryId: CATEGORY_ID,
        apprenticeRoleId: APPRENTICE_ROLE_ID,
        cleanupDelayMs: 10,
    });
    assert.strictEqual(new LiveVoicePairManager({}, { categoryId: CATEGORY_ID }).cleanupDelayMs, 10_000);
    await manager.reconcile(guild);

    const live1 = findChannel(guild, '🔴 LIVE 1 🔴');
    const waiting1 = findChannel(guild, '⬆️ Waiting ⬆️');
    const apprentice1 = findChannel(guild, '💛 Apprentice 1 💛');
    const apprenticeWaiting1 = findChannel(guild, '⬆️ Apprentice Waiting ⬆️');
    assert(live1 && waiting1 && apprentice1 && apprenticeWaiting1);

    assert.strictEqual(allowBits(live1), VIEW_CHANNEL);
    assert.strictEqual(denyBits(live1), CONNECT | MOVE_MEMBERS);
    assert.strictEqual(allowBits(waiting1), VIEW_CHANNEL | CONNECT);
    assert.strictEqual(denyBits(waiting1), MOVE_MEMBERS);
    assert.strictEqual(allowBits(apprentice1), VIEW_CHANNEL | CONNECT | MOVE_MEMBERS);
    assert.strictEqual(denyBits(apprentice1), 0n);
    assert.strictEqual(allowBits(apprenticeWaiting1), VIEW_CHANNEL | CONNECT | MOVE_MEMBERS);

    // Existing mojibake names from an earlier bad upload are repaired in place.
    apprentice1.name = 'ðŸ’› Apprentice 1 ðŸ’›';
    apprenticeWaiting1.name = 'â¬†ï¸ Apprentice Waiting â¬†ï¸';
    await manager.reconcile(guild);
    assert.strictEqual(apprentice1.name, '💛 Apprentice 1 💛');
    assert.strictEqual(apprenticeWaiting1.name, '⬆️ Apprentice Waiting ⬆️');

    // Occupying the only open LIVE room creates the next LIVE pair.
    live1.members.size = 1;
    await manager.reconcile(guild, 'live');
    const live2 = findChannel(guild, '🔴 LIVE 2 🔴');
    const waiting2 = findChannel(guild, '⬆️ Waiting 2 ⬆️');
    assert(live2 && waiting2);

    // Occupying the only open Apprentice room creates its own next pair.
    apprentice1.members.size = 1;
    await manager.reconcile(guild, 'apprentice');
    const apprentice2 = findChannel(guild, '💛 Apprentice 2 💛');
    const apprenticeWaiting2 = findChannel(guild, '⬆️ Apprentice Waiting 2 ⬆️');
    assert(apprentice2 && apprenticeWaiting2);

    // A waiting-room occupant does not consume an open room slot.
    apprenticeWaiting2.members.size = 1;
    await manager.reconcile(guild, 'apprentice');
    assert(!findChannel(guild, '💛 Apprentice 3 💛'));

    // Dynamic pairs are removed after both sides are empty; pair 1 is protected.
    live1.members.size = 0;
    live2.members.size = 0;
    waiting2.members.size = 0;
    manager.scheduleCleanup(guild, 'live', 2);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.strictEqual(live2.deleted, true);
    assert.strictEqual(waiting2.deleted, true);
    assert.strictEqual(live1.deleted, false);
    assert.strictEqual(waiting1.deleted, false);

    console.log('live voice pair tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
