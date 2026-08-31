'use strict';

function loadDiscordConfig(environment = process.env) {
    return {
        MAIN_CHAT_CHANNEL_ID: environment.MAIN_CHAT_CHANNEL_ID || '',
        ANNOUNCEMENT_CHANNEL_ID: environment.ANNOUNCEMENT_CHANNEL_ID || '',
        MOD_CHANNEL_ID: environment.MOD_CHANNEL_ID || '1532529016479682774',
        LOG_CHANNEL_ID: environment.LOG_CHANNEL_ID || '',
        TICKET_CATEGORY_ID: environment.TICKET_CATEGORY_ID || '',
        STAFF_ROLE_IDS: (environment.STAFF_ROLE_IDS || '').split(',').filter(Boolean),
        OWNER_USER_ID: environment.OWNER_USER_ID || '',
        WEB_DASHBOARD_PASSWORD: environment.WEB_DASHBOARD_PASSWORD || '',
        ALT_DETECTION_ENABLED: environment.ALT_DETECTION_ENABLED !== 'false',
        ALT_ACCOUNT_AGE_DAYS: parseInt(environment.ALT_ACCOUNT_AGE_DAYS || '14'),
        PATROL_CHANNEL_ID: environment.PATROL_CHANNEL_ID || '',
        LOCATIONIQ_API_KEY: environment.LOCATIONIQ_API_KEY || '',
        POSITIONSTACK_API_KEY: environment.POSITIONSTACK_API_KEY || '',
        MUSIC_CHANNEL_ID: environment.MUSIC_CHANNEL_ID || '',
        MUSIC_VOICE_CHANNEL_ID: environment.MUSIC_VOICE_CHANNEL_ID || '',
        REPORT_CATEGORY_ID: environment.REPORT_CATEGORY_ID || '',
        OLD_REPORTS_CHANNEL_ID: environment.OLD_REPORTS_CHANNEL_ID || '',
        JAIL_CATEGORY_IDS: (environment.JAIL_CATEGORY_IDS || '').split(',').filter(Boolean),
        JAIL_CATEGORY_ID: environment.JAIL_CATEGORY_ID || '',
        JAIL_ROLE_ID: environment.JAIL_ROLE_ID || '',
        JAIL_LOG_CHANNEL_ID: environment.JAIL_LOG_CHANNEL_ID || '',
        PREEMPTIVE_BAN_USER_IDS: (environment.PREEMPTIVE_BAN_USER_IDS || '').split(/[\s,]+/).filter(Boolean),
        PREEMPTIVE_BAN_REASON: environment.PREEMPTIVE_BAN_REASON || 'Listed in The Commission preemptive ban list',
        LIVE_VOICE_CATEGORY_ID: environment.LIVE_VOICE_CATEGORY_ID || '1532513765701189683',
    };
}

module.exports = { loadDiscordConfig };
