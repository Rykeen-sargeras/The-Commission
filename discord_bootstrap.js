'use strict';

const { patchDiscordClient } = require('./going_live');
patchDiscordClient();
require('./discord_bot.js');
