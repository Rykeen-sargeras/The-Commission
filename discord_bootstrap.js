'use strict';

const Discord = require('discord.js');

const token = String(process.env.DISCORD_TOKEN || '').trim();
if (!token) {
    console.error('Vacation mode could not start: DISCORD_TOKEN is missing.');
    process.exitCode = 1;
} else {
    const client = new Discord.Client({
        intents: [
            Discord.GatewayIntentBits.Guilds,
            Discord.GatewayIntentBits.GuildMessages,
            Discord.GatewayIntentBits.MessageContent,
        ],
    });

    function errorCode() {
        return Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, 'X');
    }

    function vacationMessage() {
        return [
            'Bot thinking…. Call back failure. Owner is not part of this discord.',
            `Error code: ${errorCode()}`,
            'Send this error code to the server admin.',
        ].join('\n');
    }

    client.once(Discord.Events.ClientReady, readyClient => {
        readyClient.user.setPresence({
            status: 'dnd',
            activities: [{
                name: '🏖️ Vacation Mode',
                type: Discord.ActivityType.Custom,
            }],
        }).catch(() => {});
        console.log(`🏖️ The Commission is in vacation mode as ${readyClient.user.tag}.`);
    });

    client.on(Discord.Events.InteractionCreate, async interaction => {
        if (!interaction.isRepliable?.()) return;
        const payload = { content: vacationMessage(), ephemeral: true };
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp(payload).catch(() => {});
        } else {
            await interaction.reply(payload).catch(() => {});
        }
    });

    client.on(Discord.Events.MessageCreate, async message => {
        if (!message.guild || message.author?.bot) return;
        const mentioned = message.mentions?.users?.has(client.user?.id);
        const looksLikeCommand = /^\s*[!/?]/.test(String(message.content || ''));
        if (!mentioned && !looksLikeCommand) return;
        await message.reply({
            content: vacationMessage(),
            allowedMentions: { repliedUser: false },
        }).catch(() => {});
    });

    const shutdown = async signal => {
        console.log(`Vacation mode shutting down from ${signal}.`);
        await client.destroy();
        process.exit(0);
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));

    client.login(token).catch(error => {
        console.error('Vacation mode Discord login failed:', error.message);
        process.exitCode = 1;
    });
}
