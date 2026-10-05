'use strict';

const EMBED_FIELD_LIMIT = 1024;
const SAFE_PREVIEW_LIMIT = 900;

function safeEmbedText(value, fallback = 'Not available', limit = EMBED_FIELD_LIMIT) {
    const text = String(value ?? '').trim() || fallback;
    return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function addSensitiveTextEvidence(Discord, embed, {
    fieldName = 'Message Content',
    text,
    fileName = 'deleted-message.txt',
} = {}) {
    const fullText = String(text ?? '');
    const visibleText = fullText || '[No text content]';
    const spoilerUnsafe = visibleText.includes('||');
    const needsAttachment = spoilerUnsafe || visibleText.length > SAFE_PREVIEW_LIMIT;
    const preview = safeEmbedText(visibleText.replaceAll('||', '¦¦'), '[No text content]', SAFE_PREVIEW_LIMIT);
    const suffix = needsAttachment ? '\n*Full original text attached.*' : '';
    embed.addFields({
        name: safeEmbedText(fieldName, 'Message Content', 256),
        value: `||${preview}||${suffix}`.slice(0, EMBED_FIELD_LIMIT),
        inline: false,
    });

    return {
        embed,
        files: needsAttachment
            ? [new Discord.AttachmentBuilder(Buffer.from(fullText, 'utf8'), { name: fileName })]
            : [],
        attached: needsAttachment,
    };
}

module.exports = {
    EMBED_FIELD_LIMIT,
    SAFE_PREVIEW_LIMIT,
    addSensitiveTextEvidence,
    safeEmbedText,
};
