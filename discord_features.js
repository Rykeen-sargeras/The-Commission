'use strict';

const { installChannelPermissionSafety } = require('./channel_permission_safety');
const goingLive = require('./going_live');
const { installGuard } = require('./going_live_command_guard');
const { installPermissionsBridge } = require('./permissions_bridge');
const { installOpenPanel } = require('./open_panel_preload');
const { installConfiguredRolePermissionSync } = require('./youtube_role_permissions');
const { installDMTicketSystem } = require('./dm_ticket_system');
const { installMembershipDiscord } = require('./membership_discord');

function installDiscordFeatures(client) {
    if (!client) throw new TypeError('A Discord client is required.');

    // Must be installed first. All later features may inspect channel permissions,
    // but mutation attempts against existing channels are blocked globally.
    installChannelPermissionSafety(client);

    goingLive.install(client);
    installGuard(client);
    installPermissionsBridge(client);
    installOpenPanel(client);
    installConfiguredRolePermissionSync(client);
    installDMTicketSystem(client);
    if (typeof client.on === 'function' && typeof client.once === 'function') installMembershipDiscord(client);
    return client;
}

module.exports = { installDiscordFeatures };
