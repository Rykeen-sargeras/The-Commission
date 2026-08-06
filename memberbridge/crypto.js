'use strict';

const crypto = require('crypto');

function base64url(buffer) {
    return Buffer.from(buffer).toString('base64url');
}

function randomToken(bytes = 32) {
    return base64url(crypto.randomBytes(bytes));
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function pkce() {
    const verifier = randomToken(48);
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
}

function constantTimeEqual(left, right) {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

class SecretBox {
    constructor(base64Key) {
        const key = Buffer.from(String(base64Key || ''), 'base64');
        if (key.length !== 32) throw new Error('MemberBridge encryption key is missing or invalid.');
        this.key = key;
    }

    encrypt(value) {
        if (!value) return '';
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
        const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
        return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
    }

    decrypt(value) {
        if (!value) return '';
        const [version, ivText, tagText, encryptedText] = String(value).split('.');
        if (version !== 'v1' || !ivText || !tagText || !encryptedText) throw new Error('Encrypted secret format is invalid.');
        const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivText, 'base64'));
        decipher.setAuthTag(Buffer.from(tagText, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64')), decipher.final()]).toString('utf8');
    }
}

module.exports = { SecretBox, constantTimeEqual, pkce, randomToken, sha256 };
