'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Discord = require('discord.js');

const BOARD_CHANNEL_ID = process.env.GOING_LIVE_CHANNEL_ID || '1532513768855175279';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'going-live-schedule.json');
const ZONE = 'America/New_York';

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

function easternNowParts() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { date: `${map.year}-${map.month}-${map.day}`, hm: `${map.hour === '24' ? '00' : map.hour}:${map.minute}` };
}

function normalizeDate(input) {
  const raw = String(input || '').trim();
  let y, m, d;
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(raw)) {
    [y, m, d] = raw.split('-').map(Number);
  } else if (/^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/.test(raw)) {
    const p = raw.split('/').map(Number);
    m = p[0]; d = p[1];
    if (p[2]) y = p[2] < 100 ? 2000 + p[2] : p[2];
    else y = Number(easternNowParts().date.slice(0,4));
  } else {
    throw new Error('Date must be YYYY-MM-DD or MM/DD.');
  }
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) throw new Error('That date is not valid.');
  return `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

function normalizeTime(input, ampm) {
  const raw = String(input || '').trim().replace(/\s+/g, '');
  const match = raw.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!match) throw new Error('Time must look like 7, 7:30, 11, or 11:45.');
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const period = String(ampm || '').toUpperCase();
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59 || !['AM','PM'].includes(period)) throw new Error('Enter a valid 12-hour time and choose AM or PM.');
  const display = `${hour}:${String(minute).padStart(2,'0')} ${period}`;
  if (period === 'AM') hour = hour === 12 ? 0 : hour;
  else hour = hour === 12 ? 12 : hour + 12;
  return { display, hm: `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}` };
}

function cleanup(store) {
  const now = easternNowParts();
  const cutoff = `${now.date} ${now.hm}`;
  const before = store.entries.length;
  store.entries = store.entries.filter(e => e.status === 'pending' || `${e.date} ${e.hm}` >= cutoff);
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

function boardEmbed(entries) {
  const lines = entries.slice(0, 35).map((e, i) => {
    const conflict = entries.some((x,j) => j !== i && x.date === e.date && x.hm === e.hm) ? ' ⚠️' : '';
    const link = e.link ? ` • [Watch](${e.link})` : '';
    const title = e.title ? ` — **${e.title}**` : '';
    return `**${prettyDate(e.date)} • ${e.displayTime} ET**${conflict}\n<@${e.userId}>${title}${link}`;
  });
  return new Discord.EmbedBuilder()
    .setColor('#b21f38')
    .setTitle('📺 Who’s Going Live')
    .setDescription(lines.length ? lines.join('\n\n') : 'No upcoming streams are scheduled yet. Use **/goinglive** to claim a time.')
    .setFooter({ text: 'All schedule times are Eastern Time • Updated automatically' })
    .setTimestamp();
}

async function refreshBoard(client) {
  const store = cleanup(readStore());
  const entries = store.entries.filter(e => e.status === 'active').sort((a,b) => `${a.date} ${a.hm}`.localeCompare(`${b.date} ${b.hm}`));
  const channel = await client.channels.fetch(BOARD_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) return;
  const payload = { embeds: [boardEmbed(entries)], allowedMentions: { parse: [] } };
  let message = null;
  if (store.boardMessageId) message = await channel.messages.fetch(store.boardMessageId).catch(() => null);
  if (message) await message.edit(payload);
  else {
    message = await channel.send(payload);
    store.boardMessageId = message.id;
    writeStore(store);
  }
}

async function registerCommand(client) {
  const guild = client.guilds.cache.first();
  if (!guild) return;
  const existing = await guild.commands.fetch().catch(() => null);
  if (existing?.some(c => c.name === 'goinglive')) return;
  await guild.commands.create({
    name: 'goinglive',
    description: 'Add your upcoming stream to the Misfit Mafia live schedule',
    options: [
      { type: 3, name: 'date', description: 'Date: MM/DD or YYYY-MM-DD', required: true },
      { type: 3, name: 'time', description: 'Time: 7, 7:30, 11:45, etc.', required: true },
      { type: 3, name: 'am_pm', description: 'AM or PM (Eastern Time)', required: true, choices: [{name:'AM',value:'AM'},{name:'PM',value:'PM'}] },
      { type: 3, name: 'show', description: 'Stream/show title', required: false, max_length: 80 },
      { type: 3, name: 'link', description: 'YouTube, Kick, Twitch, etc. stream/channel URL', required: false, max_length: 250 }
    ]
  });
  console.log('✅ /goinglive command registered');
}

async function notifyConflict(client, existing, newcomer) {
  const user = await client.users.fetch(existing.userId).catch(() => null);
  if (!user) return;
  const row = new Discord.ActionRowBuilder().addComponents(
    new Discord.ButtonBuilder().setCustomId(`gl:keep:${existing.id}`).setLabel('Keep My Slot').setStyle(Discord.ButtonStyle.Primary),
    new Discord.ButtonBuilder().setCustomId(`gl:release:${existing.id}`).setLabel('Release My Slot').setStyle(Discord.ButtonStyle.Secondary)
  );
  await user.send({
    content: `⚠️ **Going Live schedule conflict**\n<@${newcomer.userId}> requested **${prettyDate(newcomer.date)} at ${newcomer.displayTime} ET**, which matches your scheduled time. You can keep your slot or release it.`,
    components: [row], allowedMentions: { parse: [] }
  }).catch(() => null);
}

async function handleGoingLive(interaction, client) {
  try {
    const date = normalizeDate(interaction.options.getString('date'));
    const time = normalizeTime(interaction.options.getString('time'), interaction.options.getString('am_pm'));
    const now = easternNowParts();
    if (`${date} ${time.hm}` < `${now.date} ${now.hm}`) return interaction.reply({ content: 'That time has already passed in Eastern Time. Pick an upcoming time.', ephemeral: true });

    const store = cleanup(readStore());
    const entry = {
      id: crypto.randomUUID().slice(0,12), userId: interaction.user.id,
      username: interaction.user.globalName || interaction.user.username,
      date, hm: time.hm, displayTime: time.display,
      title: interaction.options.getString('show') || '',
      link: interaction.options.getString('link') || '',
      createdAt: new Date().toISOString(), status: 'active'
    };
    const conflicts = store.entries.filter(e => e.status === 'active' && e.date === date && e.hm === time.hm && e.userId !== interaction.user.id);
    const own = store.entries.find(e => e.status === 'active' && e.userId === interaction.user.id && e.date === date && e.hm === time.hm);
    if (own) return interaction.reply({ content: `You are already scheduled for **${prettyDate(date)} at ${time.display} ET**.`, ephemeral: true });

    if (conflicts.length) {
      entry.status = 'pending';
      store.entries.push(entry); writeStore(store);
      for (const conflict of conflicts) await notifyConflict(client, conflict, entry);
      const row = new Discord.ActionRowBuilder().addComponents(
        new Discord.ButtonBuilder().setCustomId(`gl:anyway:${entry.id}`).setLabel('Keep Anyway').setStyle(Discord.ButtonStyle.Danger),
        new Discord.ButtonBuilder().setCustomId(`gl:change:${entry.id}`).setLabel('Change Time').setStyle(Discord.ButtonStyle.Secondary)
      );
      return interaction.reply({
        content: `⚠️ **That time is already booked.**\n${conflicts.map(e=>`<@${e.userId}> — ${e.title || 'Scheduled stream'}`).join('\n')}\n\nThey have been notified. You can keep the overlapping time anyway or change your time.`,
        components:[row], ephemeral:true
      });
    }

    store.entries = store.entries.filter(e => !(e.status === 'active' && e.userId === interaction.user.id && e.date === date));
    store.entries.push(entry); writeStore(store);
    await refreshBoard(client);
    return interaction.reply({ content: `✅ Added to the live schedule: **${prettyDate(date)} at ${time.display} ET**${entry.title ? ` — ${entry.title}` : ''}.`, ephemeral: true });
  } catch (error) {
    return interaction.reply({ content: `❌ ${error.message}`, ephemeral: true }).catch(() => null);
  }
}

async function handleButton(interaction, client) {
  if (!interaction.customId.startsWith('gl:')) return false;
  const [, action, id] = interaction.customId.split(':');
  const store = readStore();
  const entry = store.entries.find(e => e.id === id);
  if (!entry) { await interaction.reply({content:'That schedule request no longer exists.',ephemeral:true}).catch(()=>null); return true; }

  if (action === 'anyway') {
    if (interaction.user.id !== entry.userId) return true;
    entry.status = 'active'; writeStore(store); await refreshBoard(client);
    await interaction.update({ content:`✅ You kept **${prettyDate(entry.date)} at ${entry.displayTime} ET**. The overlap is now shown on the schedule.`, components:[] });
    return true;
  }
  if (action === 'change') {
    if (interaction.user.id !== entry.userId) return true;
    store.entries = store.entries.filter(e => e.id !== id); writeStore(store);
    await interaction.update({ content:'Your pending request was removed. Run **/goinglive** again with your new time.', components:[] });
    return true;
  }
  if (action === 'keep') {
    if (interaction.user.id !== entry.userId) return true;
    await interaction.update({ content:`✅ Your **${prettyDate(entry.date)} at ${entry.displayTime} ET** slot is staying on the schedule.`, components:[] });
    return true;
  }
  if (action === 'release') {
    if (interaction.user.id !== entry.userId) return true;
    store.entries = store.entries.filter(e => e.id !== id); writeStore(store); await refreshBoard(client);
    await interaction.update({ content:`Your **${prettyDate(entry.date)} at ${entry.displayTime} ET** slot was released.`, components:[] });
    return true;
  }
  return false;
}

function install(client) {
  if (client.__goingLiveInstalled) return;
  client.__goingLiveInstalled = true;
  client.on(Discord.Events.InteractionCreate, async interaction => {
    if (interaction.isChatInputCommand() && interaction.commandName === 'goinglive') return handleGoingLive(interaction, client);
    if (interaction.isButton() && interaction.customId.startsWith('gl:')) return handleButton(interaction, client);
  });
  client.once(Discord.Events.ClientReady, async () => {
    setTimeout(async () => {
      try { await registerCommand(client); await refreshBoard(client); }
      catch (e) { console.error('Going Live scheduler startup failed:', e); }
    }, 2500).unref?.();
    setInterval(() => refreshBoard(client).catch(e => console.error('Going Live board refresh failed:', e.message)), 5 * 60 * 1000).unref?.();
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

module.exports = { install, patchDiscordClient, upcomingEntries, FILE, BOARD_CHANNEL_ID, ZONE };
