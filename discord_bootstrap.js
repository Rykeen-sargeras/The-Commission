'use strict';

const Discord = require('discord.js');
const { installProtectedBanBootstrap } = require('./protected_bans');
const { installSpecialEconomyEvents } = require('./economy_special_events');

installProtectedBanBootstrap(Discord);
installSpecialEconomyEvents();
require('./discord_bot.js');

