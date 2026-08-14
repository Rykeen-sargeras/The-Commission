const Discord = require('discord.js');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { applyGuildBlueprint, captureGuildBlueprint } = require('./blueprint');
const { EconomyService } = require('./economy');
const { economyCommandData, createEconomyIntegration } = require('./economy_discord');
const { isDoxWord } = require('./moderation_word_policy');
const { MemberBridgeIntegration, memberBridgeCommandData } = require('./memberbridge/integration');
const goingLive = require('./going_live');
const { installLiveVoicePairs } = require('./live_voice_pairs');

// Music dependencies
// play-dl is used for YouTube searching/metadata.
// @distube/ytdl-core is used for the actual audio stream because play-dl.stream()
// can return ERR_INVALID_URL/input undefined on some Railway/YouTube results.
let voice, playDl, ytdl;
try {
    voice = require('@discordjs/voice');
    playDl = require('play-dl');
    ytdl = require('@distube/ytdl-core');
    console.log('âœ… Music dependencies loaded');
} catch (e) {
    console.warn('âš ï¸ Music dependencies not installed. Run: npm install @discordjs/voice play-dl @distube/ytdl-core libsodium-wrappers ffmpeg-static');
    console.warn(e.message);
}

const client = new Discord.Client({
    intents: [
        Discord.GatewayIntentBits.Guilds,
        Discord.GatewayIntentBits.GuildMembers,
        Discord.GatewayIntentBits.GuildVoiceStates,
        Discord.GatewayIntentBits.DirectMessages,
        Discord.GatewayIntentBits.DirectMessageReactions,
        Discord.GatewayIntentBits.DirectMessageTyping,
        Discord.GatewayIntentBits.MessageContent,
        Discord.GatewayIntentBits.GuildMessages,
    ],
    partials: [
        Discord.Partials.Channel,
        Discord.Partials.Message,
        Discord.Partials.User,
        Discord.Partials.GuildMember,
    ]
});
goingLive.install(client);

// Configuration - supplied by Railway or the Windows control panel.
const CONFIG = {
    MAIN_CHAT_CHANNEL_ID: process.env.MAIN_CHAT_CHANNEL_ID || '',
    ANNOUNCEMENT_CHANNEL_ID: process.env.ANNOUNCEMENT_CHANNEL_ID || '',
    MOD_CHANNEL_ID: process.env.MOD_CHANNEL_ID || '',
    LOG_CHANNEL_ID: process.env.LOG_CHANNEL_ID || '',
    TICKET_CATEGORY_ID: process.env.TICKET_CATEGORY_ID || '',
    STAFF_ROLE_IDS: (process.env.STAFF_ROLE_IDS || '').split(',').filter(Boolean),
    OWNER_USER_ID: process.env.OWNER_USER_ID || '',
    WEB_DASHBOARD_PASSWORD: process.env.WEB_DASHBOARD_PASSWORD || '',
    ALT_DETECTION_ENABLED: process.env.ALT_DETECTION_ENABLED !== 'false', // Default enabled
    ALT_ACCOUNT_AGE_DAYS: parseInt(process.env.ALT_ACCOUNT_AGE_DAYS || '7'), // Flag accounts newer than 7 days
    PATROL_CHANNEL_ID: process.env.PATROL_CHANNEL_ID || '',
    LOCATIONIQ_API_KEY: process.env.LOCATIONIQ_API_KEY || '',
    POSITIONSTACK_API_KEY: process.env.POSITIONSTACK_API_KEY || '',
    MUSIC_CHANNEL_ID: process.env.MUSIC_CHANNEL_ID || '',
    MUSIC_VOICE_CHANNEL_ID: process.env.MUSIC_VOICE_CHANNEL_ID || '',
    REPORT_CATEGORY_ID: process.env.REPORT_CATEGORY_ID || '',
    OLD_REPORTS_CHANNEL_ID: process.env.OLD_REPORTS_CHANNEL_ID || '',
    JAIL_CATEGORY_IDS: (process.env.JAIL_CATEGORY_IDS || '').split(',').filter(Boolean),
    JAIL_CATEGORY_ID: process.env.JAIL_CATEGORY_ID || '',
    JAIL_ROLE_ID: process.env.JAIL_ROLE_ID || '',
    JAIL_LOG_CHANNEL_ID: process.env.JAIL_LOG_CHANNEL_ID || '',
    PREEMPTIVE_BAN_USER_IDS: (process.env.PREEMPTIVE_BAN_USER_IDS || '').split(/[\s,]+/).filter(Boolean),
    PREEMPTIVE_BAN_REASON: process.env.PREEMPTIVE_BAN_REASON || 'Listed in The Commission preemptive ban list',
    LIVE_VOICE_CATEGORY_ID: process.env.LIVE_VOICE_CATEGORY_ID || '1532513765701189683',
};

const PREEMPTIVE_BAN_USER_IDS = new Set(CONFIG.PREEMPTIVE_BAN_USER_IDS);
installLiveVoicePairs(client, { categoryId: CONFIG.LIVE_VOICE_CATEGORY_ID });

// Music channel configuration
const MUSIC_CHANNEL_ID = CONFIG.MUSIC_CHANNEL_ID;
const MUSIC_VOICE_CHANNEL_ID = CONFIG.MUSIC_VOICE_CHANNEL_ID;

const STAFF_CHANNEL_PERMISSIONS = [
    Discord.PermissionFlagsBits.ViewChannel,
    Discord.PermissionFlagsBits.SendMessages,
    Discord.PermissionFlagsBits.ReadMessageHistory,
];

function staffPermissionOverwrites() {
    return CONFIG.STAFF_ROLE_IDS.map(id => ({
        id,
        allow: STAFF_CHANNEL_PERMISSIONS,
    }));
}

function staffMentions(extraUserId = '') {
    const mentions = [];
    if (CONFIG.OWNER_USER_ID) mentions.push(`<@${CONFIG.OWNER_USER_ID}>`);
    mentions.push(...CONFIG.STAFF_ROLE_IDS.map(id => `<@&${id}>`));
    if (extraUserId) mentions.push(`<@${extraUserId}>`);
    return mentions.join(' ');
}

// Patrol channel tracking
const patrolCooldowns = new Map(); // userId -> lastPostTimestamp
const PATROL_COOLDOWN = 16 * 60 * 60 * 1000; // 16 hours in milliseconds

// ======================
// BANNED WORDS AUTO-JAIL SYSTEM
// ======================

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const BANNED_WORDS_FILE = path.join(DATA_DIR, 'banned-words.json');
let economyConfig = {};
try {
    economyConfig = JSON.parse(process.env.ECONOMY_CONFIG_JSON || '{}');
} catch (error) {
    console.error('Invalid economy configuration; using safe defaults:', error.message);
}
const economy = new EconomyService({ dataDir: DATA_DIR, config: economyConfig });
const economyIntegration = createEconomyIntegration(client, economy, {
    auditChannelId: economyConfig.auditChannelId,
    ownerUserId: CONFIG.OWNER_USER_ID,
    staffRoleIds: CONFIG.STAFF_ROLE_IDS,
});
let memberBridgeConfig = {};
try {
    memberBridgeConfig = JSON.parse(process.env.MEMBERBRIDGE_CONFIG_JSON || '{}');
} catch (error) {
    console.error('Invalid MemberBridge configuration; the feature will stay disabled:', error.message);
}
const RAILWAY_MODE = Boolean(
    process.env.RAILWAY_ENVIRONMENT_ID
    || process.env.COMMISSION_RAILWAY_MODE === 'true'
    || process.env.COMMISSION_RAILWAY_MODE === '1'
);
if (RAILWAY_MODE) {
    memberBridgeConfig.callbackHost = '0.0.0.0';
    memberBridgeConfig.callbackPort = Number(process.env.PORT || memberBridgeConfig.callbackPort || 17842);
    if (process.env.RAILWAY_PUBLIC_DOMAIN) {
        memberBridgeConfig.publicBaseUrl = `https://${String(process.env.RAILWAY_PUBLIC_DOMAIN).replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
    }
}
const memberBridgeEncryptionKey = process.env.MEMBERBRIDGE_ENCRYPTION_KEY
    || require('crypto').createHash('sha256').update(process.env.DISCORD_TOKEN || 'memberbridge-development-only').digest('base64');
const memberBridgeIntegration = new MemberBridgeIntegration(client, {
    dataDir: DATA_DIR,
    encryptionKey: memberBridgeEncryptionKey,
    googleClientSecret: process.env.MEMBERBRIDGE_GOOGLE_CLIENT_SECRET || '',
    discordClientSecret: process.env.MEMBERBRIDGE_DISCORD_CLIENT_SECRET || '',
    ownerPassword: CONFIG.WEB_DASHBOARD_PASSWORD,
    config: memberBridgeConfig,
});

// Offense tracking: userId -> count of offenses
let offenseTracker = new Map();

// Default banned words list
const DEFAULT_BANNED_WORDS = [
    'dox', 'doxx', 'doxxing', 'doxing', 'doxed', 'doxxed', 'doxer', 'doxxer', 'doxxers',
    'swat', 'swatting', 'swatted',
    'kill your self', 'kill youre self', "kill you're self", 'kill yourself',
    'suicide', 'suicidebait', 'suicide bait',
    'nigga', 'nigger', 'niggas', 'niggers', "nigger's", "nigga's",
    'spic', 'spick', 'spics',
    'wetback', 'wetbacks',
    'chink', 'chinks',
    'gook', 'gooks',
    'kike', 'kikes',
    'beaner', 'beaners',
    'coon', 'coons',
    'darkie', 'darkies',
    'jigaboo', 'jiggaboo',
    'porchmonkey', 'porch monkey',
    'raghead', 'ragheads',
    'sandnigger', 'sand nigger',
    'towelhead', 'towelheads',
    'zipperhead', 'zipperheads',
    'cracker', 'crackers',
    'honky', 'honkey', 'honkies',
    'gringo', 'gringos',
    'redskin', 'redskins',
    'squaw',
    'camel jockey',
    'chinaman',
    'slant eye', 'slanteye',
    'yellowskin',
];

// Banned words list (editable via dashboard, persisted to disk)
let bannedWords = [...DEFAULT_BANNED_WORDS];

// Load banned words from disk
function loadBannedWordsFromDisk() {
    try {
        if (fs.existsSync(BANNED_WORDS_FILE)) {
            const raw = fs.readFileSync(BANNED_WORDS_FILE, 'utf-8');
            const data = JSON.parse(raw);
            if (data.bannedWords && Array.isArray(data.bannedWords)) {
                bannedWords = data.bannedWords;
            }
            if (data.offenses) {
                offenseTracker = new Map(Object.entries(data.offenses));
            }
            console.log(`âœ… Loaded banned words from disk: ${bannedWords.length} words, ${offenseTracker.size} offenders`);
        }
    } catch (error) {
        console.error('âŒ Error loading banned words from disk:', error);
    }
}

let saveBannedTimer = null;
function saveBannedWordsToDisk() {
    if (saveBannedTimer) return;
    saveBannedTimer = setTimeout(() => {
        saveBannedTimer = null;
        try {
            const data = {
                bannedWords: bannedWords,
                offenses: Object.fromEntries(offenseTracker),
                lastSaved: new Date().toISOString(),
            };
            fs.writeFileSync(BANNED_WORDS_FILE, JSON.stringify(data), 'utf-8');
        } catch (error) {
            console.error('âŒ Error saving banned words to disk:', error);
        }
    }, 2000);
}

loadBannedWordsFromDisk();

// Fun features state
let triviaEnabled = false;
let triviaInterval = null;
let currentTrivia = null;
const triviaScores = new Map(); // userId -> score

// Birthday system
const birthdays = new Map(); // userId -> { month: 1-12, day: 1-31, username: string }
let birthdayCheckInterval = null;

// Message tracking for vibe check
const recentMessages = []; // { timestamp, userId, content, sentiment }
const MAX_MESSAGE_HISTORY = 1000;

// Trivia questions database (250 questions)
const triviaQuestions = [
    // General Knowledge (50)
    { question: "What year was Discord founded?", answer: "2015", category: "Discord" },
    { question: "What is the capital of Japan?", answer: "Tokyo", category: "Geography" },
    { question: "How many players are on a soccer team?", answer: "11", category: "Sports" },
    { question: "What is the largest planet in our solar system?", answer: "Jupiter", category: "Science" },
    { question: "Who painted the Mona Lisa?", answer: "Leonardo da Vinci", category: "Art" },
    { question: "What is the smallest country in the world?", answer: "Vatican City", category: "Geography" },
    { question: "In what year did World War II end?", answer: "1945", category: "History" },
    { question: "What is the speed of light in km/s?", answer: "300000", category: "Science" },
    { question: "What is the most popular programming language in 2024?", answer: "Python", category: "Tech" },
    { question: "How many continents are there?", answer: "7", category: "Geography" },
    { question: "What is the chemical symbol for gold?", answer: "Au", category: "Science" },
    { question: "Who wrote Romeo and Juliet?", answer: "Shakespeare", category: "Literature" },
    { question: "What is the tallest mountain in the world?", answer: "Mount Everest", category: "Geography" },
    { question: "How many bones are in the human body?", answer: "206", category: "Science" },
    { question: "What is the largest ocean on Earth?", answer: "Pacific", category: "Geography" },
    { question: "In what year was the first iPhone released?", answer: "2007", category: "Tech" },
    { question: "What planet is known as the Red Planet?", answer: "Mars", category: "Science" },
    { question: "How many strings does a guitar typically have?", answer: "6", category: "Music" },
    { question: "What is the hardest natural substance on Earth?", answer: "Diamond", category: "Science" },
    { question: "Who was the first person to walk on the moon?", answer: "Neil Armstrong", category: "History" },
    { question: "What is the capital of France?", answer: "Paris", category: "Geography" },
    { question: "How many sides does a hexagon have?", answer: "6", category: "Math" },
    { question: "What is the largest mammal on Earth?", answer: "Blue Whale", category: "Animals" },
    { question: "In what year did the Titanic sink?", answer: "1912", category: "History" },
    { question: "What is the boiling point of water in Celsius?", answer: "100", category: "Science" },
    { question: "Who invented the telephone?", answer: "Alexander Graham Bell", category: "History" },
    { question: "What is the capital of Australia?", answer: "Canberra", category: "Geography" },
    { question: "How many days are in a leap year?", answer: "366", category: "General" },
    { question: "What is the chemical symbol for water?", answer: "H2O", category: "Science" },
    { question: "Who wrote Harry Potter?", answer: "J.K. Rowling", category: "Literature" },
    { question: "What is the smallest planet in our solar system?", answer: "Mercury", category: "Science" },
    { question: "How many keys are on a standard piano?", answer: "88", category: "Music" },
    { question: "What is the longest river in the world?", answer: "Nile", category: "Geography" },
    { question: "In what year did humans first land on the moon?", answer: "1969", category: "History" },
    { question: "What is the freezing point of water in Fahrenheit?", answer: "32", category: "Science" },
    { question: "Who painted the Sistine Chapel?", answer: "Michelangelo", category: "Art" },
    { question: "What is the capital of Canada?", answer: "Ottawa", category: "Geography" },
    { question: "How many hours are in a week?", answer: "168", category: "Math" },
    { question: "What gas do plants absorb from the atmosphere?", answer: "Carbon Dioxide", category: "Science" },
    { question: "Who discovered penicillin?", answer: "Alexander Fleming", category: "Science" },
    { question: "What is the largest desert in the world?", answer: "Sahara", category: "Geography" },
    { question: "How many Olympic rings are there?", answer: "5", category: "Sports" },
    { question: "What is the capital of Italy?", answer: "Rome", category: "Geography" },
    { question: "In what year did World War I begin?", answer: "1914", category: "History" },
    { question: "What is the fastest land animal?", answer: "Cheetah", category: "Animals" },
    { question: "Who invented the light bulb?", answer: "Thomas Edison", category: "History" },
    { question: "What is the largest country by area?", answer: "Russia", category: "Geography" },
    { question: "How many teeth does an adult human have?", answer: "32", category: "Science" },
    { question: "What is the chemical symbol for oxygen?", answer: "O", category: "Science" },
    { question: "Who was the first President of the United States?", answer: "George Washington", category: "History" },

    // Pop Culture & Entertainment (50)
    { quë½:öÚ$z{-®éÜj×W2ÇÂ·Ò“°¢–b†öfdVçG&–W2æÆVæwF‚ÓÓÒ’°¢öfd6öçF–æW"æ–ææW$…DÔÂÒsÇ7G–ÆSÒ&6öÆ÷#¢f"‚Ò×FW‡BÖ×WFVB“²#äæòöffVç6W2&V6÷&FVCÂ÷âs°¢ÒVÇ6R°¢öfd6öçF–æW"æ–ææW$…DÔÂÒöfdVçG&–W2æÖ†gVæ7F–öâ†VçG'’’°¢f"V–BÒVçG'•³Ó°¢f"6÷VçBÒVçG'•³Ó°¢f"Æ&VÂÒ6÷VçBÓÓÒòsRÖ–â¦–Âr¢6÷VçBÓÓÒ"òs3Ö–â¦–Âr¢uW&ÖæVçB¦–Âs°¢&WGW&âsÆF—b7G–ÆSÒ&F—7Æ“¢fÆWƒ²§W7F–g’Ö6öçFVçC¢76RÖ&WGvVVã²Æ–vâÖ—FV×3¢6VçFW#²&6¶w&÷VæC¢f"‚ÒÖ&r×FW'F–'’“²FF–æs¢'ƒ²&÷&FW"×&F—W3¢‡ƒ²Ö&v–âÖ&÷GFöÓ¢‡ƒ²&÷&FW"ÖÆVgC¢7‚6öÆ–Bf"‚Ò×v&æ–ær“²#âr°¢sÆF—cãÇ7â7G–ÆSÒ&föçB×vV–v‡C¢c²#åW6W"”C¢r²V–B²sÂ÷7ããÆ'#ãÇ7â7G–ÆSÒ&6öÆ÷#¢f"‚Ò×FW‡B×6V6öæF'’“²föçB×6—¦S¢7ƒ²#äöffVç6W3¢r²6÷VçB²r‚r²Æ&VÂ²r“Â÷7ããÂöF—câr°¢sÆ'WGFöâöæ6Æ–6³Ò'&W6WDöffVç6W2…ÅÂrr²V–B²uÅÂr’"6Æ73Ò&'Fâ'Fâ×6V6öæF'’"7G–ÆSÒ'FF–æs¢g‚'ƒ²föçB×6—¦S¢'ƒ²#å&W6WCÂö'WGFöãâr°¢sÂöF—câs°¢Ò’æ¦ö–â‚rr“°¢Ğ¢Ò6F6‚†W'"’°¢6öç6öÆRæW'&÷"‚tW'&÷"ÆöF–ær&ææVBv÷&G3¢rÂW'"“°¢Ğ¢Ğ ¢7–æ2gVæ7F–öâFD&ææVEv÷&B‚’°¢f"v÷&BÒFö7VÖVçBævWDVÆVÖVçD'”–B‚væWuv÷&Br’çfÇVRçG&–Ò‚“°¢–b‚v÷&B’&WGW&â6†÷tÆW'B‚wv÷&G4ÆW'BrÂtVçFW"v÷&B÷"‡&6RrÂvW'&÷"r“°¢G'’°¢f"&W2Òv—BfWF6‚‚rö’ö&ææVB×v÷&G2rÂ°¢ÖWF†öC¢uõ5BrÀ¢†VFW'3¢²t6öçFVçBÕG—Rs¢vÆ–6F–öâö§6öârÒÀ¢&öG“¢¥4ôâç7G&–æv–g’‡²77v÷&C¢77v÷&BÂ7F–öã¢vFBrÂv÷&C¢v÷&BÒ¢Ò“°¢f"FFÒv—B&W2æ§6öâ‚“°¢–b†FFç7V66W72’°¢6†÷tÆW'B‚wv÷&G4ÆW'BrÂtFFVC¢r²v÷&BÂw7V66W72r“°¢Fö7VÖVçBævWDVÆVÖVçD'”–B‚væWuv÷&Br’çfÇVRÒrs°¢ÆöD&ææVEv÷&G2‚“°¢ÒVÇ6R°¢6†÷tÆW'B‚wv÷&G4ÆW'BrÂFFæW'&÷"ÂvW'&÷"r“°¢Ğ¢Ò6F6‚†W'"’°¢6†÷tÆW'B‚wv÷&G4ÆW'BrÂtW'&÷#¢r²W'"æÖW76vRÂvW'&÷"r“°¢Ğ¢Ğ ¢7–æ2gVæ7F–öâ&VÖ÷fT&ææVEv÷&B‡v÷&B’°¢G'’°¢f"&W2Òv—BfWF6‚‚rö’ö&ææVB×v÷&G2rÂ°¢ÖWF†öC¢uõ5BrÀ¢†VFW'3¢²t6öçFVçBÕG—Rs¢vÆ–6F–öâö§6öârÒÀ¢&öG“¢¥4ôâç7G&–æv–g’‡²77v÷&C¢77v÷&BÂ7F–öã¢w&VÖ÷fRrÂv÷&C¢v÷&BÒ¢Ò“°¢f"FFÒv—B&W2æ§6öâ‚“°¢–b†FFç7V66W72’°¢6†÷tÆW'B‚wv÷&G4ÆW'BrÂu&VÖ÷fVC¢r²v÷&BÂw7V66W72r“°¢ÆöD&ææVEv÷&G2‚“°¢Ğ¢Ò6F6‚†W'"’°¢6†÷tÆW'B‚wv÷&G4ÆW'BrÂtW'&÷#¢r²W'"æÖW76vRÂvW'&÷"r“°¢Ğ¢Ğ ¢7–æ2gVæ7F–öâ&W6WDöffVç6W2‡W6W$–B’°¢G'’°¢f"&W2Òv—BfWF6‚‚rö’ö&ææVB×v÷&G2rÂ°¢ÖWF†öC¢uõ5BrÀ¢†VFW'3¢²t6öçFVçBÕG—Rs¢vÆ–6F–öâö§6öârÒÀ¢&öG“¢¥4ôâç7G&–æv–g’‡²77v÷&C¢77v÷&BÂ7F–öã¢w&W6WBÖöffVç6W2rÂW6W$–C¢W6W$–BÒ¢Ò“°¢f"FFÒv—B&W2æ§6öâ‚“°¢–b†FFç7V66W72’°¢6†÷tÆW'B‚wv÷&G4ÆW'BrÂtöffVç6W2&W6WBf÷"r²W6W$–BÂw7V66W72r“°¢ÆöD&ææVEv÷&G2‚“°¢Ğ¢Ò6F6‚†W'"’°¢6†÷tÆW'B‚wv÷&G4ÆW'BrÂtW'&÷#¢r²W'"æÖW76vRÂvW'&÷"r“°¢Ğ¢Ğ ¢òò7F—f—G’F"gVæ7F–öç0¢7–æ2gVæ7F–öâÆöD7F—f—G’‚’°¢G'’°¢f"FFU6VÆV7BÒFö7VÖVçBævWDVÆVÖVçD'”–B‚v7F—f—G”FFRr“°¢f"6VÆV7FVDFFRÒFFU6VÆV7BçfÇVS°¢f"W&ÂÒrö’÷fö–6RÖÆös÷77v÷&CÒr²Væ6öFUU$”6ö×öæVçB‡77v÷&B“°¢–b‡6VÆV7FVDFFR’W&Â³ÒrfFFSÒr²6VÆV7FVDFFS° ¢f"&W2Òv—BfWF6‚‡W&Â“°¢f"FFÒv—B&W2æ§6öâ‚“°¢–b†FFæW'&÷"’&WGW&ã° ¢òòWFFRFFRG&÷F÷và¢f"7W'&VçEfÂÒFFU6VÆV7BçfÇVS°¢FFU6VÆV7Bæ–ææW$…DÔÂÒrs° ¢òòFBFöF’÷F–öà¢f"FöF”¶W’ÒæWrFFR‚’çFô•4õ7G&–ær‚’ç7Æ—B‚uBr•³Ó°¢f"FöF”÷BÒFö7VÖVçBæ7&VFTVÆVÖVçB‚v÷F–öâr“°¢FöF”÷BçfÇVRÒrs°¢FöF”÷BçFW‡D6öçFVçBÒuFöF’‚r²FöF”¶W’²r’s°¢FFU6VÆV7BæVæD6†–ÆB‡FöF”÷B“° ¢òòFBf–Æ&ÆRFFW0¢–b†FFæFFW2’°¢FFæFFW2æf÷$V6‚†gVæ7F–öâ†B’°¢–b†BÓÒFöF”¶W’’°¢f"÷BÒFö7VÖVçBæ7&VFTVÆVÖVçB‚v÷F–öâr“°¢÷BçfÇVRÒC°¢f"FFTö&¢ÒæWrFFR†B²uC#££r“°¢÷BçFW‡D6öçFVçBÒFFTö&¢çFôÆö6ÆTFFU7G&–ær‚vVâÕU2rÂ²vVV¶F“¢w6†÷'BrÂÖöçFƒ¢w6†÷'BrÂF“¢vçVÖW&–2rÂ–V#¢vçVÖW&–2rÒ“°¢FFU6VÆV7BæVæD6†–ÆB†÷B“°¢Ğ¢Ò“°¢Ğ ¢FFU6VÆV7BçfÇVRÒ7W'&VçEfÃ° ¢òò6†÷r6VÆV7FVBFFP¢Fö7VÖVçBævWDVÆVÖVçD'”–B‚v7F—f—G”FFTÆ&VÂr’çFW‡D6öçFVçBÒu6†÷v–æs¢r²†FFç6VÆV7FVDFFRÇÂFöF”¶W’’²r‚r²†FFçfö–6TÆöræÆVæwF‚’²rfö–6Ròr²†FFæÖVÖ&W$ÆöræÆVæwF‚’²rÖVÖ&W"VçG&–W2’s° ¢òòfö–6RÆöp¢f"d6öçF–æW"ÒFö7VÖVçBævWDVÆVÖVçD'”–B‚wfö–6TÆöt6öçF–æW"r“°¢–b‚FFçfö–6TÆörÇÂFFçfö–6TÆöræÆVæwF‚ÓÓÒ’°¢d6öçF–æW"æ–ææW$…DÔÂÒsÇ7G–ÆSÒ&6öÆ÷#¢f"‚Ò×FW‡BÖ×WFVB“²FW‡BÖÆ–vã¢6VçFW#²FF–æs¢#ƒ²#äæòfö–6R7F—f—G’f÷"F†—2FFSÂ÷âs°¢ÒVÇ6R°¢d6öçF–æW"æ–ææW$…DÔÂÒFFçfö–6TÆöræÖ†gVæ7F–öâ†VçG'’’°¢f"6öÆ÷"Â–6öâÂ7F–öåFW‡C°¢–b†VçG'’æ7F–öâÓÓÒv¦ö–æVBr’°¢6öÆ÷"Òwf"‚Ò×7V66W72’s²–6öâÒ	ùú"s²7F–öåFW‡BÒv¦ö–æVBs°¢ÒVÇ6R–b†VçG'’æ7F–öâÓÓÒw7v—F6†VBr’°¢6öÆ÷"Òwf"‚Ò×v&æ–ær’s²–6öâÒ	ùHBs²7F–öåFW‡BÒw7v—F6†VBg&öÒs°¢ÒVÇ6R°¢6öÆ÷"Òwf"‚ÒÖFævW"’s²–6öâÒ	ùKBs²7F–öåFW‡BÒvÆVgBs°¢Ğ¢f"GW%FW‡BÒVçG'’æGW&F–öâòr(	BÇ7G&öæsâr²VçG'’æGW&F–öâ²sÂ÷7G&öæsâr¢rs°¢f"FõFW‡BÒVçG'’çFô6†ææVÂòr(i"Ç7G&öæsâ2r²VçG'’çFô6†ææVÂ²sÂ÷7G&öæsâr¢rs°¢&WGW&âsÆF—b7G–ÆSÒ&&6¶w&÷VæC¢f"‚ÒÖ&r×FW'F–'’“²FF–æs¢‚Gƒ²&÷&FW"×&F—W3¢gƒ²Ö&v–âÖ&÷GFöÓ¢Gƒ²&÷&FW"ÖÆVgC¢7‚6öÆ–Br²6öÆ÷"²s²föçB×6—¦S¢7ƒ²#âr°¢sÇ7â7G–ÆSÒ&6öÆ÷#¢f"‚Ò×FW‡BÖ×WFVB“²föçB×6—¦S¢ƒ²fÆöC¢&–v‡C²#âr²VçG'’çF–ÖU7G"²sÂ÷7ãâr°¢–6öâ²rÇ7G&öæsâr²VçG'’çW6W&æÖR²sÂ÷7G&öæsâr°¢sÇ7â7G–ÆSÒ&6öÆ÷#¢r²6öÆ÷"²s²#âr²7F–öåFW‡B²sÂ÷7ãâr°¢sÇ7G&öæsâ2r²VçG'’æ6†ææVÄæÖR²sÂ÷7G&öæsâr²FõFW‡B²GW%FW‡B°¢sÂöF—câs°¢Ò’æ¦ö–â‚rr“°¢Ğ ¢òòÖVÖ&W"Æöp¢f"Ô6öçF–æW"ÒFö7VÖVçBævWDVÆVÖVçD'”–B‚vÖVÖ&W$Æöt6öçF–æW"r“°¢–b‚FFæÖVÖ&W$ÆörÇÂFFæÖVÖ&W$ÆöræÆVæwF‚ÓÓÒ’°¢Ô6öçF–æW"æ–ææW$…DÔÂÒsÇ7G–ÆSÒ&6öÆ÷#¢f"‚Ò×FW‡BÖ×WFVB“²FW‡BÖÆ–vã¢6VçFW#²FF–æs¢#ƒ²#äæòÖVÖ&W"7F—f—G’f÷"F†—2FFSÂ÷âs°¢ÒVÇ6R°¢Ô6öçF–æW"æ–ææW$…DÔÂÒFFæÖVÖ&W$ÆöræÖ†gVæ7F–öâ†VçG'’’°¢f"6öÆ÷"ÒVçG'’æ7F–öâÓÓÒv¦ö–æVBròwf"‚Ò×7V66W72’r¢wf"‚ÒÖFævW"’s°¢f"–6öâÒVçG'’æ7F–öâÓÓÒv¦ö–æVBrò	ù:Rr¢	ù:Bs°¢f"7F–öåFW‡BÒVçG'’æ7F–öâÓÓÒv¦ö–æVBròv¦ö–æVBF†R6W'fW"r¢vÆVgBF†R6W'fW"s°¢&WGW&âsÆF—b7G–ÆSÒ&&6¶w&÷VæC¢f"‚ÒÖ&r×FW'F–'’“²FF–æs¢‚Gƒ²&÷&FW"×&F—W3¢gƒ²Ö&v–âÖ&÷GFöÓ¢Gƒ²&÷&FW"ÖÆVgC¢7‚6öÆ–Br²6öÆ÷"²s²föçB×6—¦S¢7ƒ²#âr°¢sÇ7â7G–ÆSÒ&6öÆ÷#¢f"‚Ò×FW‡BÖ×WFVB“²föçB×6—¦S¢ƒ²fÆöC¢&–v‡C²#âr²VçG'’çF–ÖU7G"²sÂ÷7ãâr°¢–6öâ²rÇ7G&öæsâr²VçG'’çW6W&æÖR²sÂ÷7G&öæsâr°¢sÇ7â7G–ÆSÒ&6öÆ÷#¢r²6öÆ÷"²s²#âr²7F–öåFW‡B²sÂ÷7ãâBr²VçG'’çF–ÖU7G"°¢sÂöF—câs°¢Ò’æ¦ö–â‚rr“°¢Ğ¢Ò6F6‚†W'"’°¢6öç6öÆRæW'&÷"‚tW'&÷"ÆöF–ær7F—f—G“¢rÂW'"“°¢Ğ¢Ğ ¢6WD–çFW'fÂ†gVæ7F–öâ‚’°¢–b†Fö7VÖVçBævWDVÆVÖVçD'”–B‚wF"ÖVF—Br’æ6Æ74Æ—7Bæ6öçF–ç2‚v7F—fRr’’ÆöDVF—DÆör‚“°¢–b†Fö7VÖVçBævWDVÆVÖVçD'”–B‚wF"Ö7F—f—G’r’æ6Æ74Æ—7Bæ6öçF–ç2‚v7F—fRr’’ÆöD7F—f—G’‚“°¢ÒÂ“° ¢Fö7VÖVçBæFDWfVçDÆ—7FVæW"‚tDôÔ6öçFVçDÆöFVBrÂgVæ7F–öâ‚’°¢Fö7VÖVçBævWDVÆVÖVçD'”–B‚vÆöv–å77v÷&Br’æFDWfVçDÆ—7FVæW"‚v¶W—&W72rÂgVæ7F–öâ†R’°¢–b†Ræ¶W’ÓÓÒtVçFW"r’Æöv–â‚“°¢Ò“°¢Ò“°¢Â÷67&—Cà£Âö&öG“à£Âö‡FÖÃæ°§Ğ ¦gVæ7F–öâ6VæD&ÇVW&–çDÖW76vR†ÖW76vR’°¢–b‡G—Vöb&ö6W72ç6VæBÓÓÒvgVæ7F–öâr’&ö6W72ç6VæB†ÖW76vR“°§Ğ §&ö6W72æöâ‚vÖW76vRrÂ7–æ2ÖW76vRÓâ°¢–b‚ÖW76vR’&WGW&ã°¢–b†ÖW76vRæ6†ææVÂÓÓÒv6öÖÖ—76–öã¦ÖVÖ&W&'&–FvR×&WVW7Br’°¢6öç7B²–BÂ7F–öâÂ–ÆöBÒ·ÒÒÒÖW76vS°¢G'’°¢–b‚6Æ–VçBæ—5&VG’‚’’F‡&÷ræWrW'&÷"‚u7F'BF†R&÷BæBv—Bf÷"F—66÷&BFò6öææV7Bf—'7Bâr“°¢6öç7BFFÒv—BÖVÖ&W$'&–FvT–çFVw&F–öâæFÖ–â†7F–öâÂ–ÆöB“°¢–b‡G—Vöb&ö6W72ç6VæBÓÓÒvgVæ7F–öâr’&ö6W72ç6VæB‡²6†ææVÃ¢v6öÖÖ—76–öã¦ÖVÖ&W&'&–FvR×&W7öç6RrÂ–BÂö³¢G'VRÂFFÒ“°¢Ò6F6‚†W'&÷"’°¢–b‡G—Vöb&ö6W72ç6VæBÓÓÒvgVæ7F–öâr’&ö6W72ç6VæB‡²6†ææVÃ¢v6öÖÖ—76–öã¦ÖVÖ&W&'&–FvR×&W7öç6RrÂ–BÂö³¢fÇ6RÂW'&÷#¢W'&÷"æÖW76vRÒ“°¢Ğ¢&WGW&ã°¢Ğ¢–b†ÖW76vRæ6†ææVÂÓÓÒv6öÖÖ—76–öã¦V6öæö×’×&WVW7Br’°¢6öç7B²–BÂ7F–öâÂ–ÆöBÒ·ÒÒÒÖW76vS°¢G'’°¢–b‚6Æ–VçBæ—5&VG’‚’’F‡&÷ræWrW'&÷"‚u7F'BF†R&÷BæBv—Bf÷"F—66÷&BFò6öææV7Bf—'7Bâr“°¢6öç7BwV–ÆD–BÒ–ÆöBæwV–ÆD–BÇÂ6Æ–VçBæwV–ÆG2æ66†Ræf—'7B‚“òæ–C°¢–b‚wV–ÆD–B’F‡&÷ræWrW'&÷"‚uF†R&÷B—2æ÷B6öææV7FVBFò6W'fW"âr“°¢ÆWBFF°¢–b†7F–öâÓÓÒw7FG2r’FFÒV6öæö×’ç7FG2†wV–ÆD–B“°¢VÇ6R–b†7F–öâÓÓÒvÆVFW&&ö&Br’FFÒ–ÆöBçG—RÓÓÒw&Wp¢òV6öæö×’ç&WÆVFW&&ö&B†wV–ÆD–BÂ¢¢V6öæö×’æÆVFW&&ö&B†wV–ÆD–BÂ–ÆöBçG—RÇÂv&Ææ6RrÂ“°¢VÇ6R–b†7F–öâÓÓÒwW6‚Ö†V—7B×æVÂr’FFÒv—BV6öæö×”–çFVw&F–öâçW6„†V—7EæVÂ†wV–ÆD–BÂ–ÆöBæ6†ææVÄ–B“°¢VÇ6R–b†7F–öâÓÓÒw&W6WB×&Wf–Wrr’FFÒv—BV6öæö×”–çFVw&F–öâç&Wf–Wu&W6WB†wV–ÆD–BÂ–ÆöBæ7F–öâÂ–ÆöBçW6W$–B“°¢VÇ6R–b†7F–öâÓÓÒw&W6WBÖW†V7WFRr’FFÒv—BV6öæö×”–çFVw&F–öâæW†V7WFU&W6WB†wV–ÆD–BÂ–ÆöBçFö¶Vâ“°¢VÇ6R–b†7F–öâÓÓÒv'VÆ²Öw&çB×&Wf–Wrr’FFÒv—BV6öæö×”–çFVw&F–öâç&Wf–Wt'VÆ´w&çB†wV–ÆD–BÂ–ÆöBæÖ÷VçB“°¢VÇ6R–b†7F–öâÓÓÒv'VÆ²Öw&çBÖW†V7WFRr’FFÒv—BV6öæö×”–çFVw&F–öâæW†V7WFT'VÆ´w&çB†wV–ÆD–BÂ–ÆöBçFö¶Vâ“°¢VÇ6RF‡&÷ræWrW'&÷"†Væ¶æ÷vâV6öæö×’7F–öã¢G¶7F–öçÖ“°¢–b‡G—Vöb&ö6W72ç6VæBÓÓÒvgVæ7F–öâr’&ö6W72ç6VæB‡²6†ææVÃ¢v6öÖÖ—76–öã¦V6öæö×’×&W7öç6RrÂ–BÂö³¢G'VRÂFFÒ“°¢Ò6F6‚†W'&÷"’°¢–b‡G—Vöb&ö6W72ç6VæBÓÓÒvgVæ7F–öâr’&ö6W72ç6VæB‡²6†ææVÃ¢v6öÖÖ—76–öã¦V6öæö×’×&W7öç6RrÂ–BÂö³¢fÇ6RÂW'&÷#¢W'&÷"æÖW76vRÒ“°¢Ğ¢&WGW&ã°¢Ğ¢–b†ÖW76vRæ6†ææVÂÓÒv6öÖÖ—76–öã¦&ÇVW&–çB×&WVW7Br’&WGW&ã°¢6öç7B²–BÂ7F–öâÂ–ÆöBÒ·ÒÒÒÖW76vS° ¢G'’°¢–b‚6Æ–VçBæ—5&VG’‚’’F‡&÷ræWrW'&÷"‚u7F'BF†R&÷BæBv—Bf÷"F—66÷&BFò6öææV7Bf—'7Bâr“° ¢–b†7F–öâÓÓÒvÆ—7BÖwV–ÆG2r’°¢6öç7BwV–ÆG2Ò6Æ–VçBæwV–ÆG2æ66†P¢æÖ†wV–ÆBÓâ‡²–C¢wV–ÆBæ–BÂæÖS¢wV–ÆBææÖRÂ–6öåW&Ã¢wV–ÆBæ–6öåU$Â‡²W‡FVç6–öã¢wærrÂ6—¦S¢#‚Ò’Ò’¢ç6÷'B‚†Â"’ÓâææÖRæÆö6ÆT6ö×&R†"ææÖR’“°¢6VæD&ÇVW&–çDÖW76vR‡²6†ææVÃ¢v6öÖÖ—76–öã¦&ÇVW&–çB×&W7öç6RrÂ–BÂö³¢G'VRÂFF¢wV–ÆG2Ò“°¢&WGW&ã°¢Ğ ¢–b†7F–öâÓÓÒv6GW&Rr’°¢6öç7BwV–ÆBÒv—B6Æ–VçBæwV–ÆG2æfWF6‚‡–ÆöBæwV–ÆD–B“°¢6VæD&ÇVW&–çDÖW76vR‡²6†ææVÃ¢v6öÖÖ—76–öã¦&ÇVW&–çB×&öw&W72rÂ–BÂÖW76vS¢6GW&–ærG¶wV–ÆBææÖWÖÒ“°¢6öç7B&ÇVW&–çBÒv—B6GW&TwV–ÆD&ÇVW&–çB†wV–ÆB“°¢6VæD&ÇVW&–çDÖW76vR‡²6†ææVÃ¢v6öÖÖ—76–öã¦&ÇVW&–çB×&W7öç6RrÂ–BÂö³¢G'VRÂFF¢&ÇVW&–çBÒ“°¢&WGW&ã°¢Ğ ¢–b†7F–öâÓÓÒvÇ’r’°¢6öç7BwV–ÆBÒv—B6Æ–VçBæwV–ÆG2æfWF6‚‡–ÆöBæwV–ÆD–B“°¢6öç7B&W7VÇBÒv—BÇ”wV–ÆD&ÇVW&–çB€¢wV–ÆBÀ¢–ÆöBæ&ÇVW&–çBÀ¢²Ç”WfW'–öæUW&Ö—76–öç3¢&ööÆVâ‡–ÆöBæÇ”WfW'–öæUW&Ö—76–öç2’ÒÀ¢&öw&W74ÖW76vRÓâ6VæD&ÇVW&–çDÖW76vR‡°¢6†ææVÃ¢v6öÖÖ—76–öã¦&ÇVW&–çB×&öw&W72rÀ¢–BÀ¢ÖW76vS¢&öw&W74ÖW76vRÀ¢Ò’À¢“°¢6VæD&ÇVW&–çDÖW76vR‡²6†ææVÃ¢v6öÖÖ—76–öã¦&ÇVW&–çB×&W7öç6RrÂ–BÂö³¢G'VRÂFF¢&W7VÇBÒ“°¢&WGW&ã°¢Ğ ¢F‡&÷ræWrW'&÷"†Væ¶æ÷vâ&ÇVW&–çB7F–öã¢G¶7F–öçÖ“°¢Ò6F6‚†W'&÷"’°¢6VæD&ÇVW&–çDÖW76vR‡°¢6†ææVÃ¢v6öÖÖ—76–öã¦&ÇVW&–çB×&W7öç6RrÀ¢–BÀ¢ö³¢fÇ6RÀ¢W'&÷#¢W'&÷"æÖW76vRÀ¢Ò“°¢Ğ§Ò“° ¢òòÆöv–à¦6öç7BDô´TâÒ&ö6W72æVçbäD•44õ$EõDô´TâÇÂrs°¦–b‚Dô´Tâ’°¢6öç6öÆRæW'&÷"‚tF—66÷&BFö¶Vâ—2Ö—76–ærâFB—B–âF†R6öÖÖ—76–öâ6öçG&öÂæVÂâr“°¢&ö6W72æW†—D6öFRÒ°§ÒVÇ6R°¦ÆWB6‡WGF–ætF÷vâÒfÇ6S°¦7–æ2gVæ7F–öâw&6VgVÅ6‡WFF÷vâ‡6–væÂ’°¢–b‡6‡WGF–ætF÷vâ’&WGW&ã°¢6‡WGF–ætF÷vâÒG'VS°¢6öç6öÆRæÆör†·7—7FVÕÒG·6–væÇÒ&V6V—fVC²6Æ÷6–ærÖVÖ&W$'&–FvRæBF—66÷&B6ÆVæÇ’æ“°¢G'’²v—BÖVÖ&W$'&–FvT–çFVw&F–öâç7F÷‚“²Ò6F6‚†W'&÷"’²6öç6öÆRæW'&÷"‚u´ÖVÖ&W$'&–FvR6‡WFF÷våÒrÂW'&÷"æÖW76vR“²Ğ¢G'’²V6öæö×’æ6Æ÷6Sòâ‚“²Ò6F6‚†W'&÷"’²6öç6öÆRæW'&÷"‚u´V6öæö×’6‡WFF÷våÒrÂW'&÷"æÖW76vR“²Ğ¢G'’²6Æ–VçBæFW7G&÷’‚“²Ò6F6‚·Ğ¢&ö6W72æW†—Bƒ“°§Ğ§&ö6W72æöæ6R‚u4”uDU$ÒrÂ‚’Óâw&6VgVÅ6‡WFF÷vâ‚u4”uDU$Òr’“°§&ö6W72æöæ6R‚u4”t”åBrÂ‚’Óâw&6VgVÅ6‡WFF÷vâ‚u4”t”åBr’“° ¦6Æ–VçBæÆöv–â…Dô´Tâ’æ6F6‚†W'&÷"Óâ°¢6öç6öÆRæW'&÷"‚tF—66÷&BÆöv–âf–ÆVC¢rÂW'&÷"æÖW76vR“°¢&ö6W72æW†—D6öFRÒ°¢Ò“°§Ğ 