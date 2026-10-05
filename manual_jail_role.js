'use strict';

function wasJailRoleAdded(oldMember, newMember, jailRoleId) {
    return Boolean(
        jailRoleId
        && !oldMember.roles.cache.has(jailRoleId)
        && newMember.roles.cache.has(jailRoleId),
    );
}

function findExistingJailChannel(channels, memberId, categoryId) {
    return [...channels.values()].find(channel => (
        channel.parentId === categoryId
        && channel.name?.startsWith('jail-')
        && (
            channel.permissionOverwrites?.cache?.has(memberId)
            || channel.topic?.includes(`commission-jail-user:${memberId}`)
        )
    )) || null;
}

async function resolveStaffRoles(guild, staffRoleIds) {
    let roles = guild.roles.cache;
    try {
        roles = await guild.roles.fetch();
    } catch (error) {
        console.warn('[Jail workflow] Could not refresh guild roles; using the current role cache:', error.message);
    }

    const configuredIds = [...new Set((staffRoleIds || []).map(id => String(id).trim()).filter(Boolean))];
    const validRoles = configuredIds.map(id => roles?.get(id)).filter(Boolean);
    const invalidRoleIds = configuredIds.filter(id => !roles?.has(id));
    const moderatorsRole = [...(roles?.values?.() || [])].find(role => (
        String(role?.name || '').trim().toLowerCase() === 'moderators'
    ));
    if (moderatorsRole && !validRoles.some(role => role.id === moderatorsRole.id)) {
        validRoles.push(moderatorsRole);
    }

    if (invalidRoleIds.length) {
        console.warn(`[Jail workflow] Ignoring staff role IDs that do not exist in guild ${guild.id}: ${invalidRoleIds.join(', ')}`);
    }
    return validRoles;
}

function installManualJailRoleWorkflow(client, Discord, config, options = {}) {
    const jailRoleId = config.jailRoleId || '';
    const delayMs = options.delayMs ?? 1500;
    const reconcileOnReady = options.reconcileOnReady !== false;
    const onJailRoleAdded = options.onJailRoleAdded;
    const shouldSkip = typeof options.shouldSkip === 'function' ? options.shouldSkip : () => false;
    const provisioning = new Map();

    if (!jailRoleId) {
        console.warn('[Manual jail] Disabled because JAIL_ROLE_ID is not configured.');
        return;
    }
    if (typeof onJailRoleAdded !== 'function') {
        throw new TypeError('installManualJailRoleWorkflow requires options.onJailRoleAdded.');
    }

    async function findRoleAuditEntry(guild, memberId) {
        try {
            const logs = await guild.fetchAuditLogs({
                type: Discord.AuditLogEvent.MemberRoleUpdate,
                limit: 6,
            });
            return [...(logs.entries?.values?.() || [])].find(item => (
                item.target?.id === memberId
                && Date.now() - item.createdTimestamp < 15000
            )) || null;
        } catch (_error) {
            return null;
        }
    }

    async function dispatch(member, workflowOptions = {}) {
        if (!workflowOptions.skipDelay && delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
        const auditEntry = await findRoleAuditEntry(member.guild, member.id);
        const actor = auditEntry?.executor || null;
        const reason = String(auditEntry?.reason || '').trim()
            || (actor
                ? `Jail role manually assigned by ${actor.tag || actor.username || actor.id}; no additional reason was recorded.`
                : 'Jail role assigned manually or by an automation; no additional reason was recorded.');
        return onJailRoleAdded(member, {
            actor,
            reason,
            source: workflowOptions.source || 'manual-role',
            auditEntry,
        });
    }

    function queue(member, workflowOptions = {}) {
        const key = `${member.guild.id}:${member.id}`;
        if (provisioning.has(key)) return provisioning.get(key);
        const task = dispatch(member, workflowOptions)
            .catch(error => console.error('[Manual jail] Workflow failed:', error))
            .finally(() => provisioning.delete(key));
        provisioning.set(key, task);
        return task;
    }

    client.on('guildMemberUpdate', async (oldMember, newMember) => {
        if (!wasJailRoleAdded(oldMember, newMember, jailRoleId)) return;
        if (shouldSkip(newMember)) return;
        return queue(newMember);
    });

    if (reconcileOnReady) {
        client.once(Discord.Events.ClientReady, async () => {
            for (const guild of client.guilds.cache.values()) {
                try {
                    const members = await guild.members.fetch();
                    for (const member of members.values()) {
                        if (!member.roles.cache.has(jailRoleId)) continue;
                        await queue(member, { skipDelay: true, source: 'startup-repair' });
                    }
                } catch (error) {
                    console.error(`[Manual jail] Could not reconcile guild ${guild.id}:`, error);
                }
            }
        });
    }
}

module.exports = {
    findExistingJailChannel,
    installManualJailRoleWorkflow,
    resolveStaffRoles,
    wasJailRoleAdded,
};
