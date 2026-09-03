'use strict';

const BASE_FIELDS = [
  ['DISCORD_TOKEN','Discord bot token','password','Connection'],
  ['CLIPPER_PASSWORD','Clipper shared password','password','Connection'],
  ['OWNER_USER_ID','Owner user ID','text','Connection'],
  ['STAFF_ROLE_IDS','Staff role IDs','text','Connection'],
  ['MAIN_CHAT_CHANNEL_ID','Main chat channel ID','text','Channels'],
  ['ANNOUNCEMENT_CHANNEL_ID','Announcement channel ID','text','Channels'],
  ['MOD_CHANNEL_ID','Moderator channel ID','text','Channels'],
  ['LOG_CHANNEL_ID','Audit log channel ID','text','Channels'],
  ['TICKET_CATEGORY_ID','Ticket category ID','text','Channels'],
  ['PATROL_CHANNEL_ID','Patrol / self-promo channel ID','text','Channels'],
  ['MUSIC_CHANNEL_ID','Music request channel ID','text','Channels'],
  ['MUSIC_VOICE_CHANNEL_ID','Music voice channel ID','text','Channels'],
  ['REPORT_CATEGORY_ID','Report category ID','text','Cases'],
  ['OLD_REPORTS_CHANNEL_ID','Closed reports channel ID','text','Cases'],
  ['JAIL_CATEGORY_IDS','Categories hidden while jailed','text','Protection'],
  ['JAIL_CATEGORY_ID','Jail room category ID','text','Protection'],
  ['JAIL_ROLE_ID','Jail role ID','text','Protection'],
  ['JAIL_LOG_CHANNEL_ID','Jail log channel ID','text','Protection'],
  ['PREEMPTIVE_BAN_USER_IDS','Preemptive ban user IDs','textarea','Protection'],
  ['PREEMPTIVE_BAN_REASON','Preemptive ban reason','text','Protection'],
  ['ALT_DETECTION_ENABLED','Enable alt detection','checkbox','Protection'],
  ['ALT_ACCOUNT_AGE_DAYS','New-account threshold (days)','number','Protection'],
  ['LOCATIONIQ_API_KEY','LocationIQ API key','password','API Services'],
  ['POSITIONSTACK_API_KEY','Positionstack API key','password','API Services'],
];

const ECON_FIELDS = [
  ['enabled','Enable Blood Money','checkbox'],['currencyName','Currency name','text'],['auditChannelId','Economy audit channel ID','text'],['archiveChannelId','Monthly archive channel ID','text'],['leaderboardChannelId','Leaderboard channel ID','text'],['heistChannelId','Heist channel ID','text'],['gamblingChannelId','Gambling channel ID','text'],
  ['excludedChannelIds','Excluded text channel IDs','text'],['mediaChannelIds','Media reward channel IDs','text'],['excludedVoiceChannelIds','Excluded voice channel IDs','text'],['excludedLeaderboardUserIds','Excluded leaderboard user IDs','text'],
  ['messageChance','Message reward chance %','number'],['messageRewardMin','Message reward min','number'],['messageRewardMax','Message reward max','number'],['messageCooldownSeconds','Message cooldown seconds','number'],['messageDailyCap','Message daily cap','number'],['messageHourlyLimit','Message hourly limit','number'],
  ['mediaRewardMin','Media reward min','number'],['mediaRewardMax','Media reward max','number'],['mediaCooldownMinutes','Media cooldown minutes','number'],['mediaDailyCap','Media daily cap','number'],['mediaDailyPosts','Media rewarded posts/day','number'],
  ['voiceRewardMin','Voice reward min','number'],['voiceRewardMax','Voice reward max','number'],['voiceIntervalMinutes','Voice interval minutes','number'],['voiceDailyCap','Voice daily cap','number'],['minimumAccountAgeDays','Minimum account age days','number'],
  ['dailyBase','Daily base reward','number'],['dailyStreakStep','Daily streak step','number'],['dailyStreakMaximum','Daily streak maximum','number'],['gamblingEnabled','Enable gambling','checkbox'],
  ['blackjackMinimumWager','Blackjack minimum','number'],['pokerMinimumWager','Poker minimum','number'],
  ['prizeMonths','Prize months','text'],['minimumTransfer','Minimum transfer','number'],['transferLimitPercent','Transfer limit %','number'],['minimumMembershipDays','Minimum membership days','number'],['resetHour','Monthly reset hour','number'],['timeZone','Economy timezone','text'],['pokerTimeoutBehavior','Poker timeout behavior','text'],
  ['heistEntryFee','Heist entry fee','number'],['heistFreeSuccessReward','Heist success reward','number'],['heistEntryMinutes','Heist entry minutes','number'],['heistCooldownMinutes','Heist cooldown minutes','number'],['heistMinimumPlayers','Heist minimum players','number'],['heistBaseSuccessChance','Heist base success %','number'],['heistChancePerExtraPlayer','Heist chance per extra player %','number'],['heistMaximumSuccessChance','Heist max success %','number'],['heistPayoutMultiplier','Heist payout multiplier','number']
];

module.exports = { BASE_FIELDS, ECON_FIELDS };
