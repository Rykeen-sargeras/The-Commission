'use strict';

const goingLive = require('./going_live');
const { installGuard } = require('./going_live_command_guard');
const { installPermissionsBridge } = require('./permissions_bridge');
const { installOpenPanel } = require('./open_panel_preload');
const { installConfiguredRolePermissionSync } = require('./youtube_role_permissions');
const { installDMTicketSystem } = require('./dm_ticket_system');

function installDiscordFeatures(client) {
    if (!client) throw new TypeError('A Discord client is required.');

    goingLive.install(client);
    installGuard(client);
    installPermissionsBridge(client);
    installOpenPanel(client);
    installConfiguredRolePermissionSync(client);
    installDMTicketSystem(client);
    return client;
}

module.exports = { installDiscordFeatures };
