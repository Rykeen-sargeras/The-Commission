'use strict';

const assert = require('node:assert/strict');
const { classifyMemberRemoval } = require('../moderation_audit');
const { addSensitiveTextEvidence, safeEmbedText } = require('../moderation_evidence');

class EmbedBuilder {
    constructor() { this.fields = []; }
    addFields(...fields) { this.fields.push(...fields); return this; }
}
class AttachmentBuilder {
    constructor(data, options) { this.data = data; this.name = options.name; }
}

const Discord = {
    AttachmentBuilder,
    AuditLogEvent: { MemberBanAdd: 22, MemberKick: 20 },
};

async function classify({ banned = false, banEntry = null, kickEntry = null } = {}) {
    const guild = {
        bans: { fetch: async () => { if (!banned) throw new Error('not banned'); return {}; } },
        fetchAuditLogs: async ({ type }) => ({
            entries: new Map((type === Discord.AuditLogEvent.MemberBanAdd ? banEntry : kickEntry)
                ? [['entry', type === Discord.AuditLogEvent.MemberBanAdd ? banEntry : kickEntry]] : []),
        }),
    };
    return classifyMemberRemoval({ guild, user: { id: 'member' } }, Discord, {
        now: 10_000,
        wait: async () => {},
        auditWindowMs: 5_000,
    });
}

(async () => {
    assert.equal(safeEmbedText('x'.repeat(2000)).length, 1024);
    const short = addSensitiveTextEvidence(Discord, new EmbedBuilder(), { text: 'complete short message' });
    assert.equal(short.attached, false);
    assert.match(short.embed.fields[0].value, /complete short message/);

    const longText = `start-${'x'.repeat(1500)}-end`;
    const long = addSensitiveTextEvidence(Discord, new EmbedBuilder(), { text: longText, fileName: 'evidence.txt' });
    assert.equal(long.attached, true);
    assert.equal(long.files[0].data.toString('utf8'), longText);
    assert.equal(long.files[0].name, 'evidence.txt');
    assert(long.embed.fields[0].value.length <= 1024);

    const banEntry = { target: { id: 'member' }, executor: { id: 'mod' }, reason: 'ban reason', createdTimestamp: 9_000 };
    assert.equal((await classify({ banned: true, banEntry })).action, 'banned');
    const kickEntry = { target: { id: 'member' }, executor: { id: 'mod' }, reason: 'kick reason', createdTimestamp: 9_500 };
    const kicked = await classify({ kickEntry });
    assert.equal(kicked.action, 'kicked');
    assert.equal(kicked.reason, 'kick reason');
    assert.equal((await classify({ banned: true, kickEntry })).action, 'banned', 'an active ban must not be mislabeled as a kick');
    assert.equal((await classify()).action, 'left');
    console.log('moderation workflow tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
