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
    const controller = new ConversationTts({ isReady: () => true }, {
        apiKey: 'test-key',
        model: 'gpt-4o-mini-tts',
        voices: 'marin,cedar,coral',
        fetchImpl: async (url, options) => {
            request = { url, options };
            return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
        },
    });
    const audio = await controller.synthesize('Speaker: hello', 1, 1.2);
    assert.deepStrictEqual([...audio], [1, 2, 3]);
    assert.strictEqual(request.url, 'https://api.openai.com/v1/audio/speech');
    assert.strictEqual(request.options.headers.Authorization, 'Bearer test-key');
    assert.deepStrictEqual(JSON.parse(request.options.body), {
        model: 'gpt-4o-mini-tts',
        voice: 'cedar',
        input: 'Speaker: hello',
        response_format: 'opus',
        speed: 1.2,
        instructions: 'Speak clearly at a comfortable conversational pace for hands-free listening.',
    });

    const restricted = new ConversationTts({ isReady: () => true }, { allowedGuildIds: '111' });
    await assert.rejects(
        () => restricted.resolve('https://discord.com/channels/222/333/444'),
        /not in a server enabled/,
    );
    const unconfigured = new ConversationTts({ isReady: () => true });
    await assert.rejects(
        () => unconfigured.resolve('https://discord.com/channels/222/333/444'),
        /TTS_ALLOWED_GUILD_IDS must be configured/,
    );
    console.log('conversation TTS tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
