'use strict';

const Discord = require('discord.js');
const { installProtectedBanBootstrap } = require('./protected_bans');
const { installHigherLowerTiePatch } = require('./economy_hilo_tie_patch');

installProtectedBanBootstrap(Discord);
installHigherLowerTiePatch();

const { installSpecialEconomyEvents } = require('./economy_special_events');
const { installHeistEnhancements } = require('./economy_heist_enhancements');

installSpecialEconomyEvents();
installHeistEnhancements();
require('./discord_bot.js');
