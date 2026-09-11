'use strict';

// TEMPORARY MAINTENANCE MODE
// The existing Commission bot code is intentionally left untouched.
// Restore the previous bootstrap when the bot is ready to come back online.

const { Client, GatewayIntentBits, Events } = require('discord.js');

const token = String(process.env.DISCORD_TOKEN || '').trim();

function makeErrorCode() {
  const letters = Math.random().toString(36).slice(2, 6).toUpperCase();
  const numbers = Math.floor(1000 + Math.random() * 9000);
  return `COM-${letters}-${numbers}`;
}

function maintenanceMessage() {
  const code = makeErrorCode();
  return `Bot thinking…. Call back failure. Owner is not part of this discord.\nError Code: ${code}\nPlease send this error code to the server admin.`;
}

if (!token) {
  console.error('[The Commission] DISCORD_TOKEN is not configured.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

client.once(Events.ClientReady, readyClient => {
  console.log(`[The Commission] Maintenance mode active as ${readyClient.user.tag}.`);
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (!interaction.isRepliable()) return;
    const content = maintenanceMessage();

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, ephemeral: true });
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
  } catch (error) {
    console.error('[The Commission] Failed to send maintenance interaction response:', error);
  }
});

client.on(Events.MessageCreate, async message => {
  try {
    if (message.author?.bot) return;
    if (!message.mentions?.has(client.user)) return;
    await message.reply(maintenanceMessage());
  } catch (error) {
    console.error('[The Commission] Failed to send maintenance message response:', error);
  }
});

async function shutdown(signal) {
  console.log(`[The Commission] ${signal} received. Shutting down maintenance mode.`);
  try { client.destroy(); } catch {}
  process.exit(0);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

client.login(token).catch(error => {
  console.error('[The Commission] Failed to log in:', error);
  process.exit(1);
});
