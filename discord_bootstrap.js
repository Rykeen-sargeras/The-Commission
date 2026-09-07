'use strict';

const Discord = require('discord.js');
const { installProtectedBanBootstrap } = require('./protected_bans');

installProtectedBanBootstrap(Discord);
require('./discord_bot.js');

