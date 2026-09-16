'use strict';

const Discord = require('discord.js');
const { installProtectedBanBootstrap } = require('./protected_bans');
const { installHigherLowerTiePatch } = require('./economy_hilo_tie_patch');

installProtectedBanBootstrap(Discord);
installHigherLowerTiePatch();

const { installSpecialEconomyEvents } = require('./economy_special_events');
const { installHeistEnhancements } = require('./economy_heist_enhancements');
const { installHeistPersistencePatch } = require('./economy_heist_persistence_patch');
const { installHeistPingIntervalPatch } = require('./economy_heist_ping_interval_patch');
const { installLeaderboardGuard } = require('./economy_leaderboard_guard');

installSpecialEconomyEvents();
installHeistEnhancements();
installHeistPersistencePatch();
installHeistPingIntervalPatch();
installLeaderboardGuard();
require('./discord_bot.js');
