'use strict';

const liveVoicePairs = require('./live_voice_pairs');

const APPRENTICE_CHANNEL_RE = /\bApprentice(?:\s+Waiting)?(?:\s+\d+)?\b/iu;

function installApprenticeVoiceRemovalPatch() {
    const BaseManager = liveVoicePairs.LiveVoicePairManager;
    if (!BaseManager) throw new Error('LiveVoicePairManager export is unavailable.');

    class LiveOnlyVoicePairManager extends BaseManager {
        async collectPairs(guild) {
            const pairs = await super.collectPairs(guild);
            const apprenticePairs = pairs.apprentice || new Map();
            const seen = new Set();

            for (const pair of apprenticePairs.values()) {
                for (const channel of [pair?.room, pair?.waiting]) {
                    if (!channel || seen.has(channel.id)) continue;
                    seen.add(channel.id);
                    await channel.delete('Apprentice voice channels were retired').catch(error => {
                        this.logger.error?.(`[voice-pairs] failed to delete retired Apprentice channel ${channel.id}:`, error);
                    });
                }
            }

            // Also remove malformed/legacy Apprentice channels in the managed category.
            for (const channel of guild.channels.cache.values()) {
                if (seen.has(channel.id) || channel.deleted) continue;
                if (String(channel.parentId || '') !== this.categoryId) continue;
                if (!APPRENTICE_CHANNEL_RE.test(String(channel.name || ''))) continue;
                await channel.delete('Apprentice voice channels were retired').catch(error => {
                    this.logger.error?.(`[voice-pairs] failed to delete retired Apprentice channel ${channel.id}:`, error);
                });
            }

            pairs.apprentice = new Map();
            return pairs;
        }

        async ensureBasePair(guild, pairs, family) {
            if (family === 'apprentice') return null;
            return super.ensureBasePair(guild, pairs, family);
        }

        async ensureSparePair(guild, pairs, family) {
            if (family === 'apprentice') return false;
            return super.ensureSparePair(guild, pairs, family);
        }

        async ensureRolePermissions(channel, family, kind) {
            if (family === 'apprentice') return;
            return super.ensureRolePermissions(channel, family, kind);
        }

        async ensureCanonicalName(channel, family, kind, number) {
            if (family === 'apprentice') return;
            return super.ensureCanonicalName(channel, family, kind, number);
        }

        scheduleCleanup(guild, family, number) {
            if (family === 'apprentice') return;
            return super.scheduleCleanup(guild, family, number);
        }
    }

    liveVoicePairs.LiveVoicePairManager = LiveOnlyVoicePairManager;
    liveVoicePairs.installLiveVoicePairs = function installLiveVoicePairsWithoutApprentice(client, options) {
        return new LiveOnlyVoicePairManager(client, options).install();
    };
}

module.exports = {
    APPRENTICE_CHANNEL_RE,
    installApprenticeVoiceRemovalPatch,
};
