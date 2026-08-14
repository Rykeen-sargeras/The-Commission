'use strict';

const Discord = require('discord.js');

const DOX_WORDS = new Set(['dox', 'doxxing', 'doxxed']);

function findDoxWord(content) {
    const words = String(content || '').toLowerCase().match(/[a-z]+/g) || [];
    return words.find(word => DOX_WORDS.has(word)) || null;
}

function installDoxWordPolicy() {
    if (Discord.Client.prototype.__commissionDoxWordPolicyInstalled) return;
    Discord.Client.prototype.__commissionDoxWordPolicyInstalled = true;

    const originalEmit = Discord.Client.prototype.emit;
    Discord.Client.prototype.emit = function patchedEmit(eventName, ...args) {
        if (eventName !== 'messageCreate') return originalEmit.call(this, eventName, ...args);

        const message = args[0];
        if (!message?.guild || message.author?.bot) return originalEmit.call(this, eventName, ...args);

        const matchedWord = findDoxWord(message.content);
        if (!matchedWord) return originalEmit.call(this, eventName, ...args);

        Promise.resolve().then(async () => {
            try {
                await message.delete().catch(() => {});
                await message.channel.send({
                    content: `${message.author} knock it off. **${matchedWord}** is filtered here. Your message was removed — you are not being jailed for using the word.`,
                    allowedMentions: { users: [message.author.id] },
                }).catch(() => null);
                console.log(`⚠️ Dox-word message removed without jail: "${matchedWord}" from ${message.author.tag}`);
            } catch (error) {
                console.error('❌ Error applying dox-word delete-only policy:', error);
            }
        });

        // Do not emit messageCreate to the normal banned-word auto-jail handler.
        return false;
    };
}

installDoxWordPolicy();

module.exports = { installDoxWordPolicy, findDoxWord, DOX_WORDS };
