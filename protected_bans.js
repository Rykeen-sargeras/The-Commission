'use strict';

const { EventEmitter } = require('events');

const DEFAULT_PROTECTED_BAN_USER_IDS = Object.freeze([
    '418960298121363466',
]);

const DEFAULT_PROTECTED_BAN_REASON = 'Protected permanent ban — automatically restored if removed';
const INSTALL_MARKER = Symbol.for('the-commission.protected-bans.installed');
const BOOTSTRAP_MARKER = Symbol.for('the-commission.protected-bans.bootstrap');

function normalizeUserIds(userIds) {
    return new Set((userIds || DEFAULT_PROTECTED_BAN_USER_IDS).map(id => String(id).trim()).filter(Boolean));
}

async function createProtectedBan(guild, userId, reason) {
    if (!guild?.bans?.create) throw new Error('Guild ban manager is unavailable');
    await guild.bans.create(userId, {
        deleteMessageSeconds: 0,
        reason,
    });
}

async function ensureProtectedBan(guild, userId, reason) {
    if (!guild?.bans) return false;

    if (typeof guild.bans.fetch === 'function') {
        try {
            await guild.bans.fetch(userId);
            return false;
        } catch (_) {
            // Not currently banned (or the lookup failed). Creating the ban is
            // idempotent for our purpose and guarantees the protected state.
        }
    }

    await createProtectedBan(guild, userId, reason);
    return true;
}

function installProtectedBanGuard(client, options = {}) {
    if (!client || typeof client.on !== 'function') throw new TypeError('A Discord client is required');
    if (client[INSTALL_MARKER]) return client;
    client[INSTALL_MARKER] = true;

    const protectedUserIds = normalizeUserIds(options.userIds);
    const reason = String(options.reason || DEFAULT_PROTECTED_BAN_REASON);

    client.on('guildBanRemove', async ban => {
        const userId = String(ban?.user?.id || '');
        if (!protectedUserIds.has(userId)) return;

        try {
            await createProtectedBan(ban.guild, userId, reason);
        } catch (error) {
            // Intentionally no Discord announcement/log-channel message. Only
            // stderr is used so a failed safeguard can still be diagnosed.
            console.error(`[Protected ban] Failed to restore ban for ${userId}:`, error);
        }
    });

    const enforceOnReady = async () => {
        const guilds = client.guilds?.cache?.values ? [...client.guilds.cache.values()] : [];
        for (const guild of guilds) {
            for (const userId of protectedUserIds) {
                try {
                    await ensureProtectedBan(guild, userId, reason);
                } catch (error) {
                    console.error(`[Protected ban] Failed startup enforcement for ${userId} in guild ${guild?.id || 'unknown'}:`, error);
                }
            }
        }
    };

    if (typeof client.once === 'function') {
        client.once('ready', enforceOnReady);
    }

    return client;
}

function installProtectedBanBootstrap(Discord, options = {}) {
    const Client = Discord?.Client;
    if (!Client?.prototype?.login) throw new TypeError('discord.js Client is required');
    if (Client.prototype[BOOTSTRAP_MARKER]) return;

    const originalLogin = Client.prototype.login;
    Object.defineProperty(Client.prototype, BOOTSTRAP_MARKER, {
        value: true,
        configurable: false,
        enumerable: false,
        writable: false,
    });

    Client.prototype.login = function protectedBanLogin(...args) {
        installProtectedBanGuard(this, options);
        return originalLogin.apply(this, args);
    };
}

module.exports = {
    DEFAULT_PROTECTED_BAN_USER_IDS,
    DEFAULT_PROTECTED_BAN_REASON,
    createProtectedBan,
    ensureProtectedBan,
    installProtectedBanGuard,
    installProtectedBanBootstrap,
};
