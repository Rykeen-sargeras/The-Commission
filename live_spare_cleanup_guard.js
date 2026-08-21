'use strict';

const { LiveVoicePairManager } = require('./live_voice_pairs');

const PATCHED = Symbol.for('the-commission.live-spare-cleanup-guard');

function memberCount(channel) {
    return Number(channel?.members?.size || 0);
}

function pairMemberCount(pair) {
    return memberCount(pair?.room) + memberCount(pair?.waiting);
}

function isCompleteEmptyPair(pair) {
    return Boolean(pair?.room && pair?.waiting && pairMemberCount(pair) === 0);
}

function installLiveSpareCleanupGuard() {
    const proto = LiveVoicePairManager?.prototype;
    if (!proto || proto[PATCHED]) return;
    proto[PATCHED] = true;

    const originalDeletePairIfEmpty = proto.deletePairIfEmpty;

    proto.deletePairIfEmpty = async function guardedDeletePairIfEmpty(guild, family, number) {
        if (family !== 'live' || number <= 1) {
            return originalDeletePairIfEmpty.call(this, guild, family, number);
        }

        const pairs = (await this.collectPairs(guild)).live;
        const target = pairs.get(number) || {};

        // Never delete an occupied pair.
        if (pairMemberCount(target) > 0) return false;

        const otherPairs = Array.from(pairs.entries())
            .filter(([otherNumber]) => otherNumber !== number)
            .map(([, pair]) => pair);

        const anotherPairIsOccupied = otherPairs.some(pair => pairMemberCount(pair) > 0);
        const anotherCompleteSpareExists = otherPairs.some(isCompleteEmptyPair);

        // If another LIVE/Waiting pair is in use, one complete empty pair must always
        // remain available. Protect this pair when it is the only spare.
        if (isCompleteEmptyPair(target) && anotherPairIsOccupied && !anotherCompleteSpareExists) {
            this.logger?.log?.(`[voice-pairs] Keeping LIVE ${number} as the required spare pair.`);
            return false;
        }

        return originalDeletePairIfEmpty.call(this, guild, family, number);
    };
}

installLiveSpareCleanupGuard();

module.exports = {
    installLiveSpareCleanupGuard,
};
