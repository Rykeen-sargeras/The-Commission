'use strict';

const Discord = require('discord.js');
const discordEconomy = require('./economy_discord');

const HOT_TIP_COST = 50_000;

function money(value) {
    return Number(value || 0).toLocaleString('en-US');
}

function installHeistStoreHotTipPatch() {
    const previousCreateIntegration = discordEconomy.createEconomyIntegration;
    discordEconomy.createEconomyIntegration = function createHotTipStoreIntegration(client, economy, options = {}) {
        const integration = previousCreateIntegration(client, economy, options);
        const previousHandleButton = integration.handleButton;

        integration.handleButton = async interaction => {
            if (!interaction.isButton?.()) return previousHandleButton(interaction);

            if (interaction.customId === 'econ:luckpanel:heistbuy:hot-tip') {
                await interaction.reply({
                    ephemeral: true,
                    embeds: [new Discord.EmbedBuilder()
                        .setColor(0xd29922)
                        .setTitle('Confirm Hot Tip')
                        .setDescription(`Buy **+25% personal heist payout for your next 2 winning heists** for **${money(HOT_TIP_COST)} ${economy.config.currencyName}**?`)],
                    components: [new Discord.ActionRowBuilder().addComponents(
                        new Discord.ButtonBuilder().setCustomId('econ:luckpanel:heistconfirm:hot-tip').setLabel(`Confirm ${money(HOT_TIP_COST)}`).setEmoji('✅').setStyle(Discord.ButtonStyle.Success),
                        new Discord.ButtonBuilder().setCustomId('econ:luckpanel:cancel').setLabel('Cancel').setStyle(Discord.ButtonStyle.Secondary),
                    )],
                });
                return true;
            }

            if (interaction.customId === 'econ:luckpanel:heistconfirm:hot-tip') {
                try {
                    const result = economy.buyHeistStoreItem(interaction.guild.id, interaction.user.id, 'hot-tip', interaction.id);
                    await interaction.update({
                        embeds: [new Discord.EmbedBuilder()
                            .setColor(0x2ea043)
                            .setTitle('✅ Hot Tip Purchased')
                            .setDescription(`You now have **${Number(result.inventory?.['hot-tip'] || result.quantity || 0)} Hot Tip uses**.\nEach use adds **25%** to a winning heist payout.\nBalance: **${money(result.balance)} ${economy.config.currencyName}**.`)],
                        components: [],
                    });
                } catch (error) {
                    await interaction.update({ content: `❌ ${error.message}`, embeds: [], components: [] }).catch(() => {});
                }
                return true;
            }

            return previousHandleButton(interaction);
        };
        return integration;
    };
}

module.exports = { installHeistStoreHotTipPatch };
