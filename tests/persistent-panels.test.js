'use strict';

const assert = require('node:assert/strict');
const { createPanelUpserter } = require('../economy/persistent_panels');

async function run() {
    let clock = 1000;
    let edits = 0;
    let sends = 0;
    let fetches = 0;
    let storedId = '';
    let currentMessage = null;
    const channel = {
        isTextBased: () => true,
        messages: {
            cache: new Map(),
            fetch: async () => { fetches += 1; return currentMessage; },
        },
        send: async () => {
            sends += 1;
            currentMessage = { id: `message-${sends}`, edit: async () => { edits += 1; return currentMessage; } };
            return currentMessage;
        },
    };
    const guild = { id: 'guild', channels: { cache: new Map([['channel', channel]]), fetch: async () => null } };
    const economy = { setting: () => storedId, setSetting: (_guildId, _key, value) => { storedId = value; } };
    const upsert = createPanelUpserter(economy, { now: () => clock, verifyIntervalMs: 60000 });

    await upsert(guild, 'channel', 'panel', { embeds: [{ title: 'Board', timestamp: 'first' }] });
    assert.equal(sends, 1);
    await upsert(guild, 'channel', 'panel', { embeds: [{ title: 'Board', timestamp: 'second' }] });
    assert.equal(edits, 0, 'a timestamp-only change must not edit the Discord message');
    await upsert(guild, 'channel', 'panel', { embeds: [{ title: 'Updated' }] });
    assert.equal(edits, 1);

    clock += 60000;
    const priorFetches = fetches;
    await upsert(guild, 'channel', 'panel', { embeds: [{ title: 'Updated' }] });
    assert.equal(fetches, priorFetches + 1, 'the periodic check must force a Discord fetch');
    assert.equal(edits, 1);

    currentMessage = null;
    clock += 60000;
    await upsert(guild, 'channel', 'panel', { embeds: [{ title: 'Updated' }] });
    assert.equal(sends, 2, 'a deleted panel must be restored');
    await upsert(guild, 'channel', 'panel', { embeds: [{ title: 'Updated' }] }, true);
    assert.equal(edits, 2, 'an explicit push must edit even unchanged content');
}

run().then(() => console.log('persistent panel tests passed')).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
