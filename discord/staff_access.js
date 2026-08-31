'use strict';

function createStaffAccess(Discord, config) {
    const channelPermissions = [
        Discord.PermissionFlagsBits.ViewChannel,
        Discord.PermissionFlagsBits.SendMessages,
        Discord.PermissionFlagsBits.ReadMessageHistory,
    ];

    function configuredStaffRoleIds(guild) {
        const configuredIds = [...new Set(config.STAFF_ROLE_IDS.map(id => String(id).trim()).filter(Boolean))];
        const validIds = configuredIds.filter(id => guild.roles.cache.has(id));
        const invalidIds = configuredIds.filter(id => !guild.roles.cache.has(id));

        if (invalidIds.length) {
            console.warn(`[Discord permissions] Ignoring staff role IDs that do not exist in guild ${guild.id}: ${invalidIds.join(', ')}`);
        }

        return validIds;
    }

    function staffPermissionOverwrites(guild) {
        return configuredStaffRoleIds(guild).map(id => ({ id, allow: channelPermissions }));
    }

    function staffMentions(guild, extraUserId = '') {
        const mentions = [];
        if (config.OWNER_USER_ID) mentions.push(`<@${config.OWNER_USER_ID}>`);
        mentions.push(...configuredStaffRoleIds(guild).map(id => `<@&${id}>`));
        if (extraUserId) mentions.push(`<@${extraUserId}>`);
        return mentions.join(' ');
    }

    return { configuredStaffRoleIds, staffPermissionOverwrites, staffMentions };
}

module.exports = { createStaffAccess };
