'use strict';

const { patchDiscordClient } = require('./going_live');
const { installGuard } = require('./going_live_command_guard');

patchDiscordClient();
installGuard();
require('./discord_bot.js');
