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
        && channel.permissionOverwrites?.cache?.has(memberId)
    )) || null;
}

function safeChannelPart(value) {
    return String(value || 'member').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 15);
}

function installManualJailRoleWorkflow(client, Discord, config, options = {}) {
    const jailRoleId = config.jailRoleId || '';
    const jailCategoryId = config.jailCategoryId || '';
    const modChannelId = config.modChannelId || '';
    const staffRoleIds = config.staffRoleIds || [];
    const delayMs = options.delayMs ?? 1500;
    const reconcileOnReady = options.reconcileOnReady !== false;
    const provisioning = new Map();

    if (!jailRoleId) {
        console.warn('[Manual jail] Disabled because JAIL_ROLE_ID is not configured.');
        return;
    }

    async function findModerator(guild, memberId) {
        try {
            const logs = await guild.fetchAuditLogs({
                type: Discord.AuditLogEvent.MemberRoleUpdate,
                limit: 6,
            });
            const entry = logs.entries.find(item => (
                item.target?.id === memberId
                && Date.now() - item.createdTimestamp < 15000
            ));
            return entry?.executor || null;
        } catch (_error) {
            return null;
        }
    }

    async function completeJailWorkflow(member, workflowOptions = {}) {
        if (!workflowOptions.skipDelay && delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));

        const guild = member.guild;
        const channels = await guild.channels.fetch();
        let jailChannel = findExistingJailChannel(channels, member.id, jailCategoryId);
        let created = false;
        let failure = '';

        if (workflowOptions.skipExisting && jailChannel) return;

        if (!jailChannel) {
            const category = jailCategoryId ? channels.get(jailCategoryId) : null;
            if (!category || category.type !== Discord.ChannelType.GuildCategory) {
                failure = 'The configured jail category is missing or invalid.';
            } else {
                try {
                    jailChannel = await guild.channels.create({
                        name: `jail-${safeChannelPart(member.user.username)}-${Math.floor(Math.random() * 9999)}`,
                        type: Discord.ChannelType.GuildText,
                        parent: jailCategoryId,
                        permissionOverwrites: [
                            { id: guild.roles.everyone.id, deny: [Discord.PermissionFlagsBits.ViewChannel] },
                            {
                                id: member.id,
                                allow: [
                                    Discord.PermissionFlagsBits.ViewChannel,
                                    Discord.PermissionFlagsBits.SendMessages,
                                    Discord.PermissionFlagsBits.ReadMessageHistory,
                                ],
                            },
                            ...staffRoleIds.map(id => ({
                                id,
                                allow: [
                                    Discord.PermissionFlagsBits.ViewChannel,
                                    Discord.PermissionFlagsBits.SendMessages,
                                    Discord.PermissionFlagsBits.ReadMessageHistory,
                                    Discord.PermissionFlagsBits.ManageMessages,
                                ],
                            })),
                        ],
                        reason: `Jail role assigned to ${member.user.tag}`,
                    });
                    created = true;
                    const staffMentions = staffRoleIds.map(id => `<@&${id}>`).join(' ');
                    const embed = new Discord.EmbedBuilder()
                        .setColor('#FF0000')
                        .setTitle('ðŸ”’ You Have Been Jailed')
                        .setDescription('The Jail role was assigned. Staff will review this case here.')
                        .addFields(
                            { name: 'User', value: `${member.user.tag} (${member.id})` },
                            { name: 'Status', value: 'Waiting for staff review' },
                        )
                        .setTimestamp();
                    await jailChannel.send({ content: `${staffMentions} <@${member.id}>`.trim(), embeds: [embed] });
                } catch (error) {
                    failure = `Could not create the jail channel: ${error.message}`;
                }
            }
        }

        const moderator = await findModerator(guild, member.id);
        if (modChannelId) {
            try {
                const modChannel = await guild.channels.fetch(modChannelId);
                if (modChannel?.isTextBased()) {
                    const embed = new Discord.EmbedBuilder()
                        .setColor(failure ? '#FF9900' : '#FF0000')
                        .setTitle('ðŸ”’ Jail Role Assigned')
                        .setThumbnail(member.user.displayAvatarURL())
                        .addFields(
                            { name: 'Member', value: `<@${member.id}> (${member.user.tag})` },
                            { name: 'Assigned By', value: moderator ? `<@${moderator.id}> (${moderator.tag})` : 'Unknown or automated' },
                            { name: 'Jail Channel', value: jailChannel ? `<#${jailChannel.id}>` : failure || 'Not created' },
                            { name: 'Workflow', value: created ? 'Created automatically from role assignment' : 'Existing jail channel detected' },
                        )
                        .setTimestamp();
                    await modChannel.send({ embeds: [embed] });
                }
            } catch (error) {
                console.error('[Manual jail] Could not notify the mod channel:', error);
            }
        }

        if (failure) console.error(`[Manual jail] ${member.user.tag}: ${failure}`);
        else console.log(`[Manual jail] Completed workflow for ${member.user.tag} in #${jailChannel.name}`);
    }

    client.on('guildMemberUpdate', async (oldMember, newMember) => {
        if (!wasJailRoleAdded(oldMember, newMember, jailRoleId)) return;
        if (provisioning.has(newMember.id)) return provisioning.get(newMember.id);

        const task = completeJailWorkflow(newMember)
            .catch(error => console.error('[Manual jail] Workflow failed:', error))
            .finally(() => provisioning.delete(newMember.id));
        provisioning.set(newMember.id, task);
        return task;
    });

    if (reconcileOnReady) {
        client.once(Discord.Events.ClientReady, async () => {
            for (const guild of client.guilds.cache.values()) {
                try {
                    const members = await guild.members.fetch();
                    for (const member of members.values()) {
                        if (!member.roles.cache.has(jailRoleId) || provisioning.has(member.id)) continue;
                        const task = completeJailWorkflow(member, { skipDelay: true, skipExisting: true })
                            .catch(error => console.error('[Manual jail] Startup repair failed:', error))
                            .finally(() => provisioning.delete(member.id));
                        provisioning.set(member.id, task);
                        await task;
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
    wasJailRoleAdded,
};

