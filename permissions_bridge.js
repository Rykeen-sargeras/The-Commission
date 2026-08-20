'use strict';

const { Client, ChannelType, PermissionFlagsBits } = require('discord.js');

const BRIDGE_CHANNEL = 'commission:permissions-request';
const CLIENT_PATCH = Symbol.for('the-commission.permissions-client-patch');
let activeClient = null;

const CHANNEL_PERMISSIONS = [
  ['ViewChannel', 'View'],
  ['SendMessages', 'Send'],
  ['ReadMessageHistory', 'History'],
  ['AddReactions', 'React'],
  ['EmbedLinks', 'Embeds'],
  ['AttachFiles', 'Files'],
  ['UseExternalEmojis', 'External Emoji'],
  ['UseExternalStickers', 'External Stickers'],
  ['MentionEveryone', 'Mention @everyone'],
  ['ManageMessages', 'Manage Msgs'],
  ['ManageChannels', 'Manage Channel'],
  ['ManageWebhooks', 'Webhooks'],
  ['CreatePublicThreads', 'Public Threads'],
  ['CreatePrivateThreads', 'Private Threads'],
  ['SendMessagesInThreads', 'Send in Threads'],
  ['ManageThreads', 'Manage Threads'],
  ['Connect', 'Connect'],
  ['Speak', 'Speak'],
  ['Stream', 'Video/Stream'],
  ['UseVAD', 'Voice Activity'],
  ['PrioritySpeaker', 'Priority Speaker'],
  ['MuteMembers', 'Mute Members'],
  ['DeafenMembers', 'Deafen Members'],
  ['MoveMembers', 'Move Members'],
  ['ManageEvents', 'Manage Events'],
  ['UseApplicationCommands', 'App Commands'],
  ['SendVoiceMessages', 'Voice Messages'],
  ['SendPolls', 'Polls'],
].filter(([key]) => PermissionFlagsBits[key] !== undefined);

const SUPPORTED_CHANNEL_TYPES = new Set([
  ChannelType.GuildCategory,
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
]);

function typeLabel(type) {
  switch (type) {
    case ChannelType.GuildCategory: return 'Category';
    case ChannelType.GuildText: return 'Text';
    case ChannelType.GuildAnnouncement: return 'Announcement';
    case ChannelType.GuildVoice: return 'Voice';
    case ChannelType.GuildStageVoice: return 'Stage';
    case ChannelType.GuildForum: return 'Forum';
    case ChannelType.GuildMedia: return 'Media';
    default: return 'Channel';
  }
}

function getClient() {
  if (!activeClient) throw new Error('Discord client is not ready yet.');
  if (!activeClient.isReady?.()) throw new Error('Discord bot is still connecting.');
  return activeClient;
}

async function getGuild(guildId) {
  const client = getClient();
  const id = String(guildId || '').trim();
  if (!id) throw new Error('Choose a Discord server.');
  const guild = client.guilds.cache.get(id) || await client.guilds.fetch(id).catch(() => null);
  if (!guild) throw new Error('Discord server not found or bot does not have access.');
  await Promise.allSettled([guild.roles.fetch(), guild.channels.fetch()]);
  return guild;
}

function roleList(guild) {
  return guild.roles.cache
    .map(role => ({
      id: role.id,
      name: role.id === guild.id ? '@everyone' : role.name,
      color: role.hexColor === '#000000' ? '#777b84' : role.hexColor,
      position: role.position,
      managed: Boolean(role.managed),
      everyone: role.id === guild.id,
    }))
    .sort((a, b) => {
      if (a.everyone) return 1;
      if (b.everyone) return -1;
      return b.position - a.position || a.name.localeCompare(b.name);
    });
}

function channelList(guild) {
  return guild.channels.cache
    .filter(channel => SUPPORTED_CHANNEL_TYPES.has(channel.type))
    .map(channel => ({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      typeLabel: typeLabel(channel.type),
      parentId: channel.parentId || null,
      position: Number(channel.rawPosition || 0),
    }))
    .sort((a, b) => {
      const ap = a.parentId || a.id;
      const bp = b.parentId || b.id;
      if (ap !== bp) return a.position - b.position || a.name.localeCompare(b.name);
      if (a.type === ChannelType.GuildCategory && b.type !== ChannelType.GuildCategory) return -1;
      if (b.type === ChannelType.GuildCategory && a.type !== ChannelType.GuildCategory) return 1;
      return a.position - b.position || a.name.localeCompare(b.name);
    });
}

async function guildInfo(payload) {
  const guild = await getGuild(payload.guildId);
  return {
    guild: { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 64 }) || '' },
    roles: roleList(guild),
    channels: channelList(guild),
    permissions: CHANNEL_PERMISSIONS.map(([key, label]) => ({ key, label })),
  };
}

async function roleState(payload) {
  const guild = await getGuild(payload.guildId);
  const roleId = String(payload.roleId || '').trim();
  const role = guild.roles.cache.get(roleId);
  if (!role) throw new Error('Role not found. Refresh the permission editor and try again.');

  const channels = channelList(guild).map(info => {
    const channel = guild.channels.cache.get(info.id);
    const overwrite = channel?.permissionOverwrites?.cache?.get(role.id) || null;
    const effective = channel?.permissionsFor?.(role) || null;
    const permissions = {};

    for (const [key] of CHANNEL_PERMISSIONS) {
      const flag = PermissionFlagsBits[key];
      let explicit = 'inherit';
      if (overwrite?.allow?.has(flag)) explicit = 'allow';
      else if (overwrite?.deny?.has(flag)) explicit = 'deny';
      permissions[key] = {
        allowed: Boolean(effective?.has(flag)),
        explicit,
      };
    }

    return { id: info.id, permissions };
  });

  return { guildId: guild.id, roleId: role.id, channels };
}

async function pushChanges(payload) {
  const guild = await getGuild(payload.guildId);
  const roleId = String(payload.roleId || '').trim();
  const role = guild.roles.cache.get(roleId);
  if (!role) throw new Error('Role not found.');

  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  if (!changes.length) return { ok: true, changedChannels: 0, changedPermissions: 0 };
  if (changes.length > 5000) throw new Error('Too many permission changes in one push.');

  const grouped = new Map();
  for (const change of changes) {
    const channelId = String(change?.channelId || '');
    const permission = String(change?.permission || '');
    if (!CHANNEL_PERMISSIONS.some(([key]) => key === permission)) continue;
    if (!guild.channels.cache.has(channelId)) continue;
    if (!grouped.has(channelId)) grouped.set(channelId, {});
    grouped.get(channelId)[permission] = Boolean(change.value);
  }

  let changedPermissions = 0;
  for (const [channelId, edits] of grouped) {
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.permissionOverwrites?.edit) continue;
    await channel.permissionOverwrites.edit(role, edits, {
      reason: 'The Commission web permission editor',
    });
    changedPermissions += Object.keys(edits).length;
  }

  return {
    ok: true,
    changedChannels: grouped.size,
    changedPermissions,
  };
}

async function handle(action, payload) {
  if (action === 'list-guilds') {
    const client = getClient();
    return client.guilds.cache
      .map(guild => ({ id: guild.id, name: guild.name, icon: guild.iconURL({ size: 64 }) || '' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  if (action === 'guild-info') return guildInfo(payload || {});
  if (action === 'role-state') return roleState(payload || {});
  if (action === 'push') return pushChanges(payload || {});
  throw new Error(`Unknown permission editor action: ${action}`);
}

if (!Client.prototype[CLIENT_PATCH]) {
  const originalLogin = Client.prototype.login;
  Object.defineProperty(Client.prototype, CLIENT_PATCH, { value: true, configurable: false });
  Client.prototype.login = function patchedCommissionLogin(...args) {
    activeClient = this;
    return originalLogin.apply(this, args);
  };
}

process.on('message', async message => {
  if (!message || message.channel !== BRIDGE_CHANNEL || !message.id) return;
  try {
    const data = await handle(message.action, message.payload || {});
    process.send?.({ id: message.id, ok: true, data });
  } catch (error) {
    process.send?.({ id: message.id, ok: false, error: error?.message || String(error) });
  }
});

module.exports = { CHANNEL_PERMISSIONS };
