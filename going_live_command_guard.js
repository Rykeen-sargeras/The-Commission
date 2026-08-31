'use strict';

const Discord = require('discord.js');
const { GOING_LIVE_COMMAND, WHO_COMMAND, GUILD_ID } = require('./going_live');

const CLIENT_READY = Discord.Events?.ClientReady || 'ready';
const INSTALL_KEY = Symbol.for('the-commission.going-live-command-guard-installed');

async function ensureGoingLive(client) {
  if (!client?.isReady?.()) return;
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const commands = await guild.commands.fetch();
    for (const definition of [GOING_LIVE_COMMAND, WHO_COMMAND]) {
      const existing = commands.find(command => command.name === definition.name);
      if (!existing) {
        await guild.commands.create(definition);
        console.log(`✅ /${definition.name} command restored for guild: ${guild.name}`);
      }
    }
  } catch (error) {
    console.error(`[Going Live] Could not verify slash command in guild ${GUILD_ID}:`, error.message);
  }
}

function installGuard(client) {
  if (!client || client[INSTALL_KEY]) return client;
  client[INSTALL_KEY] = true;
  client.once(CLIENT_READY, () => {
    // The core Commission registrar clears/rebuilds commands during startup.
    // Check after that workflow has had time to finish, then keep guarding it.
    setTimeout(() => ensureGoingLive(client), 10_000).unref?.();
    setTimeout(() => ensureGoingLive(client), 30_000).unref?.();
    setInterval(() => ensureGoingLive(client), 60_000).unref?.();
  });
  return client;
}

module.exports = { installGuard, ensureGoingLive, COMMAND: GOING_LIVE_COMMAND, COMMANDS: [GOING_LIVE_COMMAND, WHO_COMMAND] };
