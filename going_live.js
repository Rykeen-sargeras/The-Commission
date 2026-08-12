'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Discord = require('discord.js');
const {
  ZONE,
  easternParts,
  pruneForDailyReset,
  normalizeDate,
  normalizeTime,
  normalizeLink,
} = require('./going_live_time');

const GUILD_ID = process.env.GOING_LIVE_GUILD_ID || '1532503754350264571';
const BOARD_CHANNEL_ID = process.env.GOING_LIVE_CHANNEL_ID || '1532513768855175279';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'going-live-schedule.json');
const INTERACTION_CREATE = Discord.Events?.InteractionCreate || 'interactionCreate';
const CLIENT_READY = Discord.Events?.ClientReady || 'ready';

fs.mkdirSync(DATA_DIR, { recursive: true });

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [], boardMessageId: parsed.boardMessageId || '' };
  } catch {
    return { entries: [], boardMessageId: '' };
  }
}

function writeStore(store) {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, FILE);
}

function cleanup(store) {
  const before = store.entries.length;
  store.entries = pruneForDailyReset(store.entries);
  if (store.entries.length !== before) writeStore(store);
  return store;
}

function upcomingEntries() {
  const store = cleanup(readStore());
  return store.entries.filter(e => e.status === 'active').sort((a,b) => `${a.date} ${a.hm} ${a.createdAt}`.localeCompare(`${b.date} ${b.hm} ${b.createdAt}`));
}

function prettyDate(date) {
  const [y,m,d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'}).format(new Date(Date.UTC(y,m-1,d)));
}

function safeLink(value) {
  try { return normalizeLink(value); } catch { return ''; }
}

function boardEmbed(entries) {
  const lines = entries.map((e, i) => {
    const conflict = entries.some((x,j) => j !== i && x.date === e.date && x.hm === e.hm) ? ' ⚠️' : '';
    const linkUrl = safeLink(e.link);
    const link = linkUrl ? ` • [Watch](${linkUrl})` : '';
    const title = e.title ? ` — **${e.title}**` : '';
    return `**${prettyDate(e.date)} • ${e.displayTime} ET**${conflict}\n<@${e.userId}>${title}${link}`;
  });
  const visible = [];
  let descriptionLength = 0;
  for (const line of lines) {
    if (descriptionLength + line.length + 2 > 3_850) break;
    visible.push(line);
    descriptionLength += line.length + 2;
  }
  if (visible.length < lines.length) visible.push(`*…and ${lines.length - visible.length} more scheduled stream(s).*`);

  return new Discord.EmbedBuilder()
    .setColor('#b21f38')
    .setTitle('📺 Who’s Going Live')
    .setDescription(visible.length ? visible.join('\n\n') : 'No upcoming streams are scheduled yet. Use **/goinglive** to claim a time.')
    .setFooter({ text: 'All schedule times are Eastern Time • Board resets daily at 5:00 AM ET' })
    .setTimestamp();
}

async function refreshBoard(client) {
  const store = cleanup(readStore());
  const entries = store.entries.filter(e => e.status === 'active').sort((a,b) => `${a.date} ${a.hm}`.localeCompare(`${b.date} ${b.hm}`));
  const channel = await client.channels.fetch(BOARD_CHANNEL_ID).catch(error => {
    console.error(`[Going Live] Could not fetch board channel ${BOARD_CHANNEL_ID}: ${error.message}`);
    return null;
  });
  if (!channel || !channel.isTextBased()) {
    console.error(`[Going Live] Board channel ${BOARD_CHANNEL_ID} is unavailable or not text based.`);
    return;
  }
  const payload = { embeds: [boardEmbed(entries)], allowedMentions: { parse: [] } };
  let message = null;
  if (store.boardMessageId) message = await channel.messages.fetch(store.boardMessageId).catch(() => null);
  if (message) {
    await message.edit(payload);
    console.log(`[Going Live] Board refreshed in #${channel.name}.`);
  } else {
    message = await channel.send(payload);
    store.boardMessageId = message.id;
    writeStore(store);
    console.log(`[Going Live] Board created in #${channel.name} (${BOARD_CHANNEL_ID}), message ${message.id}.`);
  }
}

let repostQueue = Promise.resolve();

async function repostBoardNow(client) {
  const store = cleanup(readStore());
  const entries = store.entries.filter(e => e.status === 'active').sort((a,b) => `${a.date} ${a.hm}`.localeCompare(`${b.date} ${b.hm}`));
  const channel = await client.channels.fetch(BOARD_CHANNEL_ID).catch(error => {
    console.error(`[Going Live] Could not fetch board channel ${BOARD_CHANNEL_ID}: ${error.message}`);
    return null;
  });
  if (!channel || !channel.isTextBased()) {
    throw new Error(`Going Live board channel ${BOARD_CHANNEL_ID} is unavailable.`);
  }

  if (store.boardMessageId) {
    const previous = await channel.messages.fetch(store.boardMessageId).catch(() => null);
    if (previous) {
      await previous.delete().catch(error => {
        console.warn(`[Going Live] Could not remove previous board message: ${error.message}`);
      });
    }
  }

  const message = await channel.send({
    embeds: [boardEmbed(entries)],
    allowedMentions: { parse: [] },
  });
  store.boardMessageId = message.id;
  writeStore(store);
  console.log(`[Going Live] Board reposted in #${channel.name} (${message.id}).`);
  return message;
}

function repostBoard(client) {
  const next = repostQueue.catch(() => null).then(() => repostBoardNow(client));
  repostQueue = next;
  return next;
}

const GOING_LIVE_COMMAND = {
  name: 'goinglive',
  description: 'Add your upcoming stream to the Misfit Mafia live schedule',
  options: [
    { type: 3, name: 'date', description: 'Date: MM/DD or YYYY-MM-DD', required: true },
    { type: 3, name: 'time', description: 'Time: 7, 7:30, 11:45, etc.', required: true },
    { type: 3, name: 'am_pm', description: 'AM or PM (Eastern Time)', required: true, choices: [{name:'AM',value:'AM'},{name:'PM',value:'PM'}] },
    { type: 3, name: 'show', description: 'Stream/show title', required: false, max_length: 80 },
    { type: 3, name: 'link', description: 'YouTube, Kick, Twitch, etc. stream/channel URL', required: false, max_length: 250 }
  ]
};

const WHO_COMMAND = {
  name: 'who',
  description: 'Repost the Who’s Going Live schedule board',
};

async function registerCommand(client) {
  const guild = await client.guilds.fetch(GUILD_ID).catch(error => {
    console.error(`[Going Live] Could not fetch Misfit Mafia guild ${GUILD_ID}: ${error.message}`);
    return null;
  });
  if (!guild) return false;
  const existing = await guild.commands.fetch().catch(error => {
    console.error(`[Going Live] Could not fetch guild commands: ${error.message}`);
    return null;
  });
  for (const command of [GOING_LIVE_COMMAND, WHO_COMMAND]) {
    const found = existing?.find(c => c.name === command.name);
    if (!found) {
      await guild.commands.create(command);
      console.log(`✅ /${command.name} command registered directly in ${guild.name} (${GUILD_ID})`);
    }
  }
  return true;
}

async function notifyConflict(client, existing, newcomer) {
  const user = await client.users.fetch(existing.userId).catch(() => null);
  if (!user) return;
  const row = new Discord.ActionRowBuilder().addComponents(
    new Discord.ButtonBuilder().setCustomId(`gl:keep:${existing.id}:${newcomer.id}`).setLabel('Keep My Slot').setStyle(Discord.ButtonStyle.Primary),
    new Discord.ButtonBuilder().setCustomId(`gl:adjust:${existing.id}:${newcomer.id}`).setLabel('Adjust My Time').setStyle(Discord.ButtonStyle.Secondary)
  );
  await user.send({
    content: `⚠️ **Going Live schedule conflict**\n<@${newcomer.userId}> requested **${prettyDate(newcomer.date)} at ${newcomer.displayTime} ET**, which matches your scheduled time. You can keep your slot or adjust to another time.`,
    components: [row], allowedMentions: { parse: [] }
  }).catch(() => null);
}

async function notifyUser(client, userId, content) {
  const user = await client.users.fetch(userId).catch(() => null);
  if (user) await user.send({ content, allowedMentions: { parse: [] } }).catch(() => null);
}

function activateEntry(store, entry) {
  store.entries = store.entries.filter(candidate => !(
    candidate.id !== entry.id
    && candidate.status === 'active'
    && candidate.userId === entry.userId
    && candidate.date === entry.date
  ));
  entry.status = 'active';
}

function remainingConflicts(store, entry) {
  return store.entries.filter(candidate => candidate.status === 'active'
    && candidate.id !== entry.id
    && candidate.userId !== entry.userId
    && candidate.date === entry.date
    && candidate.hm === entry.hm);
}

function promoteOldestPendingForSlot(store, date, hm) {
  const candidate = store.entries
    .filter(entry => entry.status === 'pending' && entry.date === date && entry.hm === hm)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
  if (!candidate || remainingConflicts(store, candidate).length) return null;
  activateEntry(store, candidate);
  return candidate;
}

async function handleWho(interaction, client) {
  await interaction.deferReply({ ephemeral: true });
  await repostBoard(client);
  return interaction.editReply({ content: '✅ The Who’s Going Live board was reposted.' });
}

async function handleGoingLive(interaction, client) {
  try {
    await interaction.deferReply({ ephemeral: true });
    const date = normalizeDate(interaction.options.getString('date'));
    const time = normalizeTime(interaction.options.getString('time'), interaction.options.getString('am_pm'));
    const now = easternParts();
    if (`${date} ${time.hm}` < `${now.date} ${now.hm}`) return interaction.editReply({ content: 'That time has already passed in Eastern Time. Pick an upcoming time.' });

    const store = cleanup(readStore());
    const entry = {
      id: crypto.randomUUID().slice(0,12), userId: interaction.user.id,
      username: interaction.user.globalName || interaction.user.username,
      date, hm: time.hm, displayTime: time.display,
      title: String(interaction.options.getString('show') || '').trim(),
      link: normalizeLink(interaction.options.getString('link')),
      createdAt: new Date().toISOString(), status: 'active'
    };
    const conflicts = store.entries.filter(e => e.status === 'active' && e.date === date && e.hm === time.hm && e.userId !== interaction.user.id);
    const own = store.entries.find(e => e.status === 'active' && e.userId === interaction.user.id && e.date === date && e.hm === time.hm);
    if (own) return interaction.editReply({ content: `You are already scheduled for **${prettyDate(date)} at ${time.display} ET**.` });

    if (conflicts.length) {
      entry.status = 'pending';
      store.entries.push(entry); writeStore(store);
      for (const conflict of conflicts) await notifyConflict(client, conflict, entry);
      const row = new Discord.ActionRowBuilder().addComponents(
        new Discord.ButtonBuilder().setCustomId(`gl:anyway:${entry.id}`).setLabel('Keep Anyway').setStyle(Discord.ButtonStyle.Danger),
        new Discord.ButtonBuilder().setCustomId(`gl:change:${entry.id}`).setLabel('Change Time').setStyle(Discord.ButtonStyle.Secondary)
      );
      return interaction.editReply({
        content: `⚠️ **That time is already booked.**\n${conflicts.map(e=>`<@${e.userId}> — ${e.title || 'Scheduled stream'}`).join('\n')}\n\nThey have been notified. You can keep the overlapping time anyway or change your time.`,
        components:[row]
      });
    }

    store.entries = store.entries.filter(e => !(e.status === 'active' && e.userId === interaction.user.id && e.date === date));
    store.entries.push(entry); writeStore(store);
    await repostBoard(client);
    return interaction.editReply({ content: `✅ Added to the live schedule: **${prettyDate(date)} at ${time.display} ET**${entry.title ? ` — ${entry.title}` : ''}.` });
  } catch (error) {
    const alreadyAcknowledged = interaction.deferred || interaction.replied;
    const respond = alreadyAcknowledged ? interaction.editReply.bind(interaction) : interaction.reply.bind(interaction);
    const payload = { content: `❌ ${error.message}` };
    if (!alreadyAcknowledged) payload.ephemeral = true;
    return respond(payload).catch(() => null);
  }
}

async function handleButton(interaction, client) {
  if (!interaction.customId.startsWith('gl:')) return false;
  const [, action, id, pendingId] = interaction.customId.split(':');
  const store = cleanup(readStore());
  const entry = store.entries.find(e => e.id === id);
  if (!entry) { await interaction.reply({content:'That schedule request no longer exists.',ephemeral:true}).catch(()=>null); return true; }

  const deny = async () => {
    await interaction.reply({ content: 'Only the streamer who owns this schedule request can use that button.', ephemeral: true }).catch(() => null);
    return true;
  };

  if (action === 'anyway') {
    if (interaction.user.id !== entry.userId) return deny();
    activateEntry(store, entry); writeStore(store);
    await interaction.update({ content:`✅ You kept **${prettyDate(entry.date)} at ${entry.displayTime} ET**. The overlap is now shown on the schedule.`, components:[] });
    await repostBoard(client);
    return true;
  }
  if (action === 'change') {
    if (interaction.user.id !== entry.userId) return deny();
    store.entries = store.entries.filter(e => e.id !== id); writeStore(store);
    await interaction.update({ content:'Your pending request was removed. Run **/goinglive** again with your new time.', components:[] });
    return true;
  }
  if (action === 'keep') {
    if (interaction.user.id !== entry.userId) return deny();
    await interaction.update({ content:`✅ Your **${prettyDate(entry.date)} at ${entry.displayTime} ET** slot is staying on the schedule.`, components:[] });
    const pending = store.entries.find(candidate => candidate.id === pendingId && candidate.status === 'pending');
    if (pending) {
      await notifyUser(client, pending.userId, `The streamer already booked for **${prettyDate(entry.date)} at ${entry.displayTime} ET** kept their slot. You can still keep the overlap or change your time using the buttons on your original /goinglive response.`);
    }
    return true;
  }
  if (action === 'adjust' || action === 'release') {
    if (interaction.user.id !== entry.userId) return deny();
    store.entries = store.entries.filter(candidate => candidate.id !== id);
    const requested = store.entries.find(candidate => candidate.id === pendingId && candidate.status === 'pending');
    let promoted = null;
    if (requested && !remainingConflicts(store, requested).length) {
      activateEntry(store, requested);
      promoted = requested;
    } else {
      promoted = promoteOldestPendingForSlot(store, entry.date, entry.hm);
    }
    writeStore(store);
    await interaction.update({ content:`Your **${prettyDate(entry.date)} at ${entry.displayTime} ET** slot was released.`, components:[] });
    if (promoted) await repostBoard(client);
    else await refreshBoard(client);
    if (promoted) {
      await notifyUser(client, promoted.userId, `Your requested time, **${prettyDate(promoted.date)} at ${promoted.displayTime} ET**, is now confirmed and has been added to the Going Live board.`);
    }
    return true;
  }
  return false;
}

function install(client) {
  if (client.__goingLiveInstalled) return;
  client.__goingLiveInstalled = true;
  console.log('[Going Live] Scheduler installed on the active Discord client.');

  client.on(INTERACTION_CREATE, async interaction => {
    try {
      if (interaction.guildId !== GUILD_ID && interaction.guildId) return;
      if (interaction.isChatInputCommand() && interaction.commandName === 'goinglive') return await handleGoingLive(interaction, client);
      if (interaction.isChatInputCommand() && interaction.commandName === 'who') return await handleWho(interaction, client);
      if (interaction.isButton() && interaction.customId.startsWith('gl:')) return await handleButton(interaction, client);
    } catch (error) {
      console.error('[Going Live] Interaction failed:', error);
      if (!interaction.deferred && !interaction.replied) {
        await interaction.reply({ content: 'The Going Live schedule could not be updated. Please try again.', ephemeral: true }).catch(() => null);
      }
    }
  });

  client.once(CLIENT_READY, async () => {
    console.log(`[Going Live] Discord ready as ${client.user.tag}; initializing Misfit Mafia schedule.`);
    const sync = async () => {
      try {
        await registerCommand(client);
        await refreshBoard(client);
      } catch (e) {
        console.error('[Going Live] Sync failed:', e);
      }
    };
    setTimeout(sync, 5000).unref?.();
    setInterval(sync, 60 * 1000).unref?.();
  });
}

function patchDiscordClient() {
  const proto = Discord.Client.prototype;
  if (proto.__goingLivePatched) return;
  proto.__goingLivePatched = true;
  const originalLogin = proto.login;
  proto.login = function(...args) {
    install(this);
    return originalLogin.apply(this, args);
  };
}

module.exports = { install, patchDiscordClient, upcomingEntries, refreshBoard, repostBoard, registerCommand, GOING_LIVE_COMMAND, WHO_COMMAND, FILE, GUILD_ID, BOARD_CHANNEL_ID, ZONE };
