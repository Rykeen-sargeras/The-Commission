'use strict';

const assert = require('assert');
const { MemberBridgeIntegration } = require('../memberbridge/integration');

class FakeCollection extends Map {
    filter(predicate) {
        return new FakeCollection([...this].filter(([, value]) => predicate(value)));
    }
}

let legacyDeleted = false;
let unrelatedDeleted = false;
const messages = new FakeCollection([
    ['legacy', {
        id: 'legacy',
        author: { id: 'bot-user' },
        embeds: [{ title: 'Verify Your Channel Membership' }],
        components: [],
        delete: async () => { legacyDeleted = true; },
    }],
    ['unrelated', {
        id: 'unrelated',
        author: { id: 'bot-user' },
        embeds: [{ title: 'Server announcement' }],
        components: [],
        delete: async () => { unrelatedDeleted = true; },
    }],
]);
const channel = {
    id: 'verify-channel',
    name: 'verify-membership',
    isTextBased: () => true,
    messages: { fetch: async () => messages },
};
const guild = { channels: { cache: new FakeCollection([['verify-channel', channel]]) } };
const client = {
    user: { id: 'bot-user' },
    isReady: () => true,
    guilds: { cache: new FakeCollection([['guild', guild]]) },
};

(async () => {
    const integration = new MemberBridgeIntegration(client, { config: { verifyChannelId: 'verify-channel' } });
    await integration.start();
    assert.equal(legacyDeleted, true, 'the retired MemberBridge panel should be deleted');
    assert.equal(unrelatedDeleted, false, 'unrelated bot messages must be preserved');
    console.log('Retired MemberBridge panel cleanup test passed.');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
