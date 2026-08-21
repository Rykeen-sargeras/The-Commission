'use strict';

const Discord = require('discord.js');

const CATEGORY_ID = String(process.env.LIVE_VOICE_CATEGORY_ID || '1532513765701189683');
const OPEN_PANEL_NAME = '🟢 OPEN PANNEL 🟢';
const OPEN_PANEL_RE = /OPEN\s+PANN?EL/iu;
const MANAGED_KEY = Symbol.for('the-commission.open-panel-installed');

const OPEN_PERMISSIONS = [
    Discord.PermissionFlagsBits.ViewChannel,
    Discord.PermissionFlagsBits.Connect,
    Discord.PermissionFlagsBits.Speak,
    Discord.PermissionFlagsBits.Stream,
    Discord.PermissionFlagsBits.UseVAD,
];

function isOpenPanel(channel) {
    return Boolean(
        channel
        && String(channel.parentId || '') === CATEGORY_ID
        && OPEN_PANEL_RE.test(String(channel.name || ''))
    );
}

function isLiveChannel(channel) {
    if (!channel || String(channel.parentId || '') !== CATEGORY_ID) return false;
    const name = String(channel.name || '');
    return /\bLIVE\s+\d+\b/iu.test(name)
        || (/\bWaiting(?:\s+\d+)?\b/iu.test(name) && !/\bApprentice\b/iu.test(name));
}

function isApprenticeChannel(channel) {
    return Boolean(
        channel
        && String(channel.parentId || '') === CATEGORY_ID
        && /\bApprentice\b/iu.test(String(channel.name || ''))
    );
}

function roleOverwrite(roleId, allow) {
    return {
        id: roleId,
        type: Discord.OverwriteType.Role,
        allow: allow ? OPEN_PERMISSIONS : [],
        deny: allow ? [] : OPEN_PERMISSIONS,
    };
}

async function desiredOverwrites(guild) {
    await guild.roles.fetch().catch(() => null);
    const everyoneId = guild.roles.everyone?.id || guild.id;
    const overwrites = [roleOverwrite(everyoneId, false)];

    for (const role of guild.roles.cache.values()) {
        if (String(role.id) === String(everyoneId)) continue;
        overwrites.push(roleOverwrite(role.id, true));
    }
    return overwrites;
}

async function positionOpenPanel(guild, channel) {
    if (!channel?.setPosition) return;
    await guild.channels.fetch().catch(() => null);

    const categoryChannels = Array.from(guild.channels.cache.values())
        .filter(item => String(item.parentId || '') === CATEGORY_ID);
    const apprentice = categoryChannels
        .filter(isApprenticeChannel)
        .sort((a, b) => Number(a.rawPosition ?? a.position ?? 0) - Number(b.rawPosition ?? b.position ?? 0));

    let desiredPosition;
    if (apprentice.length) {
        desiredPosition = Number(apprentice[0].rawPosition ?? apprentice[0].position);
    } else {
        const live = categoryChannels.filter(isLiveChannel);
        if (!live.length) return;
        desiredPosition = Math.max(...live.map(item => Number(item.rawPosition ?? item.position ?? 0))) + 1;
    }

    const current = Number(channel.rawPosition ?? channel.position);
    if (Number.isFinite(desiredPosition) && current !== desiredPosition) {
        await channel.setPosition(desiredPosition, { reason: 'Keep OPEN PANNEL after LIVE pairs and above Apprentice channels' });
    }
}

async function ensureOpenPanel(guild) {
    if (!guild) return null;
    await guild.channels.fetch();

    let matches = Array.from(guild.channels.cache.values()).filter(isOpenPanel);
    let channel = matches[0] || null;

    if (!channel) {
        channel = await guild.channels.create({
            name: OPEN_PANEL_NAME,
            type: Discord.ChannelType.GuildVoice,
            parent: CATEGORY_ID,
            permissionOverwrites: await desiredOverwrites(guild),
            reason: 'Create permanent OPEN PANNEL voice room',
        });
        matches = [channel];
    }

    if (channel.name !== OPEN_PANEL_NAME && channel.setName) {
        await channel.setName(OPEN_PANEL_NAME, 'Normalize OPEN PANNEL channel name');
    }

    // Keep exactly one managed OPEN PANNEL room.
    for (const extra of matches.slice(1)) {
        if (extra?.deletable !== false && extra?.delete) {
            await extra.delete('Remove duplicate OPEN PANNEL room');
        }
    }

    if (channel.permissionOverwrites?.set) {
        await channel.permissionOverwrites.set(
            await desiredOverwrites(guild),
            'OPEN PANNEL is available to every assigned role but not @everyone',
        );
    }

    await positionOpenPanel(guild, channel);
    return channel;
}

function installOpenPanel(client) {
    if (!client || client[MANAGED_KEY]) return client;
    client[MANAGED_KEY] = true;

    const timers = new Map();
    const schedule = (guild, delay = 700) => {
        if (!guild) return;
        clearTimeout(timers.get(guild.id));
        timers.set(guild.id, setTimeout(() => {
            timers.delete(guild.id);
            ensureOpenPanel(guild).catch(error => console.error(`[open-panel] ${guild.id}:`, error));
        }, delay));
    };

    client.on('ready', () => {
        for (const guild of client.guilds.cache.values()) schedule(guild, 900);
    });

    client.on('channelCreate', channel => {
        if (String(channel.parentId || '') === CATEGORY_ID) schedule(channel.guild, 1000);
    });

    client.on('channelDelete', channel => {
        if (isOpenPanel(channel) || String(channel.parentId || '') === CATEGORY_ID) schedule(channel.guild, 1000);
    });

    client.on('roleCreate', role => schedule(role.guild, 500));
    client.on('roleDelete', role => schedule(role.guild, 500));

    return client;
}

function patchDiscordClient() {
    const proto = Discord.Client?.prototype;
    if (!proto || proto.__commissionOpenPanelPatched) return;
    proto.__commissionOpenPanelPatched = true;

    const originalLogin = proto.login;
    proto.login = function patchedLogin(...args) {
        installOpenPanel(this);
        return originalLogin.apply(this, args);
    };
}

patchDiscordClient();

module.exports = {
    OPEN_PANEL_NAME,
    ensureOpenPanel,
    installOpenPanel,
    isOpenPanel,
    patchDiscordClient,
};
