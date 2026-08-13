'use strict';

const { patchDiscordClient } = require('./going_live');
const { installGuard } = require('./going_live_command_guard');

patchDiscordClient();
installGuard();
require('./economy_balance_patch');
require('./economy_luck_store_patch');
require('./discord_bot.js');
