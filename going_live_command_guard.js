'use strict';

const Discord = require('discord.js');

const COMMAND = {
  name: 'goinglive',
  description: 'Add your upcoming stream to the Misfit Mafia live schedule',
  options: [
    { type: Discord.ApplicationCommandOptionType.String, name: 'date', description: 'Date: MM/DD or YYYY-MM-DD', required: true },
    { type: Discord.ApplicationCommandOptionType.String, name: 'time', description: 'Time: 7, 7:30, 11:45, etc.', required: true },
    {
      type: Discord.ApplicationCommandOptionType.String,
      name: 'am_pm',
      description: 'AM or PM (Eastern Time)',
      required: true,
      choices: [
        { name: 'AM', value: 'AM' },
        { name: 'PM', value: 'PM' }
      ]
    },
    { type: Discord.ApplicationCommandOptionType.String, name: 'show', description: 'Stream/show title', required: false, maxLength: 80 },
    { type: Discord.ApplicationCommandOptionType.String, name: 'link', description: 'YouTube, Kick, Twitch, etc. stream/channel URL', required: false, maxLength: 250 }
  ]
};

async function ensureGoingLive(client) {
  if (!client?.isReady?.()) return;
  for (const guild of client.guilds.cache.values()) {
    try {
      const commands = await guild.commands.fetch();
      const existing = commands.find(c => c.name === 'goinglive');
      if (!existing) {
        await guild.commands.create(COMMAND);
        console.log(`✅ /goinglive command restored for guild: ${guild.name}`);
      }
    } catch (error) {
      console.error(`[Going Live] Could not verify slash command in ${guild.name}:`, error.message);
    }
  }
}

function installGuard() {
  const proto = Discord.Client.prototype;
  if (proto.__goingLiveCommandGuardPatched) return;
  proto.__goingLiveCommandGuardPatched = true;

  const previousLogin = proto.login;
  proto.login = function(...args) {
    const client = this;
    client.once(Discord.Events.ClientReady, () => {
      // The core Commission registrar clears/rebuilds commands during startup.
      // Check after that workflow has had time to finish, then keep guarding it.
      setTimeout(() => ensureGoingLive(client), 10_000).unref?.();
      setTimeout(() => ensureGoingLive(client), 30_000).unref?.();
      setInterval(() => ensureGoingLive(client), 60_000).unref?.();
    });
    return previousLogin.apply(client, args);
  };
}

module.exports = { installGuard, ensureGoingLive, COMMAND };
