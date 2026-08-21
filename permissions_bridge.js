'use strict';

const { Client, ChannelType, PermissionFlagsBits } = require('discord.js');

const BRIDGE_CHANNEL = 'commission:permissions-request';
const CLIENT_PATCH = Symbol.for('the-commission.permissions-client-patch');
let activeClient = null;

const CHANNEL_PERMISSIONS = [
  ['ViewChannel', 'View'],
  ['Connect', 'Join'],
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

function linkedRoleFamily(name) {
  const value = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!/\b(gidgy|scooter)\b/.test(value)) return null;
  if (/\b(vvip|vip)\b/.test(value)) return 'gidgy-scooter-vip';
  if (/\bmember\b/.test(value)) return 'gidgy-scooter-member';
  return null;
}

function linkedFamilyLabel(family) {
  if (family === 'gidgy-scooter-member') return 'Gidgy + Scooter Members';
  if (family === 'gidgy-scooter-vip') return 'Gidgy + Scooter VIP / VVIP';
  return '';
}

function getClient() {
  if (!activeClient) throw new Error('Discord client is not ready yet.');
  if (!activeClient.isReady?.()) throw new Error('Discord bot is still connecting.');
  return activeClient;
}

function settleWithin(promise, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Discord refresh timed out. Using the ready cache.')), timeoutMs);
    Promise.resolve(promise).then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function getGuild(guildId) {
  const client = getClient();
  const id = String(guildId || '').trim();
  if (!id) throw new Error('Choose a Discord server.');
  const guild = client.guilds.cache.get(id) || await settleWithin(client.guilds.fetch(id)).catch(() => null);
  if (!guild) throw new Error('Discord server not found or bot does not have access.');

  // READY already hydrates roles and channels. Only call Discord's REST API when
  // a cache is genuinely empty, and never let a stalled REST request hold the UI.
  const refreshes = [];
  if (guild.roles.cache.size <= 1) refreshes.push(settleWithin(guild.roles.fetch()));
  if (guild.channels.cache.size === 0) refreshes.push(settleWithin(guild.channels.fetch()));
  if (refreshes.length) await Promise.allSettled(refreshes);
  return guild;
}

function roleList(guild) {
  return guild.roles.cache
    .map(role => {
      const family = linkedRoleFamily(role.name);
      return {
        id: role.id,
        name: role.id === guild.id ? '@everyone' : role.name,
        color: role.hexColor === '#000000' ? '#777b84' : role.hexColor,
        position: role.position,
        managed: Boolean(role.managed),
        everyone: role.id === guild.id,
        linkedFamily: family,
        linkedFamilyLabel: linkedFamilyLabel(family),
      };
    })
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

  const family = linkedRoleFamily(role.name);
  const linkedRoles = family
    ? guild.roles.cache.filter(candidate => !candidate.managed && linkedRoleFamily(candidate.name) === family)
      .map(candidate => ({ id: candidate.id, name: candidate.name }))
      .sort((a, b) => a.name.localeCompare(b.name))
    : [{ id: role.id, name: role.name }];

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

  return {
    guildId: guild.id,
    roleId: role.id,
    channels,
    linkedFamily: family,
    linkedFamilyLabel: linkedFamilyLabel(family),
    linkedRoles,
  };
}

async function pushChanges(payload) {
  const guild = await getGuild(payload.guildId);
  const roleId = String(payload.roleId || '').trim();
  const role = guild.roles.cache.get(roleId);
  if (!role) throw new Error('Role not found.');

  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  if (!changes.length) return { ok: true, changedChannels: 0, changedPermissions: 0, changedRoles: 0 };
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

  const family = linkedRoleFamily(role.name);
  const targetRoles = family
    ? guild.roles.cache.filter(candidate => !candidate.managed && linkedRoleFamily(candidate.name) === family)
    : [role];

  if (!targetRoles.length) throw new Error('No editable roles were found in this linked permission family.');

  let changedPermissions = 0;
  let changedChannels = 0;
  for (const [channelId, edits] of grouped) {
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.permissionOverwrites?.edit) continue;
    let channelChanged = false;
    for (const targetRole of targetRoles.values()) {
      await channel.permissionOverwrites.edit(targetRole, edits, {
        reason: family
          ? `The Commission linked permission family: ${linkedFamilyLabel(family)}`
          : 'The Commission web permission editor',
      });
      changedPermissions += Object.keys(edits).length;
      channelChanged = true;
    }
    if (channelChanged) changedChannels += 1;
  }

  return {
    ok: true,
    changedChannels,
    changedPermissions,
    changedRoles: targetRoles.size ?? targetRoles.length,
    linkedFamily: family,
    linkedFamilyLabel: linkedFamilyLabel(family),
    roleNames: [...targetRoles.values()].map(targetRole => targetRole.name),
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

module.exports = { CHANNEL_PERMISSIONS, linkedRoleFamily };
