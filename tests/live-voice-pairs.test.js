'use strict';

const assert = require('assert');
const { LiveVoicePairManager, numberedName } = require('../live_voice_pairs');

function overwrite(id, allow, deny, type = 0) {
    return { id, type, allow: { bitfield: BigInt(allow) }, deny: { bitfield: BigInt(deny) } };
}

function channel(id, name, numberOfMembers = 0, permissionOverwrites = []) {
    return {
        id,
        name,
        parentId: '1532513765701189683',
        type: 2,
        bitrate: 64000,
        userLimit: 0,
        members: { size: numberOfMembers },
        permissionOverwrites: { cache: new Map(permissionOverwrites.map(item => [item.id, item])) },
        deleted: false,
        async delete() { this.deleted = true; },
    };
}

function guildWith(initialChannels) {
    const cache = new Map(initialChannels.map(item => [item.id, item]));
    let nextId = 100;
    return {
        id: 'guild-1',
        name: 'Test Guild',
        channels: {
            cache,
            async fetch() { return cache; },
            async create(options) {
                const created = channel(String(nextId++), options.name, 0);
                created.createdOptions = options;
                cache.set(created.id, created);
                return created;
            },
        },
    };
}

(async () => {
    assert.strictEqual(numberedName('LIVE 1', 2, 'live'), 'LIVE 2');
    assert.strictEqual(numberedName('Waiting 1', 3, 'waiting'), 'Waiting 3');
    assert.strictEqual(numberedName('Waiting', 2, 'waiting'), 'Waiting 2');

    const permissions = [overwrite('everyone', 1, 2), overwrite('staff', 4, 8, 1)];
    const live1 = channel('live-1', 'LIVE 1', 1, permissions);
    const waiting1 = channel('waiting-1', 'Waiting', 0, permissions);
    const guild = guildWith([live1, waiting1]);
    const manager = new LiveVoicePairManager({}, {
        categoryId: '1532513765701189683',
        cleanupDelayMs: 10,
    });

    await manager.reconcile(guild);
    const live2 = Array.from(guild.channels.cache.values()).find(item => item.name === 'LIVE 2');
    const waiting2 = Array.from(guild.channels.cache.values()).find(item => item.name === 'Waiting 2');
    assert(live2 && waiting2, 'joining pair 1 should create pair 2');
    assert.deepStrictEqual(live2.createdOptions.permissionOverwrites, [
        { id: 'everyone', type: 0, allow: 1n, deny: 2n },
        { id: 'staff', type: 1, allow: 4n, deny: 8n },
    ]);

    // Waiting channels never count as open LIVE channels. Live 2 is open, so
    // another reconciliation must not create Live 3 yet.
    waiting2.members.size = 1;
    await manager.reconcile(guild);
    assert(!Array.from(guild.channels.cache.values()).some(item => item.name === 'LIVE 3'));

    // Once Live 2 is occupied too, there is no open LIVE channel and pair 3
    // must be created.
    live2.members.size = 1;
    await manager.reconcile(guild);
    assert(Array.from(guild.channels.cache.values()).some(item => item.name === 'LIVE 3'));

    live1.members.size = 0;
    live2.members.size = 0;
    waiting2.members.size = 0;
    manager.scheduleCleanup(guild, 2);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.strictEqual(live2.deleted, true, 'idle LIVE 2 should be removed');
    assert.strictEqual(waiting2.deleted, true, 'idle Waiting 2 should be removed');
    assert.strictEqual(live1.deleted, false, 'LIVE 1 must remain');
    assert.strictEqual(waiting1.deleted, false, 'Waiting 1 must remain');

    console.log('live voice pair tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

