'use strict';

const Discord = require('discord.js');
const { installProtectedBanBootstrap } = require('./protected_bans');
const { installHigherLowerTiePatch } = require('./economy_hilo_tie_patch');
const { installApprenticeVoiceRemovalPatch } = require('./apprentice_voice_removal_patch');

installProtectedBanBootstrap(Discord);
installHigherLowerTiePatch();
installApprenticeVoiceRemovalPatch();

const { installSpecialEconomyEvents } = require('./economy_special_events');
const { installHeistEnhancements } = require('./economy_heist_enhancements');
const { installHeistPersistencePatch } = require('./economy_heist_persistence_patch');
const { installFourDailyHeists } = require('./economy_heist_four_daily_patch');
const { installHeistGoonsPatch } = require('./economy_heist_goons_patch');
const { installHeistStoreHotTipPatch } = require('./economy_heist_store_hot_tip_patch');
const { installHeistSignupRoleplayPatch } = require('./economy_heist_signup_roleplay_patch');
const { installLeaderboardGuard } = require('./economy_leaderboard_guard');
const { installLuckRebalancePatch } = require('./economy_luck_rebalance_patch');
const { installStoreSingletonPatch } = require('./economy_store_singleton_patch');
const { installStoreCanonicalGuard } = require('./economy_store_canonical_guard');

installSpecialEconomyEvents();
installHeistEnhancements();
installHeistPersistencePatch();
installFourDailyHeists();
installHeistGoonsPatch();
installHeistStoreHotTipPatch();
installHeistSignupRoleplayPatch();
installLeaderboardGuard();
installLuckRebalancePatch();
installStoreSingletonPatch();
installStoreCanonicalGuard();
require('./discord_bot.js');
