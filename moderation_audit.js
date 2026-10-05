'use strict';

function recentEntry(entries, userId, now, windowMs) {
    return [...(entries?.values?.() || [])]
        .filter(entry => entry.target?.id === userId && now - entry.createdTimestamp <= windowMs)
        .sort((left, right) => right.createdTimestamp - left.createdTimestamp)[0] || null;
}

async function classifyMemberRemoval(member, Discord, {
    now = Date.now(),
    wait = () => new Promise(resolve => setTimeout(resolve, 1000)),
    auditWindowMs = 15_000,
} = {}) {
    await wait();
    const guild = member.guild;
    const userId = member.user.id;
    const [banLookup, banLogs, kickLogs] = await Promise.all([
        guild.bans?.fetch
            ? guild.bans.fetch(userId).then(() => true).catch(() => false)
            : false,
        guild.fetchAuditLogs({ type: Discord.AuditLogEvent.MemberBanAdd, limit: 6 }).catch(() => null),
        guild.fetchAuditLogs({ type: Discord.AuditLogEvent.MemberKick, limit: 6 }).catch(() => null),
    ]);
    const banEntry = recentEntry(banLogs?.entries, userId, now, auditWindowMs);
    const kickEntry = recentEntry(kickLogs?.entries, userId, now, auditWindowMs);

    if (banEntry || banLookup) {
        return { action: 'banned', entry: banEntry, executor: banEntry?.executor || null, reason: banEntry?.reason || '' };
    }
    if (kickEntry) {
        return { action: 'kicked', entry: kickEntry, executor: kickEntry.executor || null, reason: kickEntry.reason || '' };
    }
    return { action: 'left', entry: null, executor: null, reason: '' };
}

module.exports = { classifyMemberRemoval, recentEntry };
