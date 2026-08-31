'use strict';

const assert = require('assert');
const Module = require('module');

const calls = [];
const installers = new Map([
    ['./going_live', { install: client => calls.push(['going-live', client]) }],
    ['./going_live_command_guard', { installGuard: client => calls.push(['going-live-guard', client]) }],
    ['./permissions_bridge', { installPermissionsBridge: client => calls.push(['permissions-bridge', client]) }],
    ['./open_panel_preload', { installOpenPanel: client => calls.push(['open-panel', client]) }],
    ['./youtube_role_permissions', { installConfiguredRolePermissionSync: client => calls.push(['role-permissions', client]) }],
    ['./dm_ticket_system', { installDMTicketSystem: client => calls.push(['dm-tickets', client]) }],
]);

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (parent?.filename?.endsWith('discord_features.js') && installers.has(request)) return installers.get(request);
    return originalLoad.call(this, request, parent, isMain);
};
const { installDiscordFeatures } = require('../discord_features');
Module._load = originalLoad;

const client = {};
assert.strictEqual(installDiscordFeatures(client), client);
assert.deepStrictEqual(calls.map(([name]) => name), [
    'going-live',
    'going-live-guard',
    'permissions-bridge',
    'open-panel',
    'role-permissions',
    'dm-tickets',
]);
assert.ok(calls.every(([, installedClient]) => installedClient === client));
assert.throws(() => installDiscordFeatures(null), /Discord client is required/);

console.log('discord feature manager tests passed');
