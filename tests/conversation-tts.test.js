'use strict';

const assert = require('assert');
const {
    ConversationTts,
    cleanForSpeech,
    messageToSpeech,
    parseDiscordMessageLink,
} = require('../conversation_tts');

assert.deepStrictEqual(
    parseDiscordMessageLink('https://discord.com/channels/123/456/789'),
    { guildId: '123', channelId: '456', messageId: '789' },
);
assert.deepStrictEqual(
    parseDiscordMessageLink('https://canary.discord.com/channels/123/456/789/'),
    { guildId: '123', channelId: '456', messageId: '789' },
);
assert.throws(() => parseDiscordMessageLink('https://example.com/channels/123/456/789'), /discord.com/);
assert.throws(() => parseDiscordMessageLink('not a link'), /valid Discord message link/);

assert.strictEqual(
    cleanForSpeech('Read https://www.example.com/a/very/long/path?secret=nope now'),
    'Read link to example.com now',
);
assert.strictEqual(cleanForSpeech('**Hello** <:wave:1234> ||friend||'), 'Hello wave friend');
assert.strictEqual(cleanForSpeech('```const secret = 123``` after'), 'code block after');

const spoken = messageToSpeech({
    id: '789',
    system: false,
    content: 'fallback',
    cleanContent: 'Hello https://discord.com/channels/1/2/3',
    attachments: new Map([['a', { name: 'map.png' }]]),
    member: { displayName: 'Road Captain' },
    author: { id: '42', username: 'captain' },
}, 2);
assert.deepStrictEqual(spoken, {
    id: '789',
    speakerId: '42',
    speaker: 'Road Captain',
    text: 'Hello link to discord.com. shared an attachment named map.png',
    voiceSlot: 2,
});
assert.strictEqual(messageToSpeech({ id: '1', system: true }, 0), null);
assert.strictEqual(messageToSpeech({
    id: '2',
    system: false,
    content: '',
    cleanContent: '',
    attachments: new Map(),
    author: { id: '42', username: 'captain' },
}, 0), null);

void (async () => {
    let request;
    const synthesizer = {
        isConfigured: () => true,
        synthesize: async options => {
            request = options;
            return Buffer.from([1, 2, 3]);
        },
    };
    const controller = new ConversationTts({ isReady: () => true }, {
        voices: 'emily,paul,sophie',
        synthesizer,
    });
    const audio = await controller.synthesize('Speaker: hello', 1, 1.2);
    assert.deepStrictEqual([...audio], [1, 2, 3]);
    assert.deepStrictEqual(request, {
        text: 'Speaker: hello',
        voice: 'paul',
        speed: 1.2,
        signal: undefined,
    });

    const unconfiguredSynthesizer = { isConfigured: () => false, destroy() {} };
    const defaultLimit = new ConversationTts({ isReady: () => true }, {
        maxMessages: '',
        synthesizer: unconfiguredSynthesizer,
    });
    assert.strictEqual(defaultLimit.maxMessages, 500);
    const boundedLimit = new ConversationTts({ isReady: () => true }, {
        maxMessages: '9999',
        synthesizer: unconfiguredSynthesizer,
    });
    assert.strictEqual(boundedLimit.maxMessages, 2000);
    const restricted = new ConversationTts({ isReady: () => true }, {
        allowedGuildIds: '111',
        synthesizer: unconfiguredSynthesizer,
    });
    await assert.rejects(
        () => restricted.resolve('https://discord.com/channels/222/333/444'),
        /not in a server enabled/,
    );
    const unconfigured = new ConversationTts({ isReady: () => true }, {
        synthesizer: unconfiguredSynthesizer,
    });
    await assert.rejects(
        () => unconfigured.resolve('https://discord.com/channels/222/333/444'),
        /TTS_ALLOWED_GUILD_IDS must be configured/,
    );
    console.log('conversation TTS tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
