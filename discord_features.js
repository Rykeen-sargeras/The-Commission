'use strict';

const { installChannelPermissionSafety } = require('./channel_permission_safety');
const goingLive = require('./going_live');
const { installGuard } = require('./going_live_command_guard');
const { installPermissionsBridge } = require('./permissions_bridge');
const { installOpenPanel } = require('./open_panel_preload');
const { installDMTicketSystem } = require('./dm_ticket_system');
const { installMembershipDiscord } = require('./membership_discord');

function installDiscordFeatures(client) {
    if (!client) throw new TypeError('A Discord client is required.');

    // Install first so existing channel permissions stay authoritative. The old
    // configured-role permission synchronizer is intentionally NOT installed: it
    // fetched every role/channel and retried on every role/channel event, but all
    // of those writes are now blocked by the safety layer anyway. Removing that
    // background worker avoids unnecessary REST calls and event-loop churn.
    installChannelPermissionSafety(client);

    goingLive.install(client);
    installGuard(client);
    installPermissionsBridge(client);
    installOpenPanel(client);
    installDMTicketSystem(client);
    if (typeof client.on === 'function' && typeof client.once === 'function') installMembershipDiscord(client);
    return client;
}

module.exports = { installDiscordFeatures };
