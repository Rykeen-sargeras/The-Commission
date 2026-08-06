const SUPPORTED_CHANNEL_TYPES = new Set([0, 2, 4, 5, 13, 15, 16]);

function valuesOf(collection) {
    return Array.from(collection?.values?.() || []);
}

function serializeOverwrites(channel) {
    return valuesOf(channel.permissionOverwrites?.cache).map(overwrite => ({
        sourceId: overwrite.id,
        type: overwrite.type,
        allow: overwrite.allow.bitfield.toString(),
        deny: overwrite.deny.bitfield.toString(),
    }));
}

async function captureGuildBlueprint(guild) {
    const rolesCollection = await guild.roles.fetch();
    const channelsCollection = await guild.channels.fetch();
    const roles = valuesOf(rolesCollection)
        .filter(role => role.id !== guild.id && !role.managed)
        .sort((a, b) => a.position - b.position)
        .map(role => ({
            sourceId: role.id,
            name: role.name,
            color: role.color,
            hoist: role.hoist,
            mentionable: role.mentionable,
            permissions: role.permissions.bitfield.toString(),
            position: role.position,
        }));

    const channels = valuesOf(channelsCollection)
        .filter(channel => SUPPORTED_CHANNEL_TYPES.has(channel.type) && !channel.isThread?.())
        .sort((a, b) => a.rawPosition - b.rawPosition)
        .map(channel => ({
            sourceId: channel.id,
            name: channel.name,
            type: channel.type,
            position: channel.rawPosition,
            parentSourceId: channel.parentId || null,
            topic: channel.topic ?? null,
            nsfw: Boolean(channel.nsfw),
            rateLimitPerUser: channel.rateLimitPerUser ?? 0,
            bitrate: channel.bitrate ?? null,
            userLimit: channel.userLimit ?? null,
            rtcRegion: channel.rtcRegion ?? null,
            videoQualityMode: channel.videoQualityMode ?? null,
            defaultAutoArchiveDuration: channel.defaultAutoArchiveDuration ?? null,
            permissionOverwrites: serializeOverwrites(channel),
        }));

    const skippedChannels = valuesOf(channelsCollection).filter(
        channel => !SUPPORTED_CHANNEL_TYPES.has(channel.type) || channel.isThread?.(),
    ).length;

    return {
        format: 'the-commission-blueprint',
        version: 1,
        capturedAt: new Date().toISOString(),
        sourceGuild: {
            id: guild.id,
            name: guild.name,
            iconUrl: guild.iconURL?.({ extension: 'png', size: 256 }) || null,
        },
        everyonePermissions: guild.roles.everyone.permissions.bitfield.toString(),
        roles,
        channels,
        skippedChannels,
    };
}

function mapOverwrites(overwrites, blueprint, targetGuild, roleMap) {
    const mapped = [];
    let skippedMemberOverwrites = 0;

    for (const overwrite of overwrites || []) {
        let targetId;
        if (overwrite.sourceId === blueprint.sourceGuild.id) {
            targetId = targetGuild.id;
        } else if (overwrite.type === 0 && roleMap.has(overwrite.sourceId)) {
            targetId = roleMap.get(overwrite.sourceId);
        } else {
            skippedMemberOverwrites += 1;
            continue;
        }
        mapped.push({
            id: targetId,
            type: overwrite.type,
            allow: BigInt(overwrite.allow),
            deny: BigInt(overwrite.deny),
        });
    }
    return { mapped, skippedMemberOverwrites };
}

async function applyGuildBlueprint(guild, blueprint, options = {}, progress = () => {}) {
    if (!blueprint || blueprint.format !== 'the-commission-blueprint') {
        throw new Error('This is not a valid The Commission blueprint.');
    }
    if (guild.id === blueprint.sourceGuild.id) {
        throw new Error('The source and destination servers must be different.');
    }

    const result = {
        rolesCreated: 0,
        categoriesCreated: 0,
        channelsCreated: 0,
        skippedMemberOverwrites: 0,
        errors: [],
    };
    const roleMap = new Map();
    const channelMap = new Map();
    roleMap.set(blueprint.sourceGuild.id, guild.id);

    if (options.applyEveryonePermissions) {
        progress('Applying @everyone base permissions');
        try {
            await guild.roles.everyone.setPermissions(
                BigInt(blueprint.everyonePermissions),
                'The Commission blueprint',
            );
        } catch (error) {
            result.errors.push(`@everyone permissions: ${error.message}`);
        }
    }

    for (const role of blueprint.roles) {
        progress(`Creating role: ${role.name}`);
        try {
            const created = await guild.roles.create({
                name: role.name,
                color: role.color,
                hoist: role.hoist,
                mentionable: role.mentionable,
                permissions: BigInt(role.permissions),
                reason: `The Commission blueprint from ${blueprint.sourceGuild.name}`,
            });
            roleMap.set(role.sourceId, created.id);
            result.rolesCreated += 1;
            if (created.setPosition) {
                await created.setPosition(role.position).catch(() => {});
            }
        } catch (error) {
            result.errors.push(`Role "${role.name}": ${error.message}`);
        }
    }

    const createChannel = async channel => {
        const { mapped, skippedMemberOverwrites } = mapOverwrites(
            channel.permissionOverwrites,
            blueprint,
            guild,
            roleMap,
        );
        result.skippedMemberOverwrites += skippedMemberOverwrites;
        const parent = channel.parentSourceId ? channelMap.get(channel.parentSourceId) : undefined;
        const createOptions = {
            name: channel.name,
            type: channel.type,
            parent,
            position: channel.position,
            permissionOverwrites: mapped,
            reason: `The Commission blueprint from ${blueprint.sourceGuild.name}`,
        };

        if ([0, 5, 15, 16].includes(channel.type)) {
            createOptions.topic = channel.topic;
            createOptions.nsfw = channel.nsfw;
            createOptions.rateLimitPerUser = channel.rateLimitPerUser;
            if (channel.defaultAutoArchiveDuration) {
                createOptions.defaultAutoArchiveDuration = channel.defaultAutoArchiveDuration;
            }
        }
        if ([2, 13].includes(channel.type)) {
            if (channel.bitrate) createOptions.bitrate = Math.min(channel.bitrate, guild.maximumBitrate || channel.bitrate);
            createOptions.userLimit = channel.userLimit || 0;
            createOptions.rtcRegion = channel.rtcRegion;
            if (channel.videoQualityMode) createOptions.videoQualityMode = channel.videoQualityMode;
        }

        const created = await guild.channels.create(createOptions);
        channelMap.set(channel.sourceId, created.id);
        if (channel.type === 4) result.categoriesCreated += 1;
        else result.channelsCreated += 1;
    };

    for (const category of blueprint.channels.filter(channel => channel.type === 4)) {
        progress(`Creating category: ${category.name}`);
        try {
            await createChannel(category);
        } catch (error) {
            result.errors.push(`Category "${category.name}": ${error.message}`);
        }
    }

    for (const channel of blueprint.channels.filter(channel => channel.type !== 4)) {
        progress(`Creating channel: ${channel.name}`);
        try {
            await createChannel(channel);
        } catch (error) {
            result.errors.push(`Channel "${channel.name}": ${error.message}`);
        }
    }

    return result;
}

module.exports = {
    SUPPORTED_CHANNEL_TYPES,
    applyGuildBlueprint,
    captureGuildBlueprint,
    mapOverwrites,
};
