'use strict';

const Discord = require('discord.js');

function scrubText(value) {
    if (typeof value !== 'string') return value;
    const lines = value.split('\n').filter(line => {
        if (/\bRTP\b/i.test(line)) return false;
        if (/house edge/i.test(line)) return false;
        if (/Progressive-game and dice maximum wager:/i.test(line)) return false;
        return true;
    });
    return lines.join('\n')
        .replace(/\s*·\s*\d+(?:\.\d+)?%/g, '')
        .replace(/\s*\(\d+(?:\.\d+)?%\)/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

// Clean economy embed fields before Discord receives them.
const originalAddFields = Discord.EmbedBuilder.prototype.addFields;
Discord.EmbedBuilder.prototype.addFields = function cleanEconomyFields(...args) {
    const normalize = input => {
        if (!input || typeof input !== 'object') return input;
        if (String(input.name || '').toLowerCase() === 'outcome chance') return null;
        const copy = { ...input };
        if (typeof copy.value === 'string') copy.value = scrubText(copy.value);
        return copy;
    };

    const cleaned = [];
    for (const arg of args) {
        if (Array.isArray(arg)) {
            const values = arg.map(normalize).filter(Boolean);
            if (values.length) cleaned.push(values);
        } else {
            const value = normalize(arg);
            if (value) cleaned.push(value);
        }
    }
    return originalAddFields.apply(this, cleaned);
};

const originalSetFooter = Discord.EmbedBuilder.prototype.setFooter;
Discord.EmbedBuilder.prototype.setFooter = function cleanEconomyFooter(options) {
    if (!options || typeof options.text !== 'string') return originalSetFooter.call(this, options);
    const text = scrubText(options.text);
    // If the entire footer was only odds/RTP disclosure, omit it.
    if (!text) return this;
    return originalSetFooter.call(this, { ...options, text });
};

// Scrub plain-text interaction replies such as /economy settings.
if (Discord.ChatInputCommandInteraction?.prototype?.reply) {
    const originalReply = Discord.ChatInputCommandInteraction.prototype.reply;
    Discord.ChatInputCommandInteraction.prototype.reply = function cleanEconomyReply(options) {
        if (typeof options === 'string') return originalReply.call(this, scrubText(options));
        if (options && typeof options === 'object' && typeof options.content === 'string') {
            options = { ...options, content: scrubText(options.content) };
        }
        return originalReply.call(this, options);
    };
}

module.exports = { scrubText };
