'use strict';

const economyModule = require('./economy');
const discordEconomy = require('./economy_discord');

const HEIST_PING_INTERVAL_MS = 8 * 60 * 60 * 1000;
const ORIGINAL_COOLDOWN_MS = 60 * 60 * 1000;

function installHeistPingIntervalPatch() {
    const EconomyService = economyModule.EconomyService;
    const previousSetting = EconomyService.prototype.setting;

    // The heist enhancement currently checks a one-hour cooldown internally.
    // Preserve the real stored ping timestamp, but make that internal check stay
    // blocked until eight hours have actually elapsed.
    EconomyService.prototype.setting = function settingWithEightHourHeistPing(guildId, key) {
        const value = previousSetting.call(this, guildId, key);
        if (key !== 'special_heist_last_ping_at' || !value) return value;

        const lastPingAt = Number(value || 0);
        if (!Number.isFinite(lastPingAt) || lastPingAt <= 0) return value;
        const age = Date.now() - lastPingAt;
        if (age >= 0 && age < HEIST_PING_INTERVAL_MS) {
            // Keep the existing one-hour comparison false without changing the
            // timestamp persisted in the database.
            return String(Date.now() - Math.min(age, ORIGINAL_COOLDOWN_MS - 1));
        }
        return value;
    };

    const previousCreateIntegration = discordEconomy.createEconomyIntegration;
    discordEconomy.createEconomyIntegration = function createEightHourHeistPingIntegration(client, economy, options = {}) {
        const integration = previousCreateIntegration(client, economy, options);
        const previousHandleButton = integration.handleButton;

        integration.handleButton = async interaction => {
            const handled = await previousHandleButton(interaction);
            if (handled && interaction.isButton?.() && interaction.customId === 'econ:heist:notify' && interaction.replied) {
                const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
                const roleId = economy.setting(interaction.guild.id, 'heist_alert_role_id');
                const enabled = Boolean(member && roleId && member.roles.cache.has(roleId));
                const content = enabled
                    ? '🔔 Heist pings are now **on** for you. The bot will ping the **heist** role no more than once every **8 hours**.'
                    : '🔕 Heist pings are now **off** for you.';
                await interaction.editReply({ content }).catch(() => {});
            }
            return handled;
        };

        return integration;
    };
}

module.exports = {
    HEIST_PING_INTERVAL_MS,
    installHeistPingIntervalPatch,
};
