'use strict';

const Discord = require('discord.js');

const INSTALL_KEY = Symbol.for('the-commission.youtube-clipper-discord-installed');
const PATCH_KEY = Symbol.for('the-commission.youtube-clipper-discord-patch');
const DEFAULT_CHANNEL_ID = '1543329276735266926';

function installClipperDiscordBridge(client) {
  if (!client || client[INSTALL_KEY]) return client;
  client[INSTALL_KEY] = true;
  process.on('message', async message => {
    if (message?.channel !== 'commission:clipper-post' || !message.id) return;
    try {
      if (!client.isReady()) throw new Error('The Discord bot is not connected.');
      const payload = message.payload || {};
      const channelId = String(payload.channelId || DEFAULT_CHANNEL_ID);
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased?.()) throw new Error('The configured clip channel is unavailable.');
      await channel.send({
        content: [
          '🎬 **' + String(payload.title || 'YouTube clip').slice(0, 100) + '**',
          String(payload.clipUrl || ''),
          'Source: ' + String(payload.sourceUrl || ''),
          'Clip: ' + String(payload.start || '') + '–' + String(payload.end || ''),
        ].join('\n'),
      });
      if (typeof process.send === 'function') {
        process.send({ channel: 'commission:clipper-response', id: message.id, ok: true, data: { channelId } });
      }
    } catch (error) {
      if (typeof process.send === 'function') {
        process.send({ channel: 'commission:clipper-response', id: message.id, ok: false, error: error.message });
      }
    }
  });
  return client;
}

function patchDiscordClient() {
  const proto = Discord.Client?.prototype;
  if (!proto || proto[PATCH_KEY]) return;
  Object.defineProperty(proto, PATCH_KEY, { value: true, configurable: false });
  const originalLogin = proto.login;
  proto.login = function patchedClipperDiscordLogin(...args) {
    installClipperDiscordBridge(this);
    return originalLogin.apply(this, args);
  };
}

patchDiscordClient();

module.exports = {
  DEFAULT_CHANNEL_ID,
  installClipperDiscordBridge,
  patchDiscordClient,
};

