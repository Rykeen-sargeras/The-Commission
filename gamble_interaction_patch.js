'use strict';

const Discord = require('discord.js');
const { gambleMenuPayload } = require('./economy_command_cleanup_patch');

function currencyName() {
    try {
        const config = JSON.parse(process.env.ECONOMY_CONFIG_JSON || '{}');
        return config.currencyName || 'Blood Money';
    } catch {
        return 'Blood Money';
    }
}

function installGambleInteractionPatch() {
    if (Discord.Client.prototype.__commissionGambleInteractionInstalled) return;
    Discord.Client.prototype.__commissionGambleInteractionInstalled = true;

    const originalEmit = Discord.Client.prototype.emit;
    Discord.Client.prototype.emit = function patchedEmit(eventName, ...args) {
        if (eventName !== 'interactionCreate') return originalEmit.call(this, eventName, ...args);

        const interaction = args[0];
        if (!interaction?.isChatInputCommand?.() || interaction.commandName !== 'gamble') {
            return originalEmit.call(this, eventName, ...args);
        }

        Promise.resolve().then(async () => {
            try {
                if (!interaction.deferred && !interaction.replied) {
                    await interaction.reply(gambleMenuPayload(currencyName()));
                }
                console.log(`🎲 /gamble menu opened by ${interaction.user?.tag || interaction.user?.id || 'unknown user'}`);
            } catch (error) {
                console.error('❌ /gamble interaction failed:', error);
                const payload = { content: '❌ The gambling menu could not be opened. Please try again.', ephemeral: true };
                try {
                    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
                    else await interaction.reply(payload);
                } catch {}
            }
        });

        // /gamble is fully handled here. Select-menu and modal interactions still
        // flow through to economy_command_cleanup_patch's normal listeners.
        return false;
    };
}

installGambleInteractionPatch();

module.exports = { installGambleInteractionPatch };
