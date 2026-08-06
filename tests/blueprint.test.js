const assert = require('assert');
const { applyGuildBlueprint, captureGuildBlueprint } = require('../blueprint');

function permissions(value) {
    return { bitfield: BigInt(value) };
}

async function run() {
    const everyone = { id: '100000000000000000', permissions: permissions(1024) };
    const sourceRole = {
        id: '200000000000000000',
        name: 'Moderators',
        managed: false,
        position: 2,
        color: 0xaa1122,
        hoist: true,
        mentionable: true,
        permissions: permissions(8),
    };
    const category = {
        id: '300000000000000000',
        name: 'Operations',
        type: 4,
        rawPosition: 0,
        parentId: null,
        permissionOverwrites: { cache: new Map() },
        isThread: () => false,
    };
    const textChannel = {
        id: '400000000000000000',
        name: 'briefing-room',
        type: 0,
        rawPosition: 1,
        parentId: category.id,
        topic: 'Daily briefings',
        nsfw: false,
        rateLimitPerUser: 5,
        defaultAutoArchiveDuration: 1440,
        permissionOverwrites: {
            cache: new Map([
                ['everyone', { id: everyone.id, type: 0, allow: permissions(1), deny: permissions(2) }],
                ['role', { id: sourceRole.id, type: 0, allow: permissions(4), deny: permissions(0) }],
                ['member', { id: '500000000000000000', type: 1, allow: permissions(8), deny: permissions(0) }],
            ]),
        },
        isThread: () => false,
    };
    const sourceGuild = {
        id: everyone.id,
        name: 'Source Server',
        iconURL: () => 'https://cdn.example/icon.png',
        roles: {
            everyone,
            fetch: async () => new Map([[everyone.id, everyone], [sourceRole.id, sourceRole]]),
        },
        channels: {
            fetch: async () => new Map([[category.id, category], [textChannel.id, textChannel]]),
        },
    };

    const blueprint = await captureGuildBlueprint(sourceGuild);
    assert.strictEqual(blueprint.roles.length, 1);
    assert.strictEqual(blueprint.channels.length, 2);
    assert.strictEqual(blueprint.everyonePermissions, '1024');

    const createdRoles = [];
    const createdChannels = [];
    const targetGuild = {
        id: '600000000000000000',
        name: 'Destination Server',
        maximumBitrate: 96000,
        roles: {
            everyone: {
                setPermissions: async () => {},
            },
            create: async options => {
                createdRoles.push(options);
                return {
                    id: '700000000000000000',
                    setPosition: async () => {},
                };
            },
        },
        channels: {
            create: async options => {
                createdChannels.push(options);
                return { id: `80000000000000000${createdChannels.length}` };
            },
        },
    };

    const result = await applyGuildBlueprint(targetGuild, blueprint);
    assert.strictEqual(result.rolesCreated, 1);
    assert.strictEqual(result.categoriesCreated, 1);
    assert.strictEqual(result.channelsCreated, 1);
    assert.strictEqual(result.skippedMemberOverwrites, 1);
    assert.strictEqual(result.errors.length, 0);
    assert.strictEqual(createdRoles[0].name, 'Moderators');
    assert.strictEqual(createdChannels[1].parent, createdChannels[0] ? '800000000000000001' : undefined);

    const overwrites = createdChannels[1].permissionOverwrites;
    assert.strictEqual(overwrites.length, 2);
    assert.strictEqual(overwrites[0].id, targetGuild.id);
    assert.strictEqual(overwrites[1].id, '700000000000000000');
    assert.strictEqual(overwrites[1].allow, 4n);

    console.log('Blueprint capture, role mapping, category mapping, and overwrite test passed.');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
