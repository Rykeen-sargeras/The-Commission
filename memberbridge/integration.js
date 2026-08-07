'use strict';

const fs = require('fs');
const path = require('path');

/**
 * MemberBridge has been retired from The Commission.
 *
 * Membership verification now lives in the standalone Safetybot service.
 * This compatibility module remains only so older Commission code can load
 * without crashing while all MemberBridge commands, web callbacks, OAuth,
 * synchronization, role handling, and background jobs stay disabled.
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

function memberBridgeCommandData() {
    // Returning no commands also removes the old membership commands the next
    // time The Commission refreshes its Discord application command list.
    return [];
}

class MemberBridgeIntegration {
    constructor(_client, options = {}) {
        this.retired = true;
        purgeLegacyVerificationData(options.dataDir);
    }

    async start() {
        console.log('[MemberBridge retired] Membership verification is disabled in The Commission. Use Safetybot instead.');
    }

    async stop() {}

    async handleButton() {
        return false;
    }

    async handleCommand() {
        return false;
    }

    async admin() {
        throw new Error('MemberBridge has been retired from The Commission. Membership verification is handled by Safetybot.');
    }
}

module.exports = {
    MemberBridgeIntegration,
    memberBridgeCommandData,
    purgeLegacyVerificationData,
};
