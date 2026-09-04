'use strict';

const fs = require('fs');
const path = require('path');

/**
 * MemberBridge has been retired from The Commission.
 *
 * This compatibility module only removes the legacy MemberBridge database and
 * panels. The replacement Commission verifier is implemented separately in
 * membership_store.js, membership_web.js, and membership_discord.js.
 */

function removeIfExists(target) {
    try {
        if (!fs.existsSync(target)) return;
        const stat = fs.statSync(target);
        if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
        else fs.rmSync(target, { force: true });
        console.log(`[MemberBridge retired] Removed ${target}`);
    } catch (error) {
        console.error(`[MemberBridge retired] Could not remove ${target}: ${error.message}`);
    }
}

function purgeLegacyVerificationData(dataDir) {
    if (!dataDir) return;
    const root = path.resolve(dataDir);
    for (const fileName of [
        'memberbridge.db',
        'memberbridge.db-wal',
        'memberbridge.db-shm',
        'memberbridge.db-journal',
    ]) {
        removeIfExists(path.join(root, fileName));
    }
    removeIfExists(path.join(root, 'memberbridge-backups'));
}

class MemberBridgeIntegration {
    constructor(client, options = {}) {
        this.retired = true;
        this.client = client;
        this.config = options.config || {};
        purgeLegacyVerificationData(options.dataDir);
    }

    async start() {
        console.log('[MemberBridge retired] Cleaning up legacy panels; the replacement Commission verifier is active separately.');
        await this.removeLegacyVerificationPanels();
    }

    async removeLegacyVerificationPanels() {
        if (!this.client?.isReady?.()) return;
        const configuredChannelId = String(this.config.verifyChannelId || '').trim();
        let removed = 0;

        for (const guild of this.client.guilds.cache.values()) {
            const candidates = guild.channels.cache.filter(channel => {
                if (!channel?.isTextBased?.() || !channel.messages?.fetch) return false;
                return channel.id === configuredChannelId || channel.name === 'verify-membership';
            });

            for (const channel of candidates.values()) {
                const messages = await channel.messages.fetch({ limit: 100 }).catch(error => {
                    console.error(`[MemberBridge retired] Could not inspect #${channel.name}: ${error.message}`);
                    return null;
                });
                if (!messages) continue;

                for (const message of messages.values()) {
                    if (message.author?.id !== this.client.user?.id) continue;
                    const legacyEmbed = message.embeds?.some(embed =>
                        embed.title === 'Verify Your Channel Membership'
                        || embed.footer?.text === 'The Commission • MemberBridge verification');
                    const legacyButtons = message.components?.some(row => row.components?.some(component =>
                        String(component.customId || '').startsWith('memberbridge:panel-')));
                    if (!legacyEmbed && !legacyButtons) continue;
                    await message.delete().then(() => { removed += 1; }).catch(error => {
                        console.error(`[MemberBridge retired] Could not delete legacy panel ${message.id}: ${error.message}`);
                    });
                }
            }
        }

        if (removed) console.log(`[MemberBridge retired] Deleted ${removed} legacy Discord verification panel${removed === 1 ? '' : 's'}.`);
    }

}

module.exports = {
    MemberBridgeIntegration,
    purgeLegacyVerificationData,
};
