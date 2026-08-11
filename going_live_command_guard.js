'use strict';

const Discord = require('discord.js');
const { GOING_LIVE_COMMAND, GUILD_ID } = require('./going_live');

const CLIENT_READY = Discord.Events?.ClientReady || 'ready';

async function ensureGoingLive(client) {
  if (!client?.isReady?.()) return;
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const commands = await guild.commands.fetch();
    const existing = commands.find(command => command.name === GOING_LIVE_COMMAND.name);
    if (!existing) {
      await guild.commands.create(GOING_LIVE_COMMAND);
      console.log(`✅ /goinglive command restored for guild: ${guild.name}`);
    }
  } catch (error) {
    console.error(`[Going Live] Could not verify slash command in guild ${GUILD_ID}:`, error.message);
  }
}

function installGuard() {
  const proto = Discord.Client.prototype;
  if (proto.__goingLiveCommandGuardPatched) return;
  proto.__goingLiveCommandGuardPatched = true;

  const previousLogin = proto.login;
  proto.login = function(...args) {
    const client = this;
    client.once(CLIENT_READY, () => {
      // The core Commission registrar clears/rebuilds commands during startup.
      // Check after that workflow has had time to finish, then keep guarding it.
      setTimeout(() => ensureGoingLive(client), 10_000).unref?.();
      setTimeout(() => ensureGoingLive(client), 30_000).unref?.();
      setInterval(() => ensureGoingLive(client), 60_000).unref?.();
    });
    return previousLogin.apply(client, args);
  };
}

module.exports = { installGuard, ensureGoingLive, COMMAND: GOING_LIVE_COMMAND };
