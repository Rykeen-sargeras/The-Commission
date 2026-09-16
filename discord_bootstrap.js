'use strict';

const Discord = require('discord.js');
const { installProtectedBanBootstrap } = require('./protected_bans');
const { installSpecialEconomyEvents } = require('./economy_special_events');
const { installHeistEnhancements } = require('./economy_heist_enhancements');

installProtectedBanBootstrap(Discord);
installSpecialEconomyEvents();
installHeistEnhancements();
require('./discord_bot.js');
