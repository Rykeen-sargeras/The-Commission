'use strict';

const { patchDiscordClient } = require('./going_live');
const { installGuard } = require('./going_live_command_guard');

patchDiscordClient();
installGuard();
require('./economy_balance_patch');
require('./economy_ui_clean_patch');
require('./economy_luck_store_patch');
require('./economy_luck_rng_fix');
require('./economy_luck_panel_patch');
require('./permissions_bridge');
require('./open_panel_preload');
require('./youtube_role_permissions');
require('./dm_ticket_system');
require('./discord_bot.js');


