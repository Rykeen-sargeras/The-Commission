'use strict';

// TEMPORARY MAINTENANCE MODE
// The existing Commission bot code is intentionally left untouched.
// Restore the previous bootstrap when the bot is ready to come back online.

const { Client, GatewayIntentBits, Events } = require('discord.js');

const MAINTENANCE_MESSAGE = 'The bot is currently on the rag. Message Stormy for anything.';
const token = String(process.env.DISCORD_TOKEN || '').trim();

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

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: MAINTENANCE_MESSAGE, ephemeral: true });
    } else {
      await interaction.reply({ content: MAINTENANCE_MESSAGE, ephemeral: true });
    }
  } catch (error) {
    console.error('[The Commission] Failed to send maintenance interaction response:', error);
  }
});

client.on(Events.MessageCreate, async message => {
  try {
    if (message.author?.bot) return;
    if (!message.mentions?.has(client.user)) return;
    await message.reply(MAINTENANCE_MESSAGE);
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
