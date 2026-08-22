const Discord = require('discord.js');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { applyGuildBlueprint, captureGuildBlueprint } = require('./blueprint');
const { EconomyService } = require('./economy');
const { economyCommandData, createEconomyIntegration } = require('./economy_discord');
const { isDoxWord } = require('./moderation_word_policy');
const { verifyAddressWithFreeGeocoders } = require('./address_verification');
const { MemberBridgeIntegration, memberBridgeCommandData } = require('./memberbridge/integration');
const goingLive = require('./going_live');
const { installLiveVoicePairs } = require('./live_voice_pairs');
const { installManualJailRoleWorkflow } = require('./manual_jail_role');

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
    MOD_CHANNEL_ID: process.env.MOD_CHANNEL_ID || '1532529016479682774',
    LOG_CHANNEL_ID: process.env.LOG_CHANNEL_ID || '',
    TICKET_CATEGORY_ID: process.env.TICKET_CATEGORY_ID || '',
    STAFF_ROLE_IDS: (process.env.STAFF_ROLE_IDS || '').split(',').filter(Boolean),
    OWNER_USER_ID: process.env.OWNER_USER_ID || '',
    WEB_DASHBOARD_PASSWORD: process.env.WEB_DASHBOARD_PASSWORD || '',
    ALT_DETECTION_ENABLED: process.env.ALT_DETECTION_ENABLED !== 'false', // Default enabled
    ALT_ACCOUNT_AGE_DAYS: parseInt(process.env.ALT_ACCOUNT_AGE_DAYS || '14'), // Auto-jail accounts newer than 14 days
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
installManualJailRoleWorkflow(client, Discord, {
    jailRoleId: CONFIG.JAIL_ROLE_ID,
    jailCategoryId: CONFIG.JAIL_CATEGORY_ID,
    modChannelId: CONFIG.MOD_CHANNEL_ID,
    staffRoleIds: CONFIG.STAFF_ROLE_IDS,
});

// Music channel configuration
const MUSIC_CHANNEL_ID = CONFIG.MUSIC_CHANNEL_ID;
const MUSIC_VOICE_CHANNEL_ID = CONFIG.MUSIC_VOICE_CHANNEL_ID;

const STAFF_CHANNEL_PERMISSIONS = [
    Discord.PermissionFlagsBits.ViewChannel,
    Discord.PermissionFlagsBits.SendMessages,
    Discord.PermissionFlagsBits.ReadMessageHistory,
];

function configuredStaffRoleIds(guild) {
    const configuredIds = [...new Set(CONFIG.STAFF_ROLE_IDS.map(id => String(id).trim()).filter(Boolean))];
    const validIds = configuredIds.filter(id => guild.roles.cache.has(id));
    const invalidIds = configuredIds.filter(id => !guild.roles.cache.has(id));

    if (invalidIds.length) {
        console.warn(`[Discord permissions] Ignoring staff role IDs that do not exist in guild ${guild.id}: ${invalidIds.join(', ')}`);
    }

    return validIds;
}

function staffPermissionOverwrites(guild) {
    return configuredStaffRoleIds(guild).map(id => ({
        id,
        allow: STAFF_CHANNEL_PERMISSIONS,
    }));
}

function staffMentions(guild, extraUserId = '') {
    const mentions = [];
    if (CONFIG.OWNER_USER_ID) mentions.push(`<@${CONFIG.OWNER_USER_ID}>`);
    mentions.push(...configuredStaffRoleIds(guild).map(id => `<@&${id}>`));
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
    { question: "What year did Minecraft release?", answer: "2011", category: "Gaming" },
    { question: "Who created SpongeBob SquarePants?", answer: "Stephen Hillenburg", category: "TV" },
    { question: "What is Mario's brother's name?", answer: "Luigi", category: "Gaming" },
    { question: "What movie won Best Picture in 2020?", answer: "Parasite", category: "Movies" },
    { question: "How many Infinity Stones are there?", answer: "6", category: "Marvel" },
    { question: "What is the highest-grossing film of all time?", answer: "Avatar", category: "Movies" },
    { question: "Who voices Woody in Toy Story?", answer: "Tom Hanks", category: "Movies" },
    { question: "What year did Fortnite release?", answer: "2017", category: "Gaming" },
    { question: "What is the name of Iron Man?", answer: "Tony Stark", category: "Marvel" },
    { question: "How many Harry Potter books are there?", answer: "7", category: "Literature" },
    { question: "What is the longest-running animated TV show?", answer: "The Simpsons", category: "TV" },
    { question: "Who directed Jurassic Park?", answer: "Steven Spielberg", category: "Movies" },
    { question: "What game is Pikachu from?", answer: "Pokemon", category: "Gaming" },
    { question: "How many Dragon Balls are there?", answer: "7", category: "Anime" },
    { question: "What is Batman's real name?", answer: "Bruce Wayne", category: "DC" },
    { question: "Who created The Simpsons?", answer: "Matt Groening", category: "TV" },
    { question: "What year did YouTube launch?", answer: "2005", category: "Tech" },
    { question: "How many Star Wars movies are there?", answer: "9", category: "Movies" },
    { question: "What is the name of Thor's hammer?", answer: "Mjolnir", category: "Marvel" },
    { question: "Who is the main character in The Legend of Zelda?", answer: "Link", category: "Gaming" },
    { question: "What streaming service created Stranger Things?", answer: "Netflix", category: "TV" },
    { question: "How many seasons of Breaking Bad are there?", answer: "5", category: "TV" },
    { question: "What is Superman's weakness?", answer: "Kryptonite", category: "DC" },
    { question: "Who directed The Dark Knight?", answer: "Christopher Nolan", category: "Movies" },
    { question: "What year did Roblox release?", answer: "2006", category: "Gaming" },
    { question: "How many Avengers movies are there?", answer: "4", category: "Marvel" },
    { question: "What is the name of the dog in The Simpsons?", answer: "Santa's Little Helper", category: "TV" },
    { question: "Who voices Elsa in Frozen?", answer: "Idina Menzel", category: "Movies" },
    { question: "What game features Steve as the main character?", answer: "Minecraft", category: "Gaming" },
    { question: "How many seasons of Game of Thrones are there?", answer: "8", category: "TV" },
    { question: "What is the name of Harry Potter's owl?", answer: "Hedwig", category: "Literature" },
    { question: "Who created Marvel Comics?", answer: "Stan Lee", category: "Marvel" },
    { question: "What year did Among Us release?", answer: "2018", category: "Gaming" },
    { question: "How many Lord of the Rings movies are there?", answer: "3", category: "Movies" },
    { question: "What is the Flash's real name?", answer: "Barry Allen", category: "DC" },
    { question: "Who directed Avatar?", answer: "James Cameron", category: "Movies" },
    { question: "What game series features Master Chief?", answer: "Halo", category: "Gaming" },
    { question: "How many episodes of Friends are there?", answer: "236", category: "TV" },
    { question: "What is Spider-Man's real name?", answer: "Peter Parker", category: "Marvel" },
    { question: "Who wrote The Hunger Games?", answer: "Suzanne Collins", category: "Literature" },
    { question: "What year did TikTok launch?", answer: "2016", category: "Tech" },
    { question: "How many seasons of The Office US are there?", answer: "9", category: "TV" },
    { question: "What is Wonder Woman's real name?", answer: "Diana Prince", category: "DC" },
    { question: "Who directed Inception?", answer: "Christopher Nolan", category: "Movies" },
    { question: "What game features the Victory Royale?", answer: "Fortnite", category: "Gaming" },
    { question: "How many seasons of Stranger Things are there?", answer: "4", category: "TV" },
    { question: "What is the name of the main character in Naruto?", answer: "Naruto Uzumaki", category: "Anime" },
    { question: "Who created Rick and Morty?", answer: "Justin Roiland", category: "TV" },
    { question: "What year did Instagram launch?", answer: "2010", category: "Tech" },
    { question: "How many Batman movies did Christopher Nolan direct?", answer: "3", category: "Movies" },

    // Science & Nature (50)
    { question: "What is the powerhouse of the cell?", answer: "Mitochondria", category: "Biology" },
    { question: "How many planets are in our solar system?", answer: "8", category: "Space" },
    { question: "What is the largest organ in the human body?", answer: "Skin", category: "Biology" },
    { question: "What gas do humans breathe out?", answer: "Carbon Dioxide", category: "Science" },
    { question: "How many elements are on the periodic table?", answer: "118", category: "Chemistry" },
    { question: "What is the closest star to Earth?", answer: "Sun", category: "Space" },
    { question: "How many chambers does the human heart have?", answer: "4", category: "Biology" },
    { question: "What is the chemical formula for salt?", answer: "NaCl", category: "Chemistry" },
    { question: "What planet is closest to the Sun?", answer: "Mercury", category: "Space" },
    { question: "How many legs does a spider have?", answer: "8", category: "Animals" },
    { question: "What is the study of earthquakes called?", answer: "Seismology", category: "Science" },
    { question: "How long does it take for light from the Sun to reach Earth?", answer: "8", category: "Space" },
    { question: "What is the smallest bone in the human body?", answer: "Stapes", category: "Biology" },
    { question: "What is the chemical symbol for sodium?", answer: "Na", category: "Chemistry" },
    { question: "How many moons does Mars have?", answer: "2", category: "Space" },
    { question: "What is the largest bird in the world?", answer: "Ostrich", category: "Animals" },
    { question: "What is the study of plants called?", answer: "Botany", category: "Science" },
    { question: "How many hearts does an octopus have?", answer: "3", category: "Animals" },
    { question: "What is the most abundant gas in Earth's atmosphere?", answer: "Nitrogen", category: "Science" },
    { question: "What planet has the most moons?", answer: "Saturn", category: "Space" },
    { question: "How many lungs do humans have?", answer: "2", category: "Biology" },
    { question: "What is the chemical symbol for carbon?", answer: "C", category: "Chemistry" },
    { question: "What is the largest star in our solar system?", answer: "Sun", category: "Space" },
    { question: "How many wings does a bee have?", answer: "4", category: "Animals" },
    { question: "What is the study of weather called?", answer: "Meteorology", category: "Science" },
    { question: "How many teeth do sharks regrow throughout life?", answer: "Unlimited", category: "Animals" },
    { question: "What is the pH of pure water?", answer: "7", category: "Chemistry" },
    { question: "What planet is known for its rings?", answer: "Saturn", category: "Space" },
    { question: "How many pairs of ribs do humans have?", answer: "12", category: "Biology" },
    { question: "What is the chemical formula for carbon dioxide?", answer: "CO2", category: "Chemistry" },
    { question: "How many Earths could fit inside the Sun?", answer: "1000000", category: "Space" },
    { question: "What is the fastest fish in the ocean?", answer: "Sailfish", category: "Animals" },
    { question: "What is the study of fungi called?", answer: "Mycology", category: "Science" },
    { question: "How many arms does a starfish have?", answer: "5", category: "Animals" },
    { question: "What is the most common element in the universe?", answer: "Hydrogen", category: "Science" },
    { question: "What is the hottest planet in our solar system?", answer: "Venus", category: "Space" },
    { question: "How many chromosomes do humans have?", answer: "46", category: "Biology" },
    { question: "What is the chemical symbol for iron?", answer: "Fe", category: "Chemistry" },
    { question: "How many light years away is the nearest star?", answer: "4", category: "Space" },
    { question: "What is the largest species of bear?", answer: "Polar Bear", category: "Animals" },
    { question: "What is the study of rocks called?", answer: "Geology", category: "Science" },
    { question: "How many legs does a lobster have?", answer: "10", category: "Animals" },
    { question: "What is the atomic number of hydrogen?", answer: "1", category: "Chemistry" },
    { question: "What galaxy is Earth in?", answer: "Milky Way", category: "Space" },
    { question: "How many vertebrae are in the human spine?", answer: "33", category: "Biology" },
    { question: "What is the rarest blood type?", answer: "AB Negative", category: "Biology" },
    { question: "How many legs does a centipede have?", answer: "100", category: "Animals" },
    { question: "What is the study of insects called?", answer: "Entomology", category: "Science" },
    { question: "What is the largest land animal?", answer: "African Elephant", category: "Animals" },
    { question: "How many moons does Jupiter have?", answer: "79", category: "Space" },

    // Technology & Internet (50)
    { question: "Who founded Microsoft?", answer: "Bill Gates", category: "Tech" },
    { question: "What does CPU stand for?", answer: "Central Processing Unit", category: "Tech" },
    { question: "Who founded Apple?", answer: "Steve Jobs", category: "Tech" },
    { question: "What year was Google founded?", answer: "1998", category: "Tech" },
    { question: "What does HTML stand for?", answer: "Hypertext Markup Language", category: "Tech" },
    { question: "Who founded Facebook?", answer: "Mark Zuckerberg", category: "Tech" },
    { question: "What does RAM stand for?", answer: "Random Access Memory", category: "Tech" },
    { question: "Who founded Amazon?", answer: "Jeff Bezos", category: "Tech" },
    { question: "What year was Twitter founded?", answer: "2006", category: "Tech" },
    { question: "What does USB stand for?", answer: "Universal Serial Bus", category: "Tech" },
    { question: "Who founded Tesla?", answer: "Elon Musk", category: "Tech" },
    { question: "What does Wi-Fi stand for?", answer: "Wireless Fidelity", category: "Tech" },
    { question: "Who created Linux?", answer: "Linus Torvalds", category: "Tech" },
    { question: "What year was Wikipedia founded?", answer: "2001", category: "Tech" },
    { question: "What does URL stand for?", answer: "Uniform Resource Locator", category: "Tech" },
    { question: "Who founded PayPal?", answer: "Elon Musk", category: "Tech" },
    { question: "What does GPU stand for?", answer: "Graphics Processing Unit", category: "Tech" },
    { question: "Who invented the World Wide Web?", answer: "Tim Berners-Lee", category: "Tech" },
    { question: "What year was Netflix founded?", answer: "1997", category: "Tech" },
    { question: "What does DNS stand for?", answer: "Domain Name System", category: "Tech" },
    { question: "Who founded Spotify?", answer: "Daniel Ek", category: "Tech" },
    { question: "What does SSD stand for?", answer: "Solid State Drive", category: "Tech" },
    { question: "Who created Python programming language?", answer: "Guido van Rossum", category: "Tech" },
    { question: "What year was Snapchat founded?", answer: "2011", category: "Tech" },
    { question: "What does VPN stand for?", answer: "Virtual Private Network", category: "Tech" },
    { question: "Who founded Reddit?", answer: "Steve Huffman", category: "Tech" },
    { question: "What does API stand for?", answer: "Application Programming Interface", category: "Tech" },
    { question: "Who created Java programming language?", answer: "James Gosling", category: "Tech" },
    { question: "What year was WhatsApp founded?", answer: "2009", category: "Tech" },
    { question: "What does ISP stand for?", answer: "Internet Service Provider", category: "Tech" },
    { question: "Who founded Uber?", answer: "Travis Kalanick", category: "Tech" },
    { question: "What does OS stand for?", answer: "Operating System", category: "Tech" },
    { question: "Who created the C programming language?", answer: "Dennis Ritchie", category: "Tech" },
    { question: "What year was Twitch founded?", answer: "2011", category: "Tech" },
    { question: "What does LAN stand for?", answer: "Local Area Network", category: "Tech" },
    { question: "Who founded Airbnb?", answer: "Brian Chesky", category: "Tech" },
    { question: "What does HTTP stand for?", answer: "Hypertext Transfer Protocol", category: "Tech" },
    { question: "Who created JavaScript?", answer: "Brendan Eich", category: "Tech" },
    { question: "What year was Slack founded?", answer: "2013", category: "Tech" },
    { question: "What does FPS stand for in gaming?", answer: "Frames Per Second", category: "Gaming" },
    { question: "Who founded Nvidia?", answer: "Jensen Huang", category: "Tech" },
    { question: "What does BIOS stand for?", answer: "Basic Input Output System", category: "Tech" },
    { question: "Who created Rust programming language?", answer: "Graydon Hoare", category: "Tech" },
    { question: "What year was Discord founded?", answer: "2015", category: "Tech" },
    { question: "What does SQL stand for?", answer: "Structured Query Language", category: "Tech" },
    { question: "Who founded Adobe?", answer: "John Warnock", category: "Tech" },
    { question: "What does AI stand for?", answer: "Artificial Intelligence", category: "Tech" },
    { question: "Who created Ruby programming language?", answer: "Yukihiro Matsumoto", category: "Tech" },
    { question: "What year was Zoom founded?", answer: "2011", category: "Tech" },
    { question: "What does IoT stand for?", answer: "Internet of Things", category: "Tech" },

    // Sports & Games (50)
    { question: "How many points is a touchdown worth?", answer: "6", category: "Sports" },
    { question: "How many players on a basketball team?", answer: "5", category: "Sports" },
    { question: "What sport is played at Wimbledon?", answer: "Tennis", category: "Sports" },
    { question: "How many holes are on a golf course?", answer: "18", category: "Sports" },
    { question: "How many innings in a baseball game?", answer: "9", category: "Sports" },
    { question: "What country hosted the 2016 Olympics?", answer: "Brazil", category: "Sports" },
    { question: "How many players on a hockey team?", answer: "6", category: "Sports" },
    { question: "Who has won the most Super Bowls?", answer: "Tom Brady", category: "Sports" },
    { question: "How many points is a 3-pointer in basketball?", answer: "3", category: "Sports" },
    { question: "What sport uses a shuttlecock?", answer: "Badminton", category: "Sports" },
    { question: "How many Grand Slams are in tennis?", answer: "4", category: "Sports" },
    { question: "What country won the 2018 World Cup?", answer: "France", category: "Sports" },
    { question: "How many periods in a hockey game?", answer: "3", category: "Sports" },
    { question: "Who holds the home run record?", answer: "Barry Bonds", category: "Sports" },
    { question: "How many points is a field goal in football?", answer: "3", category: "Sports" },
    { question: "What sport is played in the NBA?", answer: "Basketball", category: "Sports" },
    { question: "How many bases in baseball?", answer: "4", category: "Sports" },
    { question: "What country hosted the 2020 Olympics?", answer: "Japan", category: "Sports" },
    { question: "How many quarters in a football game?", answer: "4", category: "Sports" },
    { question: "Who has won the most NBA championships?", answer: "Bill Russell", category: "Sports" },
    { question: "How many strikes for a strikeout?", answer: "3", category: "Sports" },
    { question: "What sport is played in the NHL?", answer: "Hockey", category: "Sports" },
    { question: "How many yards is a football field?", answer: "100", category: "Sports" },
    { question: "What country hosted the 2014 World Cup?", answer: "Brazil", category: "Sports" },
    { question: "How many players on a volleyball team?", answer: "6", category: "Sports" },
    { question: "Who is the fastest man in the world?", answer: "Usain Bolt", category: "Sports" },
    { question: "How many sets in a tennis match?", answer: "3", category: "Sports" },
    { question: "What sport is played in the NFL?", answer: "Football", category: "Sports" },
    { question: "How many outs in an inning?", answer: "3", category: "Sports" },
    { question: "What country has won the most World Cups?", answer: "Brazil", category: "Sports" },
    { question: "How many points for a safety in football?", answer: "2", category: "Sports" },
    { question: "What sport is played in the MLB?", answer: "Baseball", category: "Sports" },
    { question: "How many fouls before fouling out in NBA?", answer: "6", category: "Sports" },
    { question: "What sport uses a puck?", answer: "Hockey", category: "Sports" },
    { question: "How many yards for a first down?", answer: "10", category: "Sports" },
    { question: "Who has the most Olympic gold medals?", answer: "Michael Phelps", category: "Sports" },
    { question: "How many players on a rugby team?", answer: "15", category: "Sports" },
    { question: "What sport is played at Augusta National?", answer: "Golf", category: "Sports" },
    { question: "How many pins in bowling?", answer: "10", category: "Sports" },
    { question: "What country hosted the first Olympics?", answer: "Greece", category: "Sports" },
    { question: "How many timeouts per half in NBA?", answer: "7", category: "Sports" },
    { question: "What sport uses a net and racket?", answer: "Tennis", category: "Sports" },
    { question: "How many players in a cricket team?", answer: "11", category: "Sports" },
    { question: "Who has the most Tour de France wins?", answer: "Lance Armstrong", category: "Sports" },
    { question: "How many rounds in a boxing match?", answer: "12", category: "Sports" },
    { question: "What sport is played at the Masters?", answer: "Golf", category: "Sports" },
    { question: "How many games in a set of tennis?", answer: "6", category: "Sports" },
    { question: "Who has the most career points in NBA?", answer: "LeBron James", category: "Sports" },
    { question: "How many arrows in archery round?", answer: "72", category: "Sports" },
    { question: "What sport uses a pommel horse?", answer: "Gymnastics", category: "Sports" },
];

// Store user states for interactive commands and tickets
const userStates = new Map();

// Audit log system
const auditLog = [];
const MAX_AUDIT_LOGS = 500; // Keep last 500 events

function addAuditLog(action, user, details, severity = 'info') {
    const logEntry = {
        timestamp: new Date().toISOString(),
        action,
        user: user ? `${user.tag} (${user.id})` : 'System',
        details,
        severity // info, warning, error, success
    };

    auditLog.unshift(logEntry); // Add to beginning

    // Keep only last MAX_AUDIT_LOGS entries
    if (auditLog.length > MAX_AUDIT_LOGS) {
        auditLog.pop();
    }

    console.log(`[AUDIT ${severity.toUpperCase()}] ${action} by ${logEntry.user}: ${details}`);
}


client.on('ready', async () => {
    console.log(`âœ… Bot logged in as ${client.user.tag}`);
    console.log(`Dashboard available at: http://localhost:${process.env.PORT || 10000}`);
    addAuditLog('Bot Started', client.user, `Bot logged in as ${client.user.tag}`, 'success');

    // Register slash commands using REST API
    try {
        console.log('ðŸ“ Registering slash commands...');
        console.log(`   Application ID: ${client.user.id}`);

        const { REST, Routes } = require('discord.js');
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN || '');

        const commands = [
            new Discord.SlashCommandBuilder()
                .setName('report')
                .setDescription('Report a user to the mod team')
                .addStringOption(option =>
                    option.setName('user')
                        .setDescription('Who are you reporting? (username or @mention)')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('reason')
                        .setDescription('Why are you reporting them?')
                        .setRequired(true))
                .toJSON(),
            new Discord.SlashCommandBuilder()
                .setName('jail')
                .setDescription('Jail a user - hides all text & voice channels from them')
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('The user to jail')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('duration')
                        .setDescription('How long to jail (default: permanent)')
                        .setRequired(false)
                        .addChoices(
                            { name: '5 minutes', value: '5m' },
                            { name: '30 minutes', value: '30m' },
                            { name: '1 hour', value: '1h' },
                            { name: '6 hours', value: '6h' },
                            { name: '12 hours', value: '12h' },
                            { name: '24 hours', value: '24h' },
                            { name: 'Permanent', value: 'perm' },
                        ))
                .addStringOption(option =>
                    option.setName('reason')
                        .setDescription('Reason for jailing')
                        .setRequired(false))
                .toJSON(),
            new Discord.SlashCommandBuilder()
                .setName('unjail')
                .setDescription('Unjail a user - restores their channel access')
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('The user to unjail')
                        .setRequired(true))
                .toJSON(),
            new Discord.SlashCommandBuilder()
                .setName('close')
                .setDescription('Close a jail channel without unjailing (for bans)')
                .toJSON(),
            new Discord.SlashCommandBuilder()
                .setName('join')
                .setDescription('Bot joins the music voice channel')
                .toJSON(),
            new Discord.SlashCommandBuilder()
                .setName('leave')
                .setDescription('Bot leaves the voice channel')
                .toJSON(),
            new Discord.SlashCommandBuilder()
                .setName('play')
                .setDescription('Play a YouTube video in voice chat')
                .addStringOption(option =>
                    option.setName('url')
                        .setDescription('YouTube URL or search query')
                        .setRequired(true))
                .toJSON(),
            new Discord.SlashCommandBuilder()
                .setName('skip')
                .setDescription('Skip the current song')
                .toJSON(),
            new Discord.SlashCommandBuilder()
                .setName('queue')
                .setDescription('Show the music queue')
                .toJSON(),
            new Discord.SlashCommandBuilder()
                .setName('nowplaying')
                .setDescription('Show what\'s currently playing')
                .toJSON(),
            new Discord.SlashCommandBuilder()
                .setName('clear')
                .setDescription('Clear the entire music queue')
                .toJSON(),
            goingLive.GOING_LIVE_COMMAND,
            ...economyCommandData(),
            ...memberBridgeCommandData(),
        ];

        // Clear old global commands (removes duplicates)
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: [] }
        );
        console.log('âœ… Cleared old global commands');

        // Register as guild commands (instant) instead of global (up to 1hr delay)
        const guild = client.guilds.cache.get(goingLive.GUILD_ID) || client.guilds.cache.first();
        if (guild) {
            await rest.put(
                Routes.applicationGuildCommands(client.user.id, guild.id),
                { body: commands }
            );
            console.log(`âœ… Slash commands registered for guild: ${guild.name}`);
        } else {
            // Fallback to global
            await rest.put(
                Routes.applicationCommands(client.user.id),
                { body: commands }
            );
            console.log('âœ… Slash commands registered globally');
        }
    } catch (error) {
        console.error('âŒ Error registering slash commands:', error);
    }

    // Start birthday checking (every minute)
    setInterval(checkBirthdays, 60000);
    checkBirthdays(); // Check immediately on startup

    // Railway exposes one HTTP port. MemberBridge owns it there; the legacy
    // moderation dashboard remains available only inside the Windows app.
    if (!RAILWAY_MODE) startKeepAliveServer();
    await memberBridgeIntegration.start();
});

// Name history tracking (persisted to disk)
const NAME_HISTORY_FILE = path.join(DATA_DIR, 'name-history.json');
let nameHistory = new Map(); // oduserId -> { names: [{ name, timestamp }] }

function loadNameHistory() {
    try {
        if (fs.existsSync(NAME_HISTORY_FILE)) {
            const raw = fs.readFileSync(NAME_HISTORY_FILE, 'utf-8');
            const data = JSON.parse(raw);
            nameHistory = new Map(Object.entries(data));
            console.log(`âœ… Loaded name history: ${nameHistory.size} users tracked`);
        }
    } catch (e) {
        console.error('âŒ Error loading name history:', e);
    }
}

function saveNameHistory() {
    try {
        fs.writeFileSync(NAME_HISTORY_FILE, JSON.stringify(Object.fromEntries(nameHistory)), 'utf-8');
    } catch (e) {
        console.error('âŒ Error saving name history:', e);
    }
}

loadNameHistory();

async function sendPreemptiveBanLog(member, snapshot, success, errorMessage = '') {
    const channelId = CONFIG.LOG_CHANNEL_ID || CONFIG.MOD_CHANNEL_ID;
    if (!channelId) return;

    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased()) return;

        const embed = new Discord.EmbedBuilder()
            .setColor(success ? '#B21F38' : '#D29B4B')
            .setTitle(success ? 'Preemptive Ban Enforced' : 'Preemptive Ban Failed')
            .setAuthor({ name: snapshot.tag, iconURL: snapshot.avatarUrl })
            .setThumbnail(snapshot.avatarUrl)
            .addFields(
                { name: 'Username', value: snapshot.username, inline: true },
                { name: 'Display Name', value: snapshot.displayName, inline: true },
                { name: 'User ID', value: snapshot.id, inline: true },
                { name: 'Account Created', value: `<t:${Math.floor(snapshot.createdTimestamp / 1000)}:F>`, inline: false },
                { name: 'Reason', value: CONFIG.PREEMPTIVE_BAN_REASON.substring(0, 1024), inline: false },
                { name: 'Result', value: success ? 'Banned immediately on join' : `Ban failed: ${errorMessage.substring(0, 900)}`, inline: false },
            )
            .setFooter({ text: 'The Commission â€¢ Preemptive Ban List' })
            .setTimestamp();

        await channel.send({ embeds: [embed] });
    } catch (error) {
        console.error('Error sending preemptive ban log:', error);
    }
}

async function enforcePreemptiveBan(member) {
    if (!PREEMPTIVE_BAN_USER_IDS.has(member.user.id)) return false;

    const snapshot = {
        id: member.user.id,
        username: member.user.username,
        tag: member.user.tag,
        displayName: member.displayName || member.user.globalName || member.user.username,
        avatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 256 }),
        createdTimestamp: member.user.createdTimestamp,
    };

    try {
        await member.ban({
            deleteMessageSeconds: 0,
            reason: CONFIG.PREEMPTIVE_BAN_REASON.substring(0, 512),
        });
        addAuditLog(
            'Preemptive Ban Enforced',
            member.user,
            `${snapshot.displayName} (${snapshot.id}) was banned on join. Reason: ${CONFIG.PREEMPTIVE_BAN_REASON}`,
            'error',
        );
        console.log(`Preemptive ban enforced for ${snapshot.tag} (${snapshot.id})`);
        await sendPreemptiveBanLog(member, snapshot, true);
        return true;
    } catch (error) {
        addAuditLog(
            'Preemptive Ban Failed',
            member.user,
            `${snapshot.displayName} (${snapshot.id}): ${error.message}`,
            'warning',
        );
        console.error(`Preemptive ban failed for ${snapshot.tag} (${snapshot.id}):`, error);
        await sendPreemptiveBanLog(member, snapshot, false, error.message);
        return false;
    }
}

// Alt account detection + name change detection on member join
client.on('guildMemberAdd', async (member) => {
    try {
        if (await enforcePreemptiveBan(member)) return;

        const userId = member.user.id;
        const currentName = member.user.tag;

        // Check name history for this user
        const history = nameHistory.get(userId);

        if (history) {
            // User has joined before - check if name changed
            const previousNames = history.names.map(n => n.name);
            const lastName = previousNames[previousNames.length - 1];

            if (lastName && lastName !== currentName) {
                // Name changed! Alert mod channel
                if (CONFIG.MOD_CHANNEL_ID) {
                    try {
                        const modChannel = await client.channels.fetch(CONFIG.MOD_CHANNEL_ID);
                        const embed = new Discord.EmbedBuilder()
                            .setColor('#FF9900')
                            .setTitle('ðŸ”„ Returning Member â€” Name Changed')
                            .setThumbnail(member.user.displayAvatarURL())
                            .addFields(
                                { name: 'Current Name', value: currentName, inline: true },
                                { name: 'Previous Name', value: lastName, inline: true },
                                { name: 'User ID', value: userId, inline: true },
                                { name: 'All Known Names', value: previousNames.join(', '), inline: false },
                                { name: 'Times Joined', value: `${history.names.length + 1}`, inline: true },
                                { name: 'Status', value: 'ðŸ” Review recommended', inline: true }
                            )
                            .setFooter({ text: 'Name Change Detection' })
                            .setTimestamp();

                        await modChannel.send({ embeds: [embed] });
                        addAuditLog('Name Change Detected', member.user, `Was: ${lastName} â†’ Now: ${currentName}`, 'warning');
                    } catch (e) {
                        console.error('âŒ Error sending name change alert:', e);
                    }
                }
            }

            // Add current name to history
            history.names.push({ name: currentName, timestamp: new Date().toISOString() });
        } else {
            // First time seeing this user
            nameHistory.set(userId, {
                names: [{ name: currentName, timestamp: new Date().toISOString() }]
            });
        }

        saveNameHistory();

        // Alt detection and automatic jail for newly created accounts.
        if (!CONFIG.ALT_DETECTION_ENABLED) return;

        const accountAge = Date.now() - member.user.createdTimestamp;
        const accountAgeDays = Math.floor(accountAge / (1000 * 60 * 60 * 24));

        if (accountAgeDays < CONFIG.ALT_ACCOUNT_AGE_DAYS) {
            let jailApplied = false;
            let jailStatus = 'Auto-jail failed: jail role is not configured';

            if (CONFIG.JAIL_ROLE_ID) {
                try {
                    await member.roles.add(
                        CONFIG.JAIL_ROLE_ID,
                        `Account is ${accountAgeDays} days old (under ${CONFIG.ALT_ACCOUNT_AGE_DAYS}-day minimum)`,
                    );
                    jailApplied = true;
                    jailStatus = 'Auto-jailed pending moderator review';
                    console.log(`Auto-jailed young account ${member.user.tag} (${member.user.id})`);
                } catch (jailError) {
                    jailStatus = `Auto-jail failed: ${jailError.message}`;
                    console.error(`Error auto-jailing ${member.user.tag} (${member.user.id}):`, jailError);
                }
            } else {
                console.error(`Cannot auto-jail ${member.user.tag}: JAIL_ROLE_ID is not configured`);
            }

            const modChannel = CONFIG.MOD_CHANNEL_ID
                ? await client.channels.fetch(CONFIG.MOD_CHANNEL_ID).catch(error => {
                    console.error(`Error fetching alt-alert channel ${CONFIG.MOD_CHANNEL_ID}:`, error);
                    return null;
                })
                : null;
            if (modChannel) {
                const embed = new Discord.EmbedBuilder()
                    .setColor('#FFA500')
                    .setTitle('âš ï¸ Potential Alt Account Detected')
                    .setThumbnail(member.user.displayAvatarURL())
                    .addFields(
                        { name: 'User', value: `${member.user.tag} (${member.user.id})`, inline: true },
                        { name: 'Account Age', value: `${accountAgeDays} days old`, inline: true },
                        { name: 'Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
                        { name: 'Joined', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`, inline: true },
                        { name: 'Default Avatar', value: member.user.avatar ? 'No' : '**Yes** âš ï¸', inline: true },
                        { name: 'Status', value: jailStatus, inline: false }
                    )
                    .setFooter({ text: 'Alt Detection System' })
                    .setTimestamp();

                await modChannel.send({ embeds: [embed] });
            }

            addAuditLog(
                jailApplied ? 'Young Account Auto-Jailed' : 'Young Account Auto-Jail Failed',
                member.user,
                `Account age: ${accountAgeDays} days | ${jailStatus}`,
                jailApplied ? 'warning' : 'error',
            );
        }

        addAuditLog('Member Joined', member.user, `Account age: ${accountAgeDays} days`, 'info');
    } catch (error) {
        console.error('Error in member join handler:', error);
    }
});

// ======================
// VOICE CHANNEL TRACKING
// ======================

// Persistent storage path
const LOGS_FILE = path.join(DATA_DIR, 'logs.json');

// Organized by date: 'YYYY-MM-DD' -> [entries]
let voiceLogs = new Map();
let memberLogs = new Map();
const voiceJoinTimes = new Map(); // `${userId}-${channelId}` -> joinTimestamp

// Load logs from disk on startup
function loadLogsFromDisk() {
    try {
        if (fs.existsSync(LOGS_FILE)) {
            const raw = fs.readFileSync(LOGS_FILE, 'utf-8');
            const data = JSON.parse(raw);

            if (data.voiceLogs) {
                voiceLogs = new Map(Object.entries(data.voiceLogs));
            }
            if (data.memberLogs) {
                memberLogs = new Map(Object.entries(data.memberLogs));
            }

            // Prune logs older than 30 days
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - 30);
            const cutoffKey = getDateKey(cutoff);

            for (const key of voiceLogs.keys()) {
                if (key < cutoffKey) voiceLogs.delete(key);
            }
            for (const key of memberLogs.keys()) {
                if (key < cutoffKey) memberLogs.delete(key);
            }

            const totalVoice = Array.from(voiceLogs.values()).reduce((sum, arr) => sum + arr.length, 0);
            const totalMember = Array.from(memberLogs.values()).reduce((sum, arr) => sum + arr.length, 0);
            console.log(`âœ… Loaded logs from disk: ${totalVoice} voice entries, ${totalMember} member entries across ${voiceLogs.size + memberLogs.size} days`);
        } else {
            console.log('ðŸ“ No existing logs file found, starting fresh');
        }
    } catch (error) {
        console.error('âŒ Error loading logs from disk:', error);
    }
}

// Save logs to disk
let saveTimer = null;
function saveLogsToDisk() {
    // Debounce: only save once per 5 seconds even if multiple events fire
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            const data = {
                voiceLogs: Object.fromEntries(voiceLogs),
                memberLogs: Object.fromEntries(memberLogs),
                lastSaved: new Date().toISOString(),
            };
            fs.writeFileSync(LOGS_FILE, JSON.stringify(data), 'utf-8');
        } catch (error) {
            console.error('âŒ Error saving logs to disk:', error);
        }
    }, 5000);
}

// Load on startup
loadLogsFromDisk();

function getDateKey(date) {
    return date.toISOString().split('T')[0]; // 'YYYY-MM-DD'
}

function addVoiceLog(entry) {
    const dateKey = getDateKey(new Date(entry.timestamp));
    if (!voiceLogs.has(dateKey)) voiceLogs.set(dateKey, []);
    voiceLogs.get(dateKey).unshift(entry);
    // Keep max 30 days
    if (voiceLogs.size > 30) {
        const oldest = Array.from(voiceLogs.keys()).sort()[0];
        voiceLogs.delete(oldest);
    }
    saveLogsToDisk();
}

function addMemberLog(entry) {
    const dateKey = getDateKey(new Date(entry.timestamp));
    if (!memberLogs.has(dateKey)) memberLogs.set(dateKey, []);
    memberLogs.get(dateKey).unshift(entry);
    if (memberLogs.size > 30) {
        const oldest = Array.from(memberLogs.keys()).sort()[0];
        memberLogs.delete(oldest);
    }
    saveLogsToDisk();
}

client.on('voiceStateUpdate', (oldState, newState) => {
    const user = newState.member?.user || oldState.member?.user;
    if (!user || user.bot) return;

    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

    // User joined a voice channel
    if (!oldState.channelId && newState.channelId) {
        const key = `${user.id}-${newState.channelId}`;
        voiceJoinTimes.set(key, Date.now());

        addVoiceLog({
            timestamp: now.toISOString(),
            userId: user.id,
            username: user.tag,
            action: 'joined',
            channelName: newState.channel?.name || 'Unknown',
            channelId: newState.channelId,
            duration: null,
            timeStr: timeStr,
        });
        console.log(`ðŸŽ¤ ${user.tag} joined voice: ${newState.channel?.name} at ${timeStr}`);
    }

    // User left a voice channel
    else if (oldState.channelId && !newState.channelId) {
        const key = `${user.id}-${oldState.channelId}`;
        const joinTime = voiceJoinTimes.get(key);
        let duration = null;

        if (joinTime) {
            const durationMs = Date.now() - joinTime;
            const hours = Math.floor(durationMs / 3600000);
            const mins = Math.floor((durationMs % 3600000) / 60000);
            const secs = Math.floor((durationMs % 60000) / 1000);
            duration = hours > 0 ? `${hours}h ${mins}m ${secs}s` : mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
            voiceJoinTimes.delete(key);
        }

        addVoiceLog({
            timestamp: now.toISOString(),
            userId: user.id,
            username: user.tag,
            action: 'left',
            channelName: oldState.channel?.name || 'Unknown',
            channelId: oldState.channelId,
            duration: duration,
            timeStr: timeStr,
        });
        console.log(`ðŸŽ¤ ${user.tag} left voice: ${oldState.channel?.name} at ${timeStr} - Duration: ${duration || 'unknown'}`);
    }

    // User switched channels
    else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
        const oldKey = `${user.id}-${oldState.channelId}`;
        const joinTime = voiceJoinTimes.get(oldKey);
        let duration = null;

        if (joinTime) {
            const durationMs = Date.now() - joinTime;
            const hours = Math.floor(durationMs / 3600000);
            const mins = Math.floor((durationMs % 3600000) / 60000);
            const secs = Math.floor((durationMs % 60000) / 1000);
            duration = hours > 0 ? `${hours}h ${mins}m ${secs}s` : mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
            voiceJoinTimes.delete(oldKey);
        }

        addVoiceLog({
            timestamp: now.toISOString(),
            userId: user.id,
            username: user.tag,
            action: 'switched',
            channelName: oldState.channel?.name || 'Unknown',
            toChannel: newState.channel?.name || 'Unknown',
            channelId: oldState.channelId,
            duration: duration,
            timeStr: timeStr,
        });

        // Start tracking new channel
        const newKey = `${user.id}-${newState.channelId}`;
        voiceJoinTimes.set(newKey, Date.now());

        console.log(`ðŸŽ¤ ${user.tag} switched: ${oldState.channel?.name} -> ${newState.channel?.name} at ${timeStr}`);
    }
});

// ======================
// MEMBER JOIN/LEAVE TRACKING
// ======================

client.on('guildMemberAdd', async (member) => {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

    addMemberLog({
        timestamp: now.toISOString(),
        userId: member.user.id,
        username: member.user.tag,
        action: 'joined',
        timeStr: timeStr,
    });
    console.log(`ðŸ“¥ ${member.user.tag} joined the server at ${timeStr}`);
});

client.on('guildMemberRemove', async (member) => {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

    addMemberLog({
        timestamp: now.toISOString(),
        userId: member.user.id,
        username: member.user.tag,
        action: 'left',
        timeStr: timeStr,
    });
    console.log(`ðŸ“¤ ${member.user.tag} left the server at ${timeStr}`);
});

// ======================
// MESSAGE MONITORING (Address Detection)
// ======================

client.on('messageCreate', async (message) => {
    // Debug: log ALL incoming messages so we can see if DMs arrive
    console.log(`ðŸ“© Message received - Author: ${message.author?.tag || 'unknown'} | Guild: ${message.guild?.name || 'DM'} | Content: ${message.content?.substring(0, 50) || '[empty]'} | Channel Type: ${message.channel.type}`);

    // Handle partial messages (needed for DMs in discord.js v14)
    if (message.partial) {
        try {
            await message.fetch();
        } catch (error) {
            console.error('âŒ Could not fetch partial message:', error);
            return;
        }
    }

    // Ignore bots
    if (message.author.bot) return;

    // DM handling - report system
    if (!message.guild) {
        await handleDMReport(message);
        return;
    }

    // Music text commands â€” check FIRST before any filters
    if (message.channel.id === MUSIC_CHANNEL_ID && message.content.startsWith('!')) {
        const args = message.content.slice(1).trim().split(/ +/);
        const command = args[0].toLowerCase();
        if (['play', 'skip', 'queue', 'np', 'nowplaying', 'clear'].includes(command)) {
            await handleMusicTextCommand(message, command, args.slice(1));
            return;
        }
    }

    // Staff are exempt from word filter
    const isStaffForFilter = message.member.roles.cache.some(role =>
        CONFIG.STAFF_ROLE_IDS.includes(role.id)
    ) || message.member.permissions.has(Discord.PermissionFlagsBits.Administrator);

    // Banned word detection (non-staff only)
    if (!isStaffForFilter) {
        const bannedWordResult = checkBannedWords(message.content);
        if (bannedWordResult) {
            if (isDoxWord(bannedWordResult)) {
                await message.delete().catch(() => {});
                await message.channel.send({
                    content: `${message.author} knock it off. **${bannedWordResult}** is filtered here. Your message was removed â€” you are not being jailed for using the word.`,
                    allowedMentions: { users: [message.author.id] },
                }).catch(() => null);
                addAuditLog('Dox Word Removed', message.author, `Word: "${bannedWordResult}" | No offense recorded and no jail applied`, 'warning');
                return;
            }
            await handleBannedWord(message, bannedWordResult);
            return;
        }
    }


    // Patrol channel enforcement (16hr cooldown + link filtering)
    if (message.channel.id === CONFIG.PATROL_CHANNEL_ID) {
        const patrolResult = await enforcePatrolRules(message);
        if (patrolResult.violated) {
            return; // Stop processing if rules violated
        }
    }

    // Track message for vibe check (only in main chat)
    if (message.channel.id === CONFIG.MAIN_CHAT_CHANNEL_ID) {
        recentMessages.push({
            timestamp: Date.now(),
            userId: message.author.id,
            content: message.content
        });

        // Keep only last 1000 messages
        if (recentMessages.length > MAX_MESSAGE_HISTORY) {
            recentMessages.shift();
        }
    }

    // Trivia answer checking
    if (currentTrivia && message.channel.id === CONFIG.MAIN_CHAT_CHANNEL_ID) {
        const userAnswer = message.content.trim().toLowerCase();
        const correctAnswer = currentTrivia.answer.toLowerCase();

        if (userAnswer === correctAnswer || userAnswer.includes(correctAnswer)) {
            // Correct answer!
            const userId = message.author.id;
            const currentScore = triviaScores.get(userId) || 0;
            triviaScores.set(userId, currentScore + 100);

            const embed = new Discord.EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('ðŸŽ‰ Correct Answer!')
                .setDescription(`${message.author} got it right!\n\n**Answer:** ${currentTrivia.answer}\n**Points:** +100 (Total: ${currentScore + 100})`)
                .setTimestamp();

            await message.channel.send({ embeds: [embed] });
            addAuditLog('Trivia Answered', message.author, `Correct answer! New score: ${currentScore + 100}`, 'success');
            currentTrivia = null;
            return;
        }
    }

    // Check if user is staff
    const isStaff = message.member.roles.cache.some(role => CONFIG.STAFF_ROLE_IDS.includes(role.id));

    // Address detection for non-staff only (OpenStreetMap-verified)
    if (!isStaff && !isStaffForFilter) {
        if (await checkAddressAPI(message)) return;
    }

    // Commands (work in server channels)
    if (message.content.startsWith('!')) {
        const args = message.content.slice(1).trim().split(/ +/);
        const command = args[0].toLowerCase();

        // Public commands (everyone can use)
        if (command === 'birthday') {
            await handleBirthdayCommand(message);
            return;
        }

        if (command === 'vibecheck') {
            await performVibeCheck(message);
            return;
        }

        // Staff-only commands
        await handleStaffCommands(message);
    }
});

// Patrol channel enforcement
async function enforcePatrolRules(message) {
    // Staff are exempt from patrol rules
    const isStaff = message.member.roles.cache.some(role => CONFIG.STAFF_ROLE_IDS.includes(role.id));
    if (isStaff) {
        return { violated: false };
    }

    const now = Date.now();
    const userId = message.author.id;
    const lastPost = patrolCooldowns.get(userId);

    // Check cooldown (16 hours)
    if (lastPost) {
        const timeSince = now - lastPost;
        const timeRemaining = PATROL_COOLDOWN - timeSince;

        if (timeRemaining > 0) {
            // Still on cooldown
            const hoursRemaining = Math.floor(timeRemaining / (60 * 60 * 1000));
            const minutesRemaining = Math.floor((timeRemaining % (60 * 60 * 1000)) / (60 * 1000));

            try {
                await message.delete();

                const warningMsg = await message.channel.send(
                    `${message.author} âš ï¸ **Cooldown Active!**\n\n` +
                    `You can only post once every **16 hours** in this channel.\n` +
                    `Time remaining: **${hoursRemaining}h ${minutesRemaining}m**\n\n` +
                    `*Your message has been removed.*`
                );

                // Delete warning after 10 seconds
                setTimeout(() => {
                    warningMsg.delete().catch(() => {});
                }, 10000);

                addAuditLog('Patrol Violation', message.author, `Cooldown violation - ${hoursRemaining}h ${minutesRemaining}m remaining`, 'warning');

            } catch (error) {
                console.error('Error enforcing patrol cooldown:', error);
            }

            return { violated: true };
        }
    }

    // Check for valid links (YouTube, Twitch, Kick.com only)
    const urlRegex = /(https?:\/\/[^\s]+)/gi;
    const urls = message.content.match(urlRegex);

    if (urls && urls.length > 0) {
        const allowedDomains = [
            'youtube.com',
            'youtu.be',
            'twitch.tv',
            'kick.com',
            'www.youtube.com',
            'www.twitch.tv',
            'www.kick.com'
        ];

        let hasInvalidLink = false;

        for (const url of urls) {
            const isAllowed = allowedDomains.some(domain => url.toLowerCase().includes(domain));
            if (!isAllowed) {
                hasInvalidLink = true;
                break;
            }
        }

        if (hasInvalidLink) {
            try {
                await message.delete();

                const warningMsg = await message.channel.send(
                    `${message.author} âš ï¸ **Invalid Link!**\n\n` +
                    `Only **YouTube**, **Twitch**, and **Kick.com** links are allowed in this channel.\n\n` +
                    `*Your message has been removed.*`
                );

                // Delete warning after 10 seconds
                setTimeout(() => {
                    warningMsg.delete().catch(() => {});
                }, 10000);

                addAuditLog('Patrol Violation', message.author, `Invalid link posted`, 'warning');

            } catch (error) {
                console.error('Error enforcing patrol links:', error);
            }

            return { violated: true };
        }
    }

    // All checks passed - update cooldown
    patrolCooldowns.set(userId, now);
    addAuditLog('Patrol Post', message.author, `Post allowed in patrol channel`, 'info');

    return { violated: false };
}

// ======================
// BANNED WORD CHECKER + AUTO-JAIL
// ======================

function checkBannedWords(text) {
    const lowerText = text.toLowerCase();

    // Check multi-word phrases first (longer matches first)
    const sortedWords = [...bannedWords].sort((a, b) => b.length - a.length);

    for (const word of sortedWords) {
        const lowerWord = word.toLowerCase();
        // Use word boundary check for single words, includes for phrases
        if (lowerWord.includes(' ')) {
            // Multi-word phrase
            if (lowerText.includes(lowerWord)) return word;
        } else {
            // Single word - check with basic boundary detection
            const regex = new RegExp('\\b' + lowerWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
            if (regex.test(text)) return word;
        }
    }
    return null;
}

async function handleBannedWord(message, triggeredWord) {
    const userId = message.author.id;
    const guild = message.guild;

    try {
        // Delete the message
        await message.delete();
        console.log(`ðŸš« Banned word "${triggeredWord}" detected from ${message.author.tag}`);

        // Track offenses
        const currentOffenses = (offenseTracker.get(userId) || 0) + 1;
        offenseTracker.set(userId, currentOffenses);
        saveBannedWordsToDisk();

        // Determine jail duration based on offense count
        let jailDuration;
        let jailLabel;
        if (currentOffenses === 1) {
            jailDuration = 5 * 60 * 1000; // 5 minutes
            jailLabel = '5 minutes (1st offense)';
        } else if (currentOffenses === 2) {
            jailDuration = 30 * 60 * 1000; // 30 minutes
            jailLabel = '30 minutes (2nd offense)';
        } else {
            jailDuration = null; // Permanent (until unjailed)
            jailLabel = 'Permanent (3rd+ offense)';
        }

        // Apply jail - deny view on both categories
        const targetMember = message.member;

        // Assign jail role
        try {
            await targetMember.roles.add(JAIL_ROLE_ID);
            console.log(`âœ… Jail role added to ${message.author.tag} (auto-jail)`);
        } catch (err) {
            console.error('âŒ Error adding jail role:', err);
        }

        for (const categoryId of JAIL_CATEGORY_IDS) {
            try {
                const category = await guild.channels.fetch(categoryId);
                if (!category) continue;

                await category.permissionOverwrites.edit(userId, {
                    ViewChannel: false, SendMessages: false, Connect: false,
                });

                const children = guild.channels.cache.filter(ch => ch.parentId === categoryId);
                for (const [, child] of children) {
                    await child.permissionOverwrites.edit(userId, {
                        ViewChannel: false, SendMessages: false, Connect: false,
                    });
                }
            } catch (err) {
                console.error(`âŒ Error jailing from category ${categoryId}:`, err);
            }
        }

        // Create jail channel
        const ticketNumber = Math.floor(Math.random() * 9999);
        const channelName = `jail-${message.author.username.substring(0, 15)}-${ticketNumber}`;

        try {
            const jailChannel = await guild.channels.create({
                name: channelName,
                type: Discord.ChannelType.GuildText,
                parent: JAIL_CATEGORY_ID,
                permissionOverwrites: [
                    { id: guild.id, deny: [Discord.PermissionFlagsBits.ViewChannel] },
                    { id: userId, allow: [Discord.PermissionFlagsBits.ViewChannel, Discord.PermissionFlagsBits.SendMessages, Discord.PermissionFlagsBits.ReadMessageHistory] },
                    ...staffPermissionOverwrites(guild),
                ],
            });

            jailChannels.set(userId, jailChannel.id);

            const embed = new Discord.EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('ðŸš« Auto-Jailed: Banned Word')
                .setThumbnail(message.author.displayAvatarURL())
                .addFields(
                    { name: 'User', value: `${message.author.tag} (${userId})`, inline: true },
                    { name: 'Channel', value: `<#${message.channelId}>`, inline: true },
                    { name: 'Triggered Word', value: `||${triggeredWord}||`, inline: true },
                    { name: 'Offense #', value: `${currentOffenses}`, inline: true },
                    { name: 'Jail Duration', value: jailLabel, inline: true },
                    { name: 'Message Content', value: `||${message.content.substring(0, 200)}||` }
                )
                .setFooter({ text: jailDuration ? 'Will auto-unjail when time expires' : 'Use /unjail to release' })
                .setTimestamp();

            await jailChannel.send({ content: staffMentions(guild, userId), embeds: [embed] });
            console.log(`âœ… Jail channel created: #${jailChannel.name}`);

        } catch (err) {
            console.error('âŒ Error creating auto-jail channel:', err);
        }

        // If timed jail, schedule unjail
        if (jailDuration) {
            setTimeout(async () => {
                try {
                    for (const categoryId of JAIL_CATEGORY_IDS) {
                        const category = await guild.channels.fetch(categoryId);
                        if (!category) continue;

                        await category.permissionOverwrites.delete(userId).catch(() => {});

                        const children = guild.channels.cache.filter(ch => ch.parentId === categoryId);
                        for (const [, child] of children) {
                            await child.permissionOverwrites.delete(userId).catch(() => {});
                        }
                    }
                    // Remove jail role
                    try {
                        const member = await guild.members.fetch(userId);
                        await member.roles.remove(JAIL_ROLE_ID);
                        console.log(`âœ… Jail role removed from ${message.author.tag} (auto-unjail)`);
                    } catch (roleErr) {
                        console.error('âŒ Error removing jail role on auto-unjail:', roleErr);
                    }

                    // Archive jail channel
                    const jailChanId = jailChannels.get(userId);
                    if (jailChanId) {
                        try {
                            const jailChan = await guild.channels.fetch(jailChanId);
                            if (jailChan) {
                                const msgs = await jailChan.messages.fetch({ limit: 100 });
                                const transcript = msgs.reverse().map(m => `[${m.createdAt.toISOString()}] ${m.author.tag}: ${m.content}`).join('\n');

                                const logChannel = await client.channels.fetch(JAIL_LOG_CHANNEL_ID);
                                if (logChannel) {
                                    const buf = Buffer.from(transcript, 'utf-8');
                                    const att = new Discord.AttachmentBuilder(buf, { name: `${jailChan.name}-transcript.txt` });
                                    const logEmbed = new Discord.EmbedBuilder()
                                        .setColor('#00FF00')
                                        .setTitle(`ðŸ”“ Auto-Unjailed: ${message.author.tag}`)
                                        .addFields(
                                            { name: 'User', value: `${message.author.tag} (${userId})`, inline: true },
                                            { name: 'Duration', value: jailLabel, inline: true },
                                        )
                                        .setFooter({ text: 'Transcript attached below' })
                                        .setTimestamp();
                                    await logChannel.send({ embeds: [logEmbed], files: [att] });
                                }

                                await jailChan.send('ðŸ”“ Auto-unjail complete. This channel will be deleted in 5 seconds...');
                                setTimeout(() => jailChan.delete().catch(() => {}), 5000);
                            }
                        } catch (e) {
                            console.error('âŒ Error archiving auto-jail channel:', e);
                        }
                        jailChannels.delete(userId);
                    }

                    console.log(`âœ… Auto-unjailed ${message.author.tag} after ${jailLabel}`);
                    addAuditLog('Auto-Unjailed', { tag: message.author.tag, id: userId }, `Auto-unjailed after ${jailLabel}`, 'success');
                } catch (err) {
                    console.error('âŒ Error auto-unjailing:', err);
                }
            }, jailDuration);
        }

        addAuditLog('Banned Word Jail', { tag: message.author.tag, id: userId }, `Word: "${triggeredWord}" | Offense #${currentOffenses} | Duration: ${jailLabel}`, 'warning');

    } catch (error) {
        console.error('âŒ Error handling banned word:', error);
    }
}

// ======================
// ADDRESS DETECTION (OpenStreetMap Nominatim)
// ======================

// Pre-filter: could this message contain an address?
function mightContainAddress(text) {
    if (text.length < 12) return false;

    // Must contain a number
    if (!/\d/.test(text)) return false;

    // Skip URLs, code blocks, bot commands, emojis-heavy messages
    if (/https?:\/\/|discord\.gg|```|!config|!help|!trivia|!birthday/.test(text)) return false;

    const hasStreetWord = /\b(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way|place|pl|circle|cir|trail|trl|parkway|pkwy|highway|hwy|terrace|ter|pike|crossing|loop)\b/i.test(text);
    const hasZip = /\b\d{5}(-\d{4})?\b/.test(text);
    const hasState = /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/.test(text);
    const hasCommaCity = /,\s*[A-Z][a-z]+/.test(text);
    const hasNumberStreet = /\d{1,5}\s+[A-Z]\w+/.test(text); // "123 Main" (capitalized word after number)

    // Count how many address components are present
    let score = 0;
    if (hasStreetWord) score++;
    if (hasZip) score++;
    if (hasState) score++;
    if (hasCommaCity) score++;
    if (hasNumberStreet) score++;

    // Need at least 3 address components to be worth checking
    // This prevents "8 Straight hours drive" (only has street word + number = 2)
    // But catches "120 Commercial Pkwy, Branford, CT 06405" (street + comma + state + zip + number = 5)
    if (score >= 3) return true;

    return false;
}

// Extract potential address chunks from text
function extractAddressCandidates(text) {
    const candidates = [];

    // Try the full message (cleaned up)
    const cleaned = text.replace(/\n/g, ', ').trim();
    if (cleaned.length >= 8 && cleaned.length <= 200) {
        candidates.push(cleaned);
    }

    // Extract segments starting with a number followed by words
    const segments = text.match(/\d{1,5}\s+[\w\s,.']+/g);
    if (segments) {
        for (const seg of segments) {
            const trimmed = seg.trim().substring(0, 150);
            if (trimmed.length >= 8) candidates.push(trimmed);
        }
    }

    // Try each line separately
    const lines = text.split('\n').filter(l => l.trim().length >= 8 && /\d/.test(l));
    candidates.push(...lines.map(l => l.trim()));

    return [...new Set(candidates)].slice(0, 5); // Max 5 candidates
}

// Main address check function
async function checkAddressAPI(message) {
    try {
        if (!mightContainAddress(message.content)) return false;

        const candidates = extractAddressCandidates(message.content);
        if (candidates.length === 0) return false;

        console.log(`Checking ${candidates.length} potential address candidate(s) from ${message.author.tag}`);

        for (const candidate of candidates) {
            const result = await verifyAddressWithFreeGeocoders(candidate);

            if (result && result.verified) {
                console.log(`Verified exact street address from ${message.author.tag} via ${result.provider}`);
                await handleAddressDetection(message, candidate, result);
                return true;
            }
        }
        return false;
    } catch (error) {
        console.error('Error in Google address check:', error);
        return false;
    }
}

async function handleAddressDetection(message, addressText, apiResult) {
    try {
        const userId = message.author.id;
        const guild = message.guild;

        // Delete the message immediately
        await message.delete();
        console.log('âœ… Address message deleted');

        // Jail the user
        try {
            const member = await guild.members.fetch(userId);
            await member.roles.add(JAIL_ROLE_ID);

            // Deny view on categories
            for (const categoryId of JAIL_CATEGORY_IDS) {
                try {
                    const category = await guild.channels.fetch(categoryId);
                    if (!category) continue;
                    await category.permissionOverwrites.edit(userId, {
                        ViewChannel: false, SendMessages: false, Connect: false,
                    });
                    const children = guild.channels.cache.filter(ch => ch.parentId === categoryId);
                    for (const [, child] of children) {
                        await child.permissionOverwrites.edit(userId, {
                            ViewChannel: false, SendMessages: false, Connect: false,
                        });
                    }
                } catch (e) {}
            }

            // Create jail channel
            const ticketNumber = Math.floor(Math.random() * 9999);
            const channelName = `jail-doxx-${message.author.username.substring(0, 10)}-${ticketNumber}`;

            const jailChannel = await guild.channels.create({
                name: channelName,
                type: Discord.ChannelType.GuildText,
                parent: JAIL_CATEGORY_ID,
                permissionOverwrites: [
                    { id: guild.id, deny: [Discord.PermissionFlagsBits.ViewChannel] },
                    { id: userId, allow: [Discord.PermissionFlagsBits.ViewChannel, Discord.PermissionFlagsBits.SendMessages, Discord.PermissionFlagsBits.ReadMessageHistory] },
                    ...staffPermissionOverwrites(guild),
                ],
            });

            jailChannels.set(userId, jailChannel.id);

            const embed = new Discord.EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('ðŸš¨ Address Posted â€” User Jailed')
                .setThumbnail(message.author.displayAvatarURL())
                .addFields(
                    { name: 'User', value: `${message.author.tag} (${userId})`, inline: true },
                    { name: 'Channel', value: `<#${message.channelId}>`, inline: true },
                    { name: 'Verified Address', value: `||${apiResult.displayName}||` },
                    { name: 'Confidence', value: `${Math.round(apiResult.confidence * 100)}%`, inline: true },
                    { name: 'Original Text', value: `||${addressText.substring(0, 200)}||` },
                    { name: 'Status', value: 'ðŸ”’ Permanently jailed â€” use /unjail to release', inline: true }
                )
                .setFooter({ text: `Address verified via ${apiResult.provider || 'Google Maps Geocoding API'}` })
                .setTimestamp();

            await jailChannel.send({ content: staffMentions(guild, userId), embeds: [embed] });

            console.log(`âœ… User ${message.author.tag} jailed for posting address`);

        } catch (jailError) {
            console.error('âŒ Error jailing address poster:', jailError);
        }

        addAuditLog('Address Detected', message.author, `Verified address: ${apiResult.displayName.substring(0, 80)} - User jailed`, 'error');

    } catch (error) {
        console.error('âŒ Error handling address detection:', error);
    }
}

// ======================
// DM REPORT SYSTEM
// ======================

const dmReportStates = new Map(); // userId -> { step, who, reason }

async function handleDMReport(message) {
    const userId = message.author.id;
    const state = dmReportStates.get(userId);

    try {
        if (!state) {
            await message.reply('ðŸ‘¤ **Who are you reporting?** (Username or @mention)');
            dmReportStates.set(userId, { step: 'who' });
            console.log(`ðŸ“ DM Report started by ${message.author.tag}`);
            return;
        }

        if (state.step === 'who') {
            state.who = message.content;
            state.step = 'reason';
            await message.reply('ðŸ“„ **Why are you reporting them?** (Describe what happened)');
            return;
        }

        if (state.step === 'reason') {
            state.reason = message.content;
            dmReportStates.delete(userId);
            await createDMReport(message.author, state);
            return;
        }
    } catch (error) {
        console.error('âŒ Error in DM report system:', error);
        dmReportStates.delete(userId);
        try {
            await message.reply('âŒ Something went wrong. Please try again or use `/report` in the server.');
        } catch (e) {}
    }
}

async function createDMReport(user, state) {
    const guild = client.guilds.cache.first();
    if (!guild) {
        await user.send('âŒ Error creating report. Bot is not connected to a server.');
        return;
    }

    const ticketNumber = Math.floor(Math.random() * 9999);
    const channelName = `report-${ticketNumber}`;

    try {
        const channel = await guild.channels.create({
            name: channelName,
            type: Discord.ChannelType.GuildText,
            parent: REPORT_CATEGORY_ID,
            permissionOverwrites: [
                { id: guild.id, deny: [Discord.PermissionFlagsBits.ViewChannel] },
                { id: user.id, allow: [Discord.PermissionFlagsBits.ViewChannel, Discord.PermissionFlagsBits.SendMessages, Discord.PermissionFlagsBits.ReadMessageHistory] },
                ...staffPermissionOverwrites(guild),
            ],
        });

        const embed = new Discord.EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('ðŸš¨ New User Report (via DM)')
            .setThumbnail(user.displayAvatarURL())
            .addFields(
                { name: 'Reported By', value: `${user.tag} (${user.id})`, inline: true },
                { name: 'Reporting', value: state.who, inline: true },
                { name: 'Reason', value: state.reason },
                { name: 'Status', value: 'ðŸ” Awaiting mod review', inline: true }
            )
            .setFooter({ text: 'Use !close or /close to archive this report' })
            .setTimestamp();

        await channel.send({ content: `${staffMentions(guild, user.id)}\n\nMods will be with you shortly. You can chat here.`, embeds: [embed] });

        addAuditLog('DM Report Created', { tag: user.tag, id: user.id }, `Report #${ticketNumber} against ${state.who}`, 'warning');

        await user.send(`âœ… Your report has been created! Head to <#${channel.id}> to chat with the mods.`);

    } catch (error) {
        console.error('âŒ Error creating DM report:', error);
        try {
            await user.send('âŒ Error creating the report. Please try `/report` in the server.');
        } catch (e) {}
    }
}

// ======================
// /REPORT SLASH COMMAND
// ======================

const REPORT_CATEGORY_ID = CONFIG.REPORT_CATEGORY_ID;
const OLD_REPORTS_CHANNEL_ID = CONFIG.OLD_REPORTS_CHANNEL_ID;

const JAIL_CATEGORY_IDS = CONFIG.JAIL_CATEGORY_IDS;

client.on('interactionCreate', async (interaction) => {
    try {
        if (await memberBridgeIntegration.handleButton(interaction)) return;
        if (await economyIntegration.handleButton(interaction)) return;
        if (!interaction.isChatInputCommand()) return;
        if (await memberBridgeIntegration.handleCommand(interaction)) return;
        if (await economyIntegration.handleCommand(interaction)) return;

        if (interaction.commandName === 'report') {
            await handleReportCommand(interaction);
        } else if (interaction.commandName === 'jail') {
            await handleJailCommand(interaction);
        } else if (interaction.commandName === 'unjail') {
            await handleUnjailCommandV2(interaction);
        } else if (interaction.commandName === 'close') {
            await handleCloseCommand(interaction);
        } else if (['join', 'leave', 'play', 'skip', 'queue', 'nowplaying', 'clear'].includes(interaction.commandName)) {
            await handleMusicCommand(interaction);
        }
    } catch (error) {
        console.error('âŒ Error in slash command:', error);
        try {
            if (interaction.deferred) {
                await interaction.editReply({ content: 'âŒ Something went wrong. Please try again.' });
            } else {
                await interaction.reply({ content: 'âŒ Something went wrong. Please try again.', ephemeral: true });
            }
        } catch (e) {
            console.error('âŒ Could not send error reply:', e);
        }
    }
});

// ======================
// /REPORT HANDLER
// ======================

async function handleReportCommand(interaction) {
    console.log(`ðŸ“ /report interaction received from ${interaction.user?.tag}`);

    await interaction.deferReply({ ephemeral: true });

    const reportedUser = interaction.options.getString('user');
    const reason = interaction.options.getString('reason');
    const reporter = interaction.user;
    const guild = interaction.guild;

    console.log(`ðŸ“ /report - Reporting: ${reportedUser} - Reason: ${reason}`);
    console.log(`   Staff Role IDs: ${CONFIG.STAFF_ROLE_IDS.join(', ') || 'NONE'}`);

    const ticketNumber = Math.floor(Math.random() * 9999);
    const channelName = `report-${ticketNumber}`;

    // Build permissions: hidden from everyone, visible to reporter + configured staff roles.
    const permissionOverwrites = [
        {
            id: guild.id,
            deny: [Discord.PermissionFlagsBits.ViewChannel],
        },
        {
            id: reporter.id,
            allow: [Discord.PermissionFlagsBits.ViewChannel, Discord.PermissionFlagsBits.SendMessages, Discord.PermissionFlagsBits.ReadMessageHistory],
        },
        ...staffPermissionOverwrites(guild),
    ];

    const channel = await guild.channels.create({
        name: channelName,
        type: Discord.ChannelType.GuildText,
        parent: REPORT_CATEGORY_ID,
        permissionOverwrites,
    });

    console.log(`âœ… Report channel created: #${channel.name}`);

    const embed = new Discord.EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('ðŸš¨ New User Report')
        .setThumbnail(reporter.displayAvatarURL())
        .addFields(
            { name: 'Reported By', value: `${reporter.tag} (${reporter.id})`, inline: true },
            { name: 'Reporting', value: reportedUser, inline: true },
            { name: 'Reason', value: reason },
            { name: 'Status', value: 'ðŸ” Awaiting mod review', inline: true }
        )
        .setFooter({ text: 'Use !close to archive this report' })
        .setTimestamp();

    // Ping mod roles and the reporter
    await channel.send({ content: `${staffMentions(guild, reporter.id)}\n\nMods will be with you shortly. You can chat here.`, embeds: [embed] });

    addAuditLog('Report Created', { tag: reporter.tag, id: reporter.id }, `Report #${ticketNumber} against ${reportedUser}`, 'warning');

    await interaction.editReply({ content: `âœ… Your report has been created! Head to <#${channel.id}> to chat with the mods.` });
}

// ======================
// /JAIL HANDLER
// ======================

const JAIL_CATEGORY_ID = CONFIG.JAIL_CATEGORY_ID;
const JAIL_ROLE_ID = CONFIG.JAIL_ROLE_ID;
const JAIL_LOG_CHANNEL_ID = CONFIG.JAIL_LOG_CHANNEL_ID;

// Track jail channels: userId -> channelId
const jailChannels = new Map();

async function handleJailCommand(interaction) {
    const isStaff = interaction.member.roles.cache.some(role =>
        CONFIG.STAFF_ROLE_IDS.includes(role.id)
    ) || interaction.member.permissions.has(Discord.PermissionFlagsBits.Administrator);

    if (!isStaff) {
        await interaction.reply({ content: 'âŒ You do not have permission to use this command.', ephemeral: true });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const durationChoice = interaction.options.getString('duration') || 'perm';
    const guild = interaction.guild;
    const targetMember = await guild.members.fetch(targetUser.id);

    // Parse duration
    const DURATION_MAP = {
        '5m': { ms: 5 * 60 * 1000, label: '5 minutes' },
        '30m': { ms: 30 * 60 * 1000, label: '30 minutes' },
        '1h': { ms: 60 * 60 * 1000, label: '1 hour' },
        '6h': { ms: 6 * 60 * 60 * 1000, label: '6 hours' },
        '12h': { ms: 12 * 60 * 60 * 1000, label: '12 hours' },
        '24h': { ms: 24 * 60 * 60 * 1000, label: '24 hours' },
        'perm': { ms: null, label: 'Permanent' },
    };
    const duration = DURATION_MAP[durationChoice] || DURATION_MAP['perm'];

    console.log(`ðŸ”’ /jail used by ${interaction.user.tag} on ${targetUser.tag} - Duration: ${duration.label}`);

    const jailParent = await guild.channels.fetch(JAIL_CATEGORY_ID).catch(() => null);
    if (!jailParent || jailParent.type !== Discord.ChannelType.GuildCategory) {
        await interaction.editReply({
            content: `âŒ Jail category <#${JAIL_CATEGORY_ID}> does not exist in this server or is not a category. Update Protection â†’ Jail room category ID, save, and restart the bot.`,
        });
        return;
    }

    // Assign jail role
    try {
        await targetMember.roles.add(JAIL_ROLE_ID);
        console.log(`âœ… Jail role added to ${targetUser.tag}`);
    } catch (err) {
        console.error('âŒ Error adding jail role:', err);
    }

    // Deny view on text & voice categories
    let categoriesUpdated = 0;
    for (const categoryId of JAIL_CATEGORY_IDS) {
        try {
            const category = await guild.channels.fetch(categoryId);
            if (!category) continue;

            await category.permissionOverwrites.edit(targetUser.id, {
                ViewChannel: false, SendMessages: false, Connect: false,
            });

            const children = guild.channels.cache.filter(ch => ch.parentId === categoryId);
            for (const [, child] of children) {
                await child.permissionOverwrites.edit(targetUser.id, {
                    ViewChannel: false, SendMessages: false, Connect: false,
                });
            }
            categoriesUpdated++;
        } catch (error) {
            console.error(`âŒ Error jailing from category ${categoryId}:`, error);
        }
    }

    // Create jail channel under jail category
    const ticketNumber = Math.floor(Math.random() * 9999);
    const channelName = `jail-${targetUser.username.substring(0, 15)}-${ticketNumber}`;

    try {
        const jailChannel = await guild.channels.create({
            name: channelName,
            type: Discord.ChannelType.GuildText,
            parent: jailParent.id,
            topic: `commission-jail-user:${targetUser.id}`,
            permissionOverwrites: [
                { id: guild.id, deny: [Discord.PermissionFlagsBits.ViewChannel] },
                { id: targetUser.id, allow: [Discord.PermissionFlagsBits.ViewChannel, Discord.PermissionFlagsBits.SendMessages, Discord.PermissionFlagsBits.ReadMessageHistory] },
                ...staffPermissionOverwrites(guild),
            ],
        });

        // Track this jail channel
        jailChannels.set(targetUser.id, jailChannel.id);

        const embed = new Discord.EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('ðŸ”’ You Have Been Jailed')
            .setThumbnail(targetUser.displayAvatarURL())
            .addFields(
                { name: 'User', value: `${targetUser.tag} (${targetUser.id})`, inline: true },
                { name: 'Jailed By', value: `${interaction.user.tag}`, inline: true },
                { name: 'Reason', value: reason },
                { name: 'Duration', value: duration.label, inline: true },
                { name: 'Status', value: duration.ms ? 'â±ï¸ Timed jail' : 'ðŸ”’ Permanent â€” use /unjail to release', inline: true }
            )
            .setFooter({ text: duration.ms ? 'Will auto-unjail when time expires' : 'Staff can use /unjail to restore access' })
            .setTimestamp();

        await jailChannel.send({ content: staffMentions(guild, targetUser.id), embeds: [embed] });

        console.log(`âœ… Jail channel created: #${jailChannel.name}`);

        await interaction.editReply({ content: `âœ… ${targetUser.tag} has been jailed for ${duration.label}. Jail channel: <#${jailChannel.id}>` });

        // Auto-unjail timer for timed jails
        if (duration.ms) {
            setTimeout(async () => {
                try {
                    // Remove jail role
                    try {
                        const member = await guild.members.fetch(targetUser.id);
                        await member.roles.remove(JAIL_ROLE_ID);
                    } catch (e) {}

                    // Restore categories
                    for (const catId of JAIL_CATEGORY_IDS) {
                        try {
                            const cat = await guild.channels.fetch(catId);
                            if (!cat) continue;
                            await cat.permissionOverwrites.delete(targetUser.id).catch(() => {});
                            const kids = guild.channels.cache.filter(ch => ch.parentId === catId);
                            for (const [, kid] of kids) {
                                await kid.permissionOverwrites.delete(targetUser.id).catch(() => {});
                            }
                        } catch (e) {}
                    }

                    // Archive jail channel
                    const jChanId = jailChannels.get(targetUser.id);
                    if (jChanId) {
                        try {
                            const jChan = await guild.channels.fetch(jChanId);
                            if (jChan) {
                                const msgs = await jChan.messages.fetch({ limit: 100 });
                                const transcript = msgs.reverse().map(m => `[${m.createdAt.toISOString()}] ${m.author.tag}: ${m.content}`).join('\n');

                                const logCh = await client.channels.fetch(JAIL_LOG_CHANNEL_ID);
                                if (logCh) {
                                    const buf = Buffer.from(transcript, 'utf-8');
                                    const att = new Discord.AttachmentBuilder(buf, { name: `${jChan.name}-transcript.txt` });
                                    const logEmbed = new Discord.EmbedBuilder()
                                        .setColor('#00FF00')
                                        .setTitle(`ðŸ”“ Auto-Unjailed: ${targetUser.tag}`)
                                        .addFields(
                                            { name: 'User', value: `${targetUser.tag} (${targetUser.id})`, inline: true },
                                            { name: 'Duration', value: duration.label, inline: true },
                                        )
                                        .setFooter({ text: 'Transcript attached' })
                                        .setTimestamp();
                                    await logCh.send({ embeds: [logEmbed], files: [att] });
                                }

                                await jChan.send('ðŸ”“ Jail time expired. This channel will be deleted in 5 seconds...');
                                setTimeout(() => jChan.delete().catch(() => {}), 5000);
                            }
                        } catch (e) {
                            console.error('âŒ Error archiving auto-unjail channel:', e);
                        }
                        jailChannels.delete(targetUser.id);
                    }

                    console.log(`âœ… Auto-unjailed ${targetUser.tag} after ${duration.label}`);
                    addAuditLog('Auto-Unjailed', { tag: targetUser.tag, id: targetUser.id }, `Auto-unjailed after ${duration.label}`, 'success');
                } catch (err) {
                    console.error('âŒ Error in auto-unjail timer:', err);
                }
            }, duration.ms);
        }

    } catch (error) {
        console.error('âŒ Error creating jail channel:', error);
        await interaction.editReply({ content: `âœ… ${targetUser.tag} has been jailed (but could not create jail channel: ${error.message})` });
    }

    addAuditLog('User Jailed', interaction.user, `Jailed ${targetUser.tag} - Reason: ${reason}`, 'warning');
}

// ======================
// /UNJAIL HANDLER
// ======================

async function handleUnjailCommand(interaction) {
    const isStaff = interaction.member.roles.cache.some(role =>
        CONFIG.STAFF_ROLE_IDS.includes(role.id)
    ) || interaction.member.permissions.has(Discord.PermissionFlagsBits.Administrator);

    if (!isStaff) {
        await interaction.reply({ content: 'âŒ You do not have permission to use this command.', ephemeral: true });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user');
    const guild = interaction.guild;

    console.log(`ðŸ”“ /unjail used by ${interaction.user.tag} on ${targetUser.tag}`);

    // Remove jail role
    try {
        const targetMember = await guild.members.fetch(targetUser.id);
        await targetMember.roles.remove(JAIL_ROLE_ID);
        console.log(`âœ… Jail role removed from ${targetUser.tag}`);
    } catch (err) {
        console.error('âŒ Error removing jail role:', err);
    }

    // Restore categories
    for (const categoryId of JAIL_CATEGORY_IDS) {
        try {
            const category = await guild.channels.fetch(categoryId);
            if (!category) continue;
            await category.permissionOverwrites.delete(targetUser.id).catch(() => {});
            const children = guild.channels.cache.filter(ch => ch.parentId === categoryId);
            for (const [, child] of children) {
                await child.permissionOverwrites.delete(targetUser.id).catch(() => {});
            }
        } catch (error) {
            console.error(`âŒ Error unjailing from category ${categoryId}:`, error);
        }
    }

    // Find and archive the jail channel
    const jailChannelId = jailChannels.get(targetUser.id);
    let jailChannel = null;

    if (jailChannelId) {
        try {
            jailChannel = await guild.channels.fetch(jailChannelId);
        } catch (e) {
            console.warn('âš ï¸ Could not fetch tracked jail channel, searching by name...');
        }
    }

    // Fallback: search for jail channel by name
    if (!jailChannel) {
        jailChannel = guild.channels.cache.find(ch =>
            ch.name.startsWith('jail-') && ch.parentId === JAIL_CATEGORY_ID &&
            ch.permissionOverwrites.cache.has(targetUser.id)
        );
    }

    if (jailChannel) {
        try {
            // Create rich transcript including embeds
            const messages = await jailChannel.messages.fetch({ limit: 100 });
            const transcriptLines = ['â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•',
                `JAIL TRANSCRIPT: ${jailChannel.name}`,
                `User: ${targetUser.tag} (${targetUser.id})`,
                `Unjailed By: ${interaction.user.tag}`,
                `Date: ${new Date().toLocaleString()}`,
                'â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•', ''];

            messages.reverse().forEach(msg => {
                transcriptLines.push(`[${msg.createdAt.toISOString()}] ${msg.author.tag}: ${msg.content}`);
                // Include embed data
                if (msg.embeds && msg.embeds.length > 0) {
                    msg.embeds.forEach(embed => {
                        if (embed.title) transcriptLines.push(`  [EMBED] Title: ${embed.title}`);
                        if (embed.description) transcriptLines.push(`  [EMBED] Description: ${embed.description}`);
                        if (embed.fields) {
                            embed.fields.forEach(field => {
                                transcriptLines.push(`  [EMBED] ${field.name}: ${field.value}`);
                            });
                        }
                        if (embed.footer) transcriptLines.push(`  [EMBED] Footer: ${embed.footer.text}`);
                    });
                }
            });

            const transcript = transcriptLines.join('\n');

            const logChannel = await client.channels.fetch(JAIL_LOG_CHANNEL_ID);
            if (logChannel) {
                const transcriptBuffer = Buffer.from(transcript, 'utf-8');
                const attachment = new Discord.AttachmentBuilder(transcriptBuffer, { name: `${jailChannel.name}-transcript.txt` });

                const logEmbed = new Discord.EmbedBuilder()
                    .setColor('#00FF00')
                    .setTitle(`ðŸ”“ Unjailed: ${targetUser.tag}`)
                    .addFields(
                        { name: 'User', value: `${targetUser.tag} (${targetUser.id})`, inline: true },
                        { name: 'Unjailed By', value: `${interaction.user.tag}`, inline: true },
                    )
                    .setFooter({ text: 'Full transcript with embed data attached below' })
                    .setTimestamp();

                await logChannel.send({ embeds: [logEmbed], files: [attachment] });
                console.log(`âœ… Jail transcript sent to log channel for ${targetUser.tag}`);
            }

            // Delete the jail channel
            await jailChannel.send('ðŸ”“ User has been unjailed. This channel will be deleted in 5 seconds...');
            setTimeout(async () => {
                await jailChannel.delete().catch(err => console.error('Error deleting jail channel:', err));
            }, 5000);

        } catch (error) {
            console.error('âŒ Error archiving jail channel:', error);
        }
    }

    // Clean up tracking
    jailChannels.delete(targetUser.id);

    await interaction.editReply({ content: `âœ… ${targetUser.tag} has been unjailed. Transcript saved to <#${JAIL_LOG_CHANNEL_ID}>.` });

    addAuditLog('User Unjailed', interaction.user, `Unjailed ${targetUser.tag}`, 'success');
}

// ======================
// /CLOSE HANDLER (close jail channel without unjailing - for bans)
// ======================

async function handleUnjailCommandV2(interaction) {
    const isStaff = interaction.member.roles.cache.some(role => CONFIG.STAFF_ROLE_IDS.includes(role.id))
        || interaction.member.permissions.has(Discord.PermissionFlagsBits.Administrator);
    if (!isStaff) {
        await interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
        return;
    }

    await interaction.deferReply({ ephemeral: true });
    const targetUser = interaction.options.getUser('user', true);
    const guild = interaction.guild;
    const failures = [];
    let restoredOverwrites = 0;
    let roleRemoved = false;
    const targetMember = await guild.members.fetch(targetUser.id).catch(error => {
        failures.push(`member lookup: ${error.message}`);
        return null;
    });

    if (targetMember && JAIL_ROLE_ID) {
        const jailRole = await guild.roles.fetch(JAIL_ROLE_ID).catch(() => null);
        if (jailRole && targetMember.roles.cache.has(jailRole.id)) {
            try {
                await targetMember.roles.remove(jailRole, `Unjailed by ${interaction.user.tag}`);
                roleRemoved = true;
            } catch (error) {
                failures.push(`jail role: ${error.message}`);
            }
        }
    }

    await guild.channels.fetch().catch(() => {});
    for (const categoryId of JAIL_CATEGORY_IDS) {
        const category = guild.channels.cache.get(categoryId);
        if (!category) {
            failures.push(`missing category ${categoryId}`);
            continue;
        }
        const scopedChannels = [category, ...guild.channels.cache.filter(channel => channel.parentId === categoryId).values()];
        for (const channel of scopedChannels) {
            if (!channel.permissionOverwrites?.cache.has(targetUser.id)) continue;
            try {
                await channel.permissionOverwrites.delete(targetUser.id, `Unjailed by ${interaction.user.tag}`);
                restoredOverwrites += 1;
            } catch (error) {
                failures.push(`#${channel.name}: ${error.message}`);
            }
        }
    }

    const trackedId = jailChannels.get(targetUser.id);
    const jailChannelCandidates = guild.channels.cache.filter(channel =>
        channel.parentId === JAIL_CATEGORY_ID && channel.isTextBased() && (
            channel.id === trackedId
            || channel.topic === `commission-jail-user:${targetUser.id}`
            || (channel.name.startsWith('jail-') && channel.permissionOverwrites?.cache.has(targetUser.id))
        )
    );

    let transcriptsSaved = 0;
    const logChannel = await client.channels.fetch(JAIL_LOG_CHANNEL_ID).catch(() => null);
    for (const jailChannel of jailChannelCandidates.values()) {
        try {
            const messages = await jailChannel.messages.fetch({ limit: 100 });
            const transcriptLines = [
                '===============================================',
                `JAIL TRANSCRIPT: ${jailChannel.name}`,
                `User: ${targetUser.tag} (${targetUser.id})`,
                `Unjailed By: ${interaction.user.tag}`,
                `Date: ${new Date().toLocaleString()}`,
                '===============================================',
                '',
            ];
            messages.reverse().forEach(message => {
                transcriptLines.push(`[${message.createdAt.toISOString()}] ${message.author.tag}: ${message.content}`);
                for (const embed of message.embeds || []) {
                    if (embed.title) transcriptLines.push(`  [EMBED] Title: ${embed.title}`);
                    if (embed.description) transcriptLines.push(`  [EMBED] Description: ${embed.description}`);
                    for (const field of embed.fields || []) transcriptLines.push(`  [EMBED] ${field.name}: ${field.value}`);
                }
            });
            if (logChannel?.isTextBased()) {
                const attachment = new Discord.AttachmentBuilder(Buffer.from(transcriptLines.join('\n'), 'utf8'), {
                    name: `${jailChannel.name}-transcript.txt`,
                });
                await logChannel.send({
                    content: `Unjailed ${targetUser.tag} (${targetUser.id}) by ${interaction.user.tag}.`,
                    files: [attachment],
                });
                transcriptsSaved += 1;
            } else {
                failures.push(`archive channel ${JAIL_LOG_CHANNEL_ID} is missing or is not a text channel`);
            }
            await jailChannel.send('User has been unjailed. This channel will be deleted in 5 seconds.').catch(() => {});
            setTimeout(() => jailChannel.delete(`Unjailed by ${interaction.user.tag}`).catch(error => {
                console.error('Error deleting jail channel:', error);
            }), 5000);
        } catch (error) {
            failures.push(`${jailChannel.name} archive: ${error.message}`);
        }
    }

    jailChannels.delete(targetUser.id);
    const stillHasRole = Boolean(targetMember && JAIL_ROLE_ID && targetMember.roles.cache.has(JAIL_ROLE_ID) && !roleRemoved);
    const permissionFailures = failures.filter(item => item.startsWith('#'));
    if (stillHasRole || permissionFailures.length) {
        await interaction.editReply({
            content: `Could not fully unjail ${targetUser.tag}. Check that the bot role is above the jail role and has Manage Roles and Manage Channels.\n${failures.slice(0, 4).join('\n')}`,
        });
        addAuditLog('Unjail Failed', interaction.user, `Could not fully unjail ${targetUser.tag}: ${failures.join('; ')}`, 'error');
        return;
    }

    const archiveNote = jailChannelCandidates.size
        ? `${transcriptsSaved} transcript(s) saved to <#${JAIL_LOG_CHANNEL_ID}>.`
        : 'No jail channel was found; permissions were still restored.';
    await interaction.editReply({
        content: `${targetUser.tag} has been unjailed. Restored ${restoredOverwrites} channel permission overwrite(s). ${archiveNote}`,
    });
    addAuditLog('User Unjailed', interaction.user, `Unjailed ${targetUser.tag}; restored ${restoredOverwrites} overwrites`, 'success');
}

async function handleCloseCommand(interaction) {
    const isStaff = interaction.member.roles.cache.some(role =>
        CONFIG.STAFF_ROLE_IDS.includes(role.id)
    ) || interaction.member.permissions.has(Discord.PermissionFlagsBits.Administrator);

    if (!isStaff) {
        await interaction.reply({ content: 'âŒ You do not have permission to use this command.', ephemeral: true });
        return;
    }

    const channel = interaction.channel;

    // Check if this is a jail or report channel
    if (!channel.name.startsWith('jail-') && !channel.name.startsWith('report-')) {
        await interaction.reply({ content: 'âŒ This command only works in jail or report channels.', ephemeral: true });
        return;
    }

    await interaction.reply({ content: 'ðŸ—ƒï¸ Archiving and closing this channel...' });

    try {
        // Create rich transcript including embeds
        const messages = await channel.messages.fetch({ limit: 100 });
        const transcriptLines = ['â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•',
            `CHANNEL TRANSCRIPT: ${channel.name}`,
            `Closed By: ${interaction.user.tag}`,
            `Type: ${channel.name.startsWith('jail-') ? 'Jail Channel' : 'Report Channel'}`,
            `Date: ${new Date().toLocaleString()}`,
            'â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•', ''];

        messages.reverse().forEach(msg => {
            transcriptLines.push(`[${msg.createdAt.toISOString()}] ${msg.author.tag}: ${msg.content}`);
            if (msg.embeds && msg.embeds.length > 0) {
                msg.embeds.forEach(embed => {
                    if (embed.title) transcriptLines.push(`  [EMBED] Title: ${embed.title}`);
                    if (embed.description) transcriptLines.push(`  [EMBED] Description: ${embed.description}`);
                    if (embed.fields) {
                        embed.fields.forEach(field => {
                            transcriptLines.push(`  [EMBED] ${field.name}: ${field.value}`);
                        });
                    }
                    if (embed.footer) transcriptLines.push(`  [EMBED] Footer: ${embed.footer.text}`);
                });
            }
        });

        const transcript = transcriptLines.join('\n');

        // Send transcript to log channel
        const logChannel = await client.channels.fetch(JAIL_LOG_CHANNEL_ID);
        if (logChannel) {
            const transcriptBuffer = Buffer.from(transcript, 'utf-8');
            const attachment = new Discord.AttachmentBuilder(transcriptBuffer, { name: `${channel.name}-transcript.txt` });

            const logEmbed = new Discord.EmbedBuilder()
                .setColor('#FFA500')
                .setTitle(`ðŸ—ƒï¸ Channel Closed: ${channel.name}`)
                .addFields(
                    { name: 'Closed By', value: `${interaction.user.tag}`, inline: true },
                    { name: 'Type', value: channel.name.startsWith('jail-') ? 'Jail Channel' : 'Report Channel', inline: true },
                )
                .setFooter({ text: 'Transcript attached below' })
                .setTimestamp();

            await logChannel.send({ embeds: [logEmbed], files: [attachment] });
        }

        addAuditLog('Channel Closed', interaction.user, `Closed ${channel.name}`, 'info');

        await channel.send('ðŸ—ƒï¸ This channel will be deleted in 5 seconds...');
        setTimeout(async () => {
            await channel.delete().catch(err => console.error('Error deleting channel:', err));
        }, 5000);

    } catch (error) {
        console.error('âŒ Error closing channel:', error);
    }
}

// ======================
// MUSIC SYSTEM
// ======================

// Music channel IDs are declared at the top of the file

const musicQueue = []; // { title, url, requestedBy }
let currentSong = null;
let musicConnection = null;
let audioPlayer = null;
let queueMessage = null; // Persistent queue message that gets edited
let requestsSinceLastPost = 0; // Counter to repost queue every 5 requests

// Build queue embed
function buildQueueEmbed() {
    let description = '';

    if (currentSong) {
        description += `ðŸŽ¶ **Now Playing:** ${currentSong.title} (${currentSong.duration || '?'}) â€” *${currentSong.requestedBy}*\n\n`;
    } else {
        description += 'ðŸ”‡ **Nothing playing**\n\n';
    }

    if (musicQueue.length > 0) {
        description += '**Up Next:**\n';
        musicQueue.slice(0, 15).forEach((song, i) => {
            description += `\`${i + 1}.\` ${song.title} (${song.duration || '?'}) â€” *${song.requestedBy}*\n`;
        });
        if (musicQueue.length > 15) {
            description += `\n...and ${musicQueue.length - 15} more`;
        }
    } else {
        description += '*Queue is empty. Use `!play <song>` to add songs.*';
    }

    return new Discord.EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('ðŸŽµ Music Queue')
        .setDescription(description)
        .setFooter({ text: `${musicQueue.length} song(s) in queue | Max song length: 8 min` })
        .setTimestamp();
}

// Update or repost the queue message
async function updateQueueMessage() {
    try {
        const musicChannel = await client.channels.fetch(MUSIC_CHANNEL_ID);
        if (!musicChannel) return;

        const embed = buildQueueEmbed();
        requestsSinceLastPost++;

        // Try to edit existing message, or post new one every 5 requests
        if (queueMessage && requestsSinceLastPost < 5) {
            try {
                await queueMessage.edit({ embeds: [embed] });
                return;
            } catch (e) {
                // Message was deleted or too old, post a new one
                queueMessage = null;
            }
        }

        // Post a fresh queue message
        requestsSinceLastPost = 0;
        queueMessage = await musicChannel.send({ embeds: [embed] });

    } catch (error) {
        console.error('âŒ Error updating queue message:', error);
    }
}

async function handleMusicCommand(interaction) {
    const cmd = interaction.commandName;

    // Only allow music commands in the music channel
    if (interaction.channelId !== MUSIC_CHANNEL_ID) {
        await interaction.reply({ content: `âŒ Music commands only work in <#${MUSIC_CHANNEL_ID}>`, ephemeral: true });
        return;
    }

    if (!voice || !playDl || !ytdl) {
        await interaction.reply({ content: 'âŒ Music dependencies not installed. Ask the bot admin to install them.', ephemeral: true });
        return;
    }

    if (cmd === 'join') {
        await musicJoin(interaction);
    } else if (cmd === 'leave') {
        await musicLeave(interaction);
    } else if (cmd === 'play') {
        await musicPlay(interaction);
    } else if (cmd === 'skip') {
        await musicSkip(interaction);
    } else if (cmd === 'queue') {
        await musicShowQueue(interaction);
    } else if (cmd === 'nowplaying') {
        await musicNowPlaying(interaction);
    } else if (cmd === 'clear') {
        await musicClear(interaction);
    }
}

async function musicJoin(interaction) {
    const guild = interaction.guild;

    try {
        const voiceChannel = await guild.channels.fetch(MUSIC_VOICE_CHANNEL_ID);
        if (!voiceChannel) {
            await interaction.reply({ content: 'âŒ Music voice channel not found.', ephemeral: true });
            return;
        }

        musicConnection = voice.joinVoiceChannel({
            channelId: MUSIC_VOICE_CHANNEL_ID,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false,
        });

        audioPlayer = voice.createAudioPlayer({
            behaviors: { noSubscriber: voice.NoSubscriberBehavior.Pause },
        });

        musicConnection.subscribe(audioPlayer);

        audioPlayer.on(voice.AudioPlayerStatus.Idle, () => {
            currentSong = null;
            if (musicQueue.length > 0) {
                playNextSong(guild);
            } else {
                updateQueueMessage(); // Show empty queue
            }
        });

        audioPlayer.on('error', (error) => {
            console.error('âŒ Audio player error:', error);
            currentSong = null;
            if (musicQueue.length > 0) {
                playNextSong(guild);
            }
        });

        await interaction.reply({ content: `âœ… Joined <#${MUSIC_VOICE_CHANNEL_ID}>! Use \`/play <url>\` to queue a song.` });
        addAuditLog('Music Join', interaction.user, `Bot joined voice channel`, 'info');

    } catch (error) {
        console.error('âŒ Error joining voice:', error);
        await interaction.reply({ content: 'âŒ Error joining voice channel: ' + error.message, ephemeral: true });
    }
}

async function musicLeave(interaction) {
    if (musicConnection) {
        musicConnection.destroy();
        musicConnection = null;
        audioPlayer = null;
        currentSong = null;
        musicQueue.length = 0;
        await interaction.reply({ content: 'ðŸ‘‹ Left the voice channel. Queue cleared.' });
        addAuditLog('Music Leave', interaction.user, 'Bot left voice channel', 'info');
    } else {
        await interaction.reply({ content: 'âŒ Bot is not in a voice channel.', ephemeral: true });
    }
}

async function musicPlay(interaction) {
    if (!musicConnection) {
        await interaction.reply({ content: 'âŒ Bot is not in a voice channel. Use `/join` first.', ephemeral: true });
        return;
    }

    // Check if user is in the same voice channel as the bot
    const memberVoice = interaction.member.voice;
    if (!memberVoice || !memberVoice.channelId || memberVoice.channelId !== MUSIC_VOICE_CHANNEL_ID) {
        await interaction.reply({ content: `âŒ You must be in <#${MUSIC_VOICE_CHANNEL_ID}> to request music.`, ephemeral: true });
        return;
    }

    await interaction.deferReply();

    const input = interaction.options.getString('url');

    try {
        let songInfo;

        // Check if it's a URL or search query
        if (playDl.yt_validate(input) === 'video') {
            songInfo = {
                title: 'Loading...',
                url: input,
                duration: 'Unknown',
                requestedBy: interaction.user.tag,
            };
            // Get title/duration from video info
            try {
                const info = await playDl.video_info(input);
                songInfo.title = info.video_details.title || 'Unknown';
                songInfo.duration = info.video_details.durationRaw || 'Unknown';
            } catch (e) {
                console.warn('âš ï¸ Could not fetch video info, using URL directly');
            }
        } else {
            // Search YouTube
            const results = await playDl.search(input, { limit: 1 });
            if (results.length === 0) {
                await interaction.editReply({ content: 'âŒ No results found.' });
                return;
            }

            const result = results[0];
            // Log ALL properties to find the right URL field
            console.log(`ðŸ” Search result keys: ${Object.keys(result).join(', ')}`);
            console.log(`ðŸ” Search result: title="${result.title}" url="${result.url}" id="${result.id}" videoId="${result.videoId}"`);

            // Try every possible URL property
            let videoUrl = result.url;
            if (!videoUrl && result.id) videoUrl = `https://www.youtube.com/watch?v=${result.id}`;
            if (!videoUrl && result.videoId) videoUrl = `https://www.youtube.com/watch?v=${result.videoId}`;
            if (!videoUrl && result.video_id) videoUrl = `https://www.youtube.com/watch?v=${result.video_id}`;
            if (!videoUrl && result.link) videoUrl = result.link;
            if (!videoUrl && result.shortUrl) videoUrl = result.shortUrl;

            if (!videoUrl) {
                console.error('âŒ Could not extract URL from search result:', JSON.stringify(result).substring(0, 500));
                await interaction.editReply({ content: 'âŒ Could not get URL for this song. Try pasting a YouTube link instead.' });
                return;
            }

            songInfo = {
                title: result.title || 'Unknown',
                url: videoUrl,
                duration: result.durationRaw || result.duration || 'Unknown',
                requestedBy: interaction.user.tag,
            };
        }

        console.log(`ðŸŽµ Queued: "${songInfo.title}" URL: ${songInfo.url}`);

        // Check max duration (8 minutes = 480 seconds)
        const durationSecs = parseDurationToSeconds(songInfo.duration);
        if (durationSecs > 480) {
            await interaction.editReply({ content: `âŒ **Song too long!** "${songInfo.title}" is ${songInfo.duration}. Max length is **8 minutes**.` });
            return;
        }

        musicQueue.push(songInfo);

        await interaction.editReply({ content: `âœ… **Added:** ${songInfo.title} (${songInfo.duration || 'Unknown'}) â€” Position #${musicQueue.length}` });

        // Update the persistent queue message
        await updateQueueMessage();

        // If nothing is playing, start playing
        if (!currentSong) {
            await playNextSong(interaction.guild);
        }

    } catch (error) {
        console.error('âŒ Error adding song:', error);
        await interaction.editReply({ content: 'âŒ Error: ' + error.message });
    }
}

async function playNextSong(guild) {
    if (musicQueue.length === 0 || !musicConnection || !audioPlayer) return;

    currentSong = musicQueue.shift();

    try {
        console.log(`ðŸŽµ Attempting to play: "${currentSong.title}" URL: ${currentSong.url}`);

        if (!currentSong.url || currentSong.url === 'undefined') {
            console.error('âŒ Invalid URL for song:', currentSong.title);
            currentSong = null;
            if (musicQueue.length > 0) playNextSong(guild);
            return;
        }

        if (!ytdl.validateURL(currentSong.url)) {
            console.error('âŒ ytdl rejected URL:', currentSong.url);
            currentSong = null;
            if (musicQueue.length > 0) playNextSong(guild);
            return;
        }

        // Use @distube/ytdl-core for playback. play-dl search works, but
        // playDl.stream() was throwing ERR_INVALID_URL with input undefined.
        const ytStream = ytdl(currentSong.url, {
            filter: 'audioonly',
            quality: 'highestaudio',
            highWaterMark: 1 << 25,
            dlChunkSize: 0,
        });

        ytStream.on('error', (streamError) => {
            console.error('âŒ YouTube stream error:', streamError);
        });

        const probed = await voice.demuxProbe(ytStream);
        const resource = voice.createAudioResource(probed.stream, {
            inputType: probed.type,
        });

        audioPlayer.play(resource);

        // Update the queue message to show now playing
        await updateQueueMessage();

        console.log(`ðŸŽµ Now playing: ${currentSong.title}`);

    } catch (error) {
        console.error('âŒ Error playing song:', error);
        // Try next song
        if (musicQueue.length > 0) {
            playNextSong(guild);
        }
    }
}

async function musicSkip(interaction) {
    if (!audioPlayer || !currentSong) {
        await interaction.reply({ content: 'âŒ Nothing is playing.', ephemeral: true });
        return;
    }

    const skipped = currentSong.title;
    audioPlayer.stop(); // This triggers the Idle event which plays next song
    await interaction.reply({ content: `â­ï¸ Skipped: **${skipped}**` });
}

async function musicShowQueue(interaction) {
    if (musicQueue.length === 0 && !currentSong) {
        await interaction.reply({ content: 'ðŸ“­ Queue is empty. Use `/play` to add songs.', ephemeral: true });
        return;
    }

    let description = '';

    if (currentSong) {
        description += `ðŸŽ¶ **Now Playing:** ${currentSong.title} (${currentSong.duration || '?'})\n\n`;
    }

    if (musicQueue.length > 0) {
        description += '**Up Next:**\n';
        musicQueue.slice(0, 10).forEach((song, i) => {
            description += `${i + 1}. ${song.title} (${song.duration || '?'}) â€” *${song.requestedBy}*\n`;
        });
        if (musicQueue.length > 10) {
            description += `\n...and ${musicQueue.length - 10} more`;
        }
    }

    const embed = new Discord.EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('ðŸŽµ Music Queue')
        .setDescription(description)
        .setFooter({ text: `${musicQueue.length} song(s) in queue` })
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

async function musicNowPlaying(interaction) {
    if (!currentSong) {
        await interaction.reply({ content: 'âŒ Nothing is playing right now.', ephemeral: true });
        return;
    }

    const embed = new Discord.EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('ðŸŽ¶ Now Playing')
        .setDescription(`**${currentSong.title}**`)
        .addFields(
            { name: 'Duration', value: currentSong.duration || 'Unknown', inline: true },
            { name: 'Requested By', value: currentSong.requestedBy, inline: true },
            { name: 'URL', value: currentSong.url }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

async function musicClear(interaction) {
    const count = musicQueue.length;
    musicQueue.length = 0;
    await interaction.reply({ content: `ðŸ—‘ï¸ Cleared ${count} song(s) from the queue.` });
}

// Parse duration string like "6:11" or "1:23:45" to seconds
function parseDurationToSeconds(duration) {
    if (!duration || duration === 'Unknown') return 0;
    const str = String(duration);
    const parts = str.split(':').map(Number);
    if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
    if (parts.length === 2) return (parts[0] * 60) + parts[1];
    return parseInt(str) || 0;
}

// ======================
// !play TEXT COMMAND (music request channel only)
// ======================

async function handleMusicTextCommand(message, command, args) {
    if (!voice || !playDl || !ytdl) {
        await message.reply('âŒ Music dependencies not installed.');
        return;
    }

    if (command === 'play') {
        const query = args.join(' ');
        if (!query) {
            await message.reply('âŒ Usage: `!play <song name>` or `!play <artist> - <song>`');
            return;
        }

        if (!musicConnection) {
            await message.reply('âŒ Bot is not in a voice channel. A staff member needs to use `/join` first.');
            return;
        }

        // Check if user is in the same voice channel as the bot
        const memberVoice = message.member.voice;
        if (!memberVoice || !memberVoice.channelId || memberVoice.channelId !== MUSIC_VOICE_CHANNEL_ID) {
            await message.reply(`âŒ You must be in <#${MUSIC_VOICE_CHANNEL_ID}> to request music.`);
            return;
        }

        const loadingMsg = await message.reply('ðŸ” Searching...');

        try {
            const results = await playDl.search(query, { limit: 1 });
            if (results.length === 0) {
                await loadingMsg.edit('âŒ No results found.');
                return;
            }

            const result = results[0];
            console.log(`ðŸ” Text search keys: ${Object.keys(result).join(', ')}`);
            console.log(`ðŸ” Text search result: title="${result.title}" url="${result.url}" id="${result.id}" videoId="${result.videoId}"`);

            // Try every possible URL property
            let videoUrl = result.url;
            if (!videoUrl && result.id) videoUrl = `https://www.youtube.com/watch?v=${result.id}`;
            if (!videoUrl && result.videoId) videoUrl = `https://www.youtube.com/watch?v=${result.videoId}`;
            if (!videoUrl && result.video_id) videoUrl = `https://www.youtube.com/watch?v=${result.video_id}`;
            if (!videoUrl && result.link) videoUrl = result.link;
            if (!videoUrl && result.shortUrl) videoUrl = result.shortUrl;

            if (!videoUrl) {
                console.error('âŒ Could not extract URL:', JSON.stringify(result).substring(0, 500));
                await loadingMsg.edit('âŒ Could not get URL for this song. Try pasting a YouTube link instead.');
                return;
            }

            const duration = result.durationRaw || result.duration || 'Unknown';

            // Check max duration (8 minutes = 480 seconds)
            const durationSecs = parseDurationToSeconds(duration);
            if (durationSecs > 480) {
                await loadingMsg.edit(`âŒ **Song too long!** "${result.title}" is ${duration}. Max length is **8 minutes**.`);
                return;
            }

            const songInfo = {
                title: result.title || 'Unknown',
                url: videoUrl,
                duration: duration,
                requestedBy: message.author.tag,
            };

            console.log(`ðŸŽµ Text queued: "${songInfo.title}" URL: ${songInfo.url}`);

            musicQueue.push(songInfo);

            await loadingMsg.edit(`âœ… **Added:** ${songInfo.title} (${songInfo.duration}) â€” Position #${musicQueue.length}`);

            // Delete the confirmation after 5 seconds to keep chat clean
            setTimeout(() => loadingMsg.delete().catch(() => {}), 5000);

            // Update the persistent queue message
            await updateQueueMessage();

            if (!currentSong) {
                await playNextSong(message.guild);
            }

        } catch (error) {
            console.error('âŒ Error in !play:', error);
            await loadingMsg.edit('âŒ Error: ' + error.message);
        }

    } else if (command === 'skip') {
        if (!audioPlayer || !currentSong) {
            await message.reply('âŒ Nothing is playing.');
            return;
        }
        const skipped = currentSong.title;
        audioPlayer.stop();
        await message.reply(`â­ï¸ Skipped: **${skipped}**`);

    } else if (command === 'queue') {
        if (musicQueue.length === 0 && !currentSong) {
            await message.reply('ðŸ“­ Queue is empty. Use `!play <song>` to add songs.');
            return;
        }

        let description = '';
        if (currentSong) {
            description += `ðŸŽ¶ **Now Playing:** ${currentSong.title} (${currentSong.duration || '?'})\n\n`;
        }
        if (musicQueue.length > 0) {
            description += '**Up Next:**\n';
            musicQueue.slice(0, 10).forEach((song, i) => {
                description += `${i + 1}. ${song.title} (${song.duration || '?'}) â€” *${song.requestedBy}*\n`;
            });
            if (musicQueue.length > 10) {
                description += `\n...and ${musicQueue.length - 10} more`;
            }
        }

        const embed = new Discord.EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('ðŸŽµ Music Queue')
            .setDescription(description)
            .setFooter({ text: `${musicQueue.length} song(s) in queue` })
            .setTimestamp();

        await message.reply({ embeds: [embed] });

    } else if (command === 'np' || command === 'nowplaying') {
        if (!currentSong) {
            await message.reply('âŒ Nothing is playing right now.');
            return;
        }

        const embed = new Discord.EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('ðŸŽ¶ Now Playing')
            .setDescription(`**${currentSong.title}**`)
            .addFields(
                { name: 'Duration', value: currentSong.duration || 'Unknown', inline: true },
                { name: 'Requested By', value: currentSong.requestedBy, inline: true }
            )
            .setTimestamp();

        await message.reply({ embeds: [embed] });

    } else if (command === 'clear') {
        const count = musicQueue.length;
        musicQueue.length = 0;
        await message.reply(`ðŸ—‘ï¸ Cleared ${count} song(s) from the queue.`);
    }
}

// ======================
// STAFF COMMANDS
// ======================

async function handleStaffCommands(message) {
    const isStaff = message.member.roles.cache.some(role =>
        CONFIG.STAFF_ROLE_IDS.includes(role.id)
    );
    if (!isStaff && !message.member.permissions.has(Discord.PermissionFlagsBits.Administrator)) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args[0].toLowerCase();

    if (command === 'config') {
        const configEmbed = new Discord.EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('âš™ï¸ Bot Configuration Status')
            .addFields(
                { name: 'Main Chat Channel', value: CONFIG.MAIN_CHAT_CHANNEL_ID ? `âœ… <#${CONFIG.MAIN_CHAT_CHANNEL_ID}>` : 'âŒ Not set' },
                { name: 'Announcement Channel', value: CONFIG.ANNOUNCEMENT_CHANNEL_ID ? `âœ… <#${CONFIG.ANNOUNCEMENT_CHANNEL_ID}>` : 'âŒ Not set' },
                { name: 'Mod Channel', value: CONFIG.MOD_CHANNEL_ID ? `âœ… <#${CONFIG.MOD_CHANNEL_ID}>` : 'âŒ Not set' },
                { name: 'Log Channel', value: CONFIG.LOG_CHANNEL_ID ? `âœ… <#${CONFIG.LOG_CHANNEL_ID}>` : 'âŒ Not set' },
                { name: 'Ticket Category', value: CONFIG.TICKET_CATEGORY_ID ? 'âœ… Set' : 'âŒ Not set' },
                { name: 'Staff Role IDs', value: CONFIG.STAFF_ROLE_IDS.length > 0 ? `âœ… ${CONFIG.STAFF_ROLE_IDS.length} role(s)` : 'âŒ Not set' }
            );
        await message.reply({ embeds: [configEmbed] });
        return;
    }


    if (command === 'close') {
        // Check if this is a ticket channel
        if (message.channel.name.startsWith('tech-') || message.channel.name.startsWith('report-')) {
            await closeTicket(message.channel);
        } else {
            await message.reply('âŒ This command only works in ticket channels.');
        }
    }

    // Trivia commands
    if (command === 'trivia') {
        const subcommand = args[1]?.toLowerCase();

        if (subcommand === 'on') {
            if (triviaEnabled) {
                await message.reply('âš ï¸ Trivia is already enabled!');
                return;
            }
            triviaEnabled = true;
            startTriviaSystem();
            await message.reply('âœ… Trivia system enabled! Questions will be posted every 25 minutes.');
            addAuditLog('Trivia Enabled', message.author, 'Trivia system started', 'success');

        } else if (subcommand === 'off') {
            if (!triviaEnabled) {
                await message.reply('âš ï¸ Trivia is already disabled!');
                return;
            }
            triviaEnabled = false;
            if (triviaInterval) {
                clearInterval(triviaInterval);
                triviaInterval = null;
            }
            currentTrivia = null;
            await message.reply('âœ… Trivia system disabled.');
            addAuditLog('Trivia Disabled', message.author, 'Trivia system stopped', 'info');

        } else if (subcommand === 'scores') {
            if (triviaScores.size === 0) {
                await message.reply('ðŸ“Š No trivia scores yet!');
                return;
            }

            const sortedScores = Array.from(triviaScores.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10);

            const embed = new Discord.EmbedBuilder()
                .setColor('#FFD700')
                .setTitle('ðŸ† Trivia Leaderboard')
                .setDescription(
                    sortedScores.map((entry, index) => {
                        const userId = entry[0];
                        const score = entry[1];
                        const medal = index === 0 ? 'ðŸ¥‡' : index === 1 ? 'ðŸ¥ˆ' : index === 2 ? 'ðŸ¥‰' : `${index + 1}.`;
                        return `${medal} <@${userId}> - **${score}** points`;
                    }).join('\n')
                )
                .setTimestamp();

            await message.reply({ embeds: [embed] });

        } else if (subcommand === 'now') {
            await postTriviaQuestion();

        } else {
            await message.reply('**Trivia Commands:**\n`!trivia on` - Enable trivia\n`!trivia off` - Disable trivia\n`!trivia scores` - View leaderboard\n`!trivia now` - Post question now');
        }
        return;
    }

    // Online/Offline commands
    if (command === 'online') {
        await client.user.setStatus('online');
        await message.channel.send('âœ… **The Bot Online and ready to work!**');
        addAuditLog('Bot Status', message.author, 'Set bot status to ONLINE', 'success');
        return;
    }

    if (command === 'offline') {
        await client.user.setStatus('invisible');
        await message.channel.send('âš ï¸ **Bot Is Powering down Message staff with issues.**');
        addAuditLog('Bot Status', message.author, 'Set bot status to OFFLINE', 'warning');
        return;
    }

    // Role management commands still work
    if (command === 'help') {
        await sendHelpMessage(message);
    }

    if (command === 'dashboard') {
        await generateDashboard(message);
    }

    if (command === 'role') {
        await startRoleSelection(message);
    }

    if (command === 'permission') {
        await handlePermissionCommand(message);
    }
}

// Birthday command handler - AVAILABLE TO EVERYONE
async function handleBirthdayCommand(message) {
    const args = message.content.slice(1).trim().split(/ +/);
    const input = args[1];

    if (!input) {
        // Show user's current birthday
        const userBirthday = birthdays.get(message.author.id);
        if (userBirthday) {
            await message.reply(`ðŸŽ‚ Your birthday is set to: **${userBirthday.month}/${userBirthday.day}**\n\nTo remove it, use: \`!birthday remove\``);
        } else {
            await message.reply(`ðŸŽ‚ You haven't set your birthday yet!\n\nUse: \`!birthday MM/DD\`\nExample: \`!birthday 12/25\``);
        }
        return;
    }

    if (input.toLowerCase() === 'remove') {
        birthdays.delete(message.author.id);
        await message.reply('ðŸŽ‚ Your birthday has been removed from the system.');
        addAuditLog('Birthday Removed', message.author, 'Birthday registration removed', 'info');
        return;
    }

    // Parse MM/DD format
    const parts = input.split('/');
    if (parts.length !== 2) {
        await message.reply('âŒ Invalid format! Use: `!birthday MM/DD` (e.g., `!birthday 12/25`)');
        return;
    }

    const month = parseInt(parts[0]);
    const day = parseInt(parts[1]);

    // Validate
    if (month < 1 || month > 12 || day < 1 || day > 31) {
        await message.reply('âŒ Invalid date! Month must be 1-12 and day must be 1-31.');
        return;
    }

    // Validate day for month
    const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (day > daysInMonth[month - 1]) {
        await message.reply(`âŒ Invalid day for month ${month}! Max day is ${daysInMonth[month - 1]}.`);
        return;
    }

    // Save birthday
    birthdays.set(message.author.id, {
        month,
        day,
        username: message.author.tag
    });

    await message.reply(`ðŸŽ‚ Birthday saved! I'll announce it on **${month}/${day}** at 8am and 8pm!`);
    addAuditLog('Birthday Set', message.author, `Birthday: ${month}/${day}`, 'success');
}

// Vibe check function - AVAILABLE TO EVERYONE
async function performVibeCheck(message) {
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);
    const twelveHoursAgo = now - (12 * 60 * 60 * 1000);
    const twentyFourHoursAgo = now - (24 * 60 * 60 * 1000);

    const last1h = recentMessages.filter(m => m.timestamp > oneHourAgo);
    const last12h = recentMessages.filter(m => m.timestamp > twelveHoursAgo);
    const last24h = recentMessages.filter(m => m.timestamp > twentyFourHoursAgo);

    // Sentiment analysis (basic)
    function analyzeSentiment(messages) {
        if (messages.length === 0) return { positive: 0, negative: 0, neutral: 0, energy: 0 };

        const positive = ['lol', 'lmao', 'haha', 'gg', 'good', 'great', 'awesome', 'love', 'thanks', 'nice', 'poggers', 'pog', 'ðŸ˜‚', 'ðŸ¤£', 'ðŸ˜„', 'â¤ï¸', 'ðŸ’¯', 'ðŸ”¥', '!', 'yes', 'yeah', 'yay'];
        const negative = ['bad', 'hate', 'stupid', 'dumb', 'wtf', 'bruh', 'cringe', 'rip', 'oof', 'sad', 'ðŸ˜¢', 'ðŸ˜­', 'ðŸ’€', 'no', 'nah', 'nope', 'ugh'];

        let positiveCount = 0;
        let negativeCount = 0;
        let energyScore = 0;

        messages.forEach(msg => {
            const lower = msg.content.toLowerCase();

            // Check positive words
            positive.forEach(word => {
                if (lower.includes(word)) positiveCount++;
            });

            // Check negative words
            negative.forEach(word => {
                if (lower.includes(word)) negativeCount++;
            });

            // Energy from caps and punctuation
            const caps = (msg.content.match(/[A-Z]/g) || []).length;
            const exclamation = (msg.content.match(/!/g) || []).length;
            energyScore += caps + (exclamation * 2);
        });

        const total = positiveCount + negativeCount;
        return {
            positive: total > 0 ? Math.round((positiveCount / total) * 100) : 50,
            negative: total > 0 ? Math.round((negativeCount / total) * 100) : 50,
            neutral: total > 0 ? Math.round((1 - (positiveCount + negativeCount) / messages.length) * 100) : 0,
            energy: Math.min(100, Math.round((energyScore / messages.length) * 10))
        };
    }

    const vibe1h = analyzeSentiment(last1h);
    const vibe12h = analyzeSentiment(last12h);
    const vibe24h = analyzeSentiment(last24h);

    function getVibeEmoji(positive, negative, energy) {
        if (positive > 60 && energy > 50) return 'ðŸ”¥ HYPED';
        if (positive > 60) return 'ðŸ˜Š POSITIVE';
        if (negative > 60) return 'ðŸ˜¤ SALTY';
        if (energy > 70) return 'âš¡ ENERGETIC';
        if (energy < 30) return 'ðŸ˜´ CHILL';
        return 'ðŸ˜ NEUTRAL';
    }

    const embed = new Discord.EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('âœ¨ Vibe Check')
        .setDescription('Current chat atmosphere analysis')
        .addFields(
            {
                name: 'ðŸ• Last Hour',
                value: `${getVibeEmoji(vibe1h.positive, vibe1h.negative, vibe1h.energy)}\nPositive: ${vibe1h.positive}%\nNegative: ${vibe1h.negative}%\nEnergy: ${vibe1h.energy}%\nMessages: ${last1h.length}`,
                inline: true
            },
            {
                name: 'ðŸ•› Last 12 Hours',
                value: `${getVibeEmoji(vibe12h.positive, vibe12h.negative, vibe12h.energy)}\nPositive: ${vibe12h.positive}%\nNegative: ${vibe12h.negative}%\nEnergy: ${vibe12h.energy}%\nMessages: ${last12h.length}`,
                inline: true
            },
            {
                name: 'ðŸ“… Last 24 Hours',
                value: `${getVibeEmoji(vibe24h.positive, vibe24h.negative, vibe24h.energy)}\nPositive: ${vibe24h.positive}%\nNegative: ${vibe24h.negative}%\nEnergy: ${vibe24h.energy}%\nMessages: ${last24h.length}`,
                inline: true
            }
        )
        .setFooter({ text: 'Vibe analysis based on message content and energy' })
        .setTimestamp();

    await message.reply({ embeds: [embed] });
}

// Birthday checking system
async function checkBirthdays() {
    if (!CONFIG.ANNOUNCEMENT_CHANNEL_ID) return;

    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentMonth = now.getMonth() + 1; // 0-indexed
    const currentDay = now.getDate();

    // Only run at 8am (8:00) or 8pm (20:00)
    if ((currentHour === 8 || currentHour === 20) && currentMinute === 0) {
        // Find all birthdays today
        const birthdayPeople = [];

        for (const [userId, birthday] of birthdays.entries()) {
            if (birthday.month === currentMonth && birthday.day === currentDay) {
                birthdayPeople.push({ userId, username: birthday.username });
            }
        }

        if (birthdayPeople.length > 0) {
            try {
                const announcementChannel = await client.channels.fetch(CONFIG.ANNOUNCEMENT_CHANNEL_ID);

                // Create mentions list
                const mentions = birthdayPeople.map(p => `<@${p.userId}>`).join(', ');
                const names = birthdayPeople.map(p => p.username).join(', ');

                const embed = new Discord.EmbedBuilder()
                    .setColor('#FFD700')
                    .setTitle('ðŸŽ‚ Happy Birthday! ðŸŽ‰')
                    .setDescription(`Today's the special day for:\n\n${mentions}\n\nWishing you an amazing birthday! ðŸŽˆðŸŽŠ`)
                    .setFooter({ text: `Birthday${birthdayPeople.length > 1 ? 's' : ''} on ${currentMonth}/${currentDay}` })
                    .setTimestamp();

                await announcementChannel.send({ content: mentions, embeds: [embed] });
                addAuditLog('Birthday Announced', { tag: 'System', id: 'system' }, `Birthday for: ${names}`, 'success');

            } catch (error) {
                console.error('Error announcing birthdays:', error);
            }
        }
    }
}

// Trivia System Functions
function startTriviaSystem() {
    // Clear any existing interval
    if (triviaInterval) {
        clearInterval(triviaInterval);
    }

    // Post first question immediately
    postTriviaQuestion();

    // Then post every 25 minutes
    triviaInterval = setInterval(() => {
        if (triviaEnabled) {
            postTriviaQuestion();
        }
    }, 25 * 60 * 1000); // 25 minutes
}

async function postTriviaQuestion() {
    if (!CONFIG.MAIN_CHAT_CHANNEL_ID) {
        console.log('Cannot post trivia: MAIN_CHAT_CHANNEL_ID not configured');
        return;
    }

    try {
        const mainChannel = await client.channels.fetch(CONFIG.MAIN_CHAT_CHANNEL_ID);

        // Select random question
        const randomIndex = Math.floor(Math.random() * triviaQuestions.length);
        currentTrivia = triviaQuestions[randomIndex];

        const embed = new Discord.EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('ðŸ§  Trivia Time!')
            .setDescription(`**Category:** ${currentTrivia.category}\n\n**Question:**\n${currentTrivia.question}`)
            .setFooter({ text: 'First correct answer wins 100 points!' })
            .setTimestamp();

        await mainChannel.send({ embeds: [embed] });
        addAuditLog('Trivia Posted', { tag: 'System', id: 'system' }, `Question: ${currentTrivia.question}`, 'info');

    } catch (error) {
        console.error('Error posting trivia:', error);
    }
}

async function closeTicket(channel) {
    try {
        // Fetch all messages to create transcript
        const messages = await channel.messages.fetch({ limit: 100 });
        const transcript = messages.reverse().map(msg =>
            `[${msg.createdAt.toISOString()}] ${msg.author.tag}: ${msg.content}`
        ).join('\n');

        // Send transcript to #old-reports channel
        const oldReportsChannel = await client.channels.fetch(OLD_REPORTS_CHANNEL_ID);
        if (oldReportsChannel) {
            const transcriptBuffer = Buffer.from(transcript, 'utf-8');
            const attachment = new Discord.AttachmentBuilder(transcriptBuffer, { name: `${channel.name}-transcript.txt` });

            const embed = new Discord.EmbedBuilder()
                .setColor('#FFA500')
                .setTitle(`ðŸ—ƒï¸ Report Closed: ${channel.name}`)
                .setDescription('Transcript attached below')
                .setTimestamp();

            await oldReportsChannel.send({ embeds: [embed], files: [attachment] });
            console.log(`âœ… Transcript sent to #old-reports for ${channel.name}`);
        } else {
            console.error('âŒ Could not find #old-reports channel (ID: ' + OLD_REPORTS_CHANNEL_ID + ')');
        }

        addAuditLog('Report Closed', { tag: 'Staff', id: 'staff' }, `Closed ${channel.name}`, 'info');

        await channel.send('ðŸ—ƒï¸ This report will be deleted in 5 seconds...');
        setTimeout(async () => {
            await channel.delete().catch(err => console.error('Error deleting channel:', err));
        }, 5000);
    } catch (error) {
        console.error('âŒ Error closing report:', error);
    }
}

// ======================
// ROLE MANAGEMENT (Original functionality)
// ======================

async function sendHelpMessage(message) {
    const embed = new Discord.EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('ðŸ¤– Discord Bot Commands')
        .setDescription('Multi-function bot for role management, tickets, and community features')
        .addFields(
            { name: 'ðŸ“Š Role Management', value: '`!dashboard` - Generate HTML permissions dashboard\n`!role` - Select role to manage\n`!permission` - Modify permissions' },
            { name: 'ðŸŽ« Ticket System', value: 'DM the bot to create a ticket' },
            { name: 'ðŸŽ‰ Fun Commands', value: '`!trivia on/off/scores/now` - Trivia system\n`!birthday MM/DD` - Set your birthday\n`!vibecheck` - Chat atmosphere analysis' },
            { name: 'âš™ï¸ Staff Commands', value: '`!config` - Check bot configuration\n`!online` / `!offline` - Set bot status\n`!close` - Close ticket channel' }
        );

    await message.reply({ embeds: [embed] });
}

async function generateDashboard(message) {
    try {
        const guild = message.guild;
        if (!guild) {
            await message.reply('âŒ This command must be used in a server!');
            return;
        }

        const data = await collectServerData(guild);
        const html = generateHTML(data);

        const filename = `dashboard_${guild.id}_${Date.now()}.html`;
        const outputDir = fs.existsSync('/mnt/user-data/outputs') ? '/mnt/user-data/outputs' : __dirname;
        const filepath = path.join(outputDir, filename);

        fs.writeFileSync(filepath, html);

        await message.reply({
            content: 'âœ… Dashboard generated!',
            files: [filepath]
        });
    } catch (error) {
        console.error(error);
        await message.reply('âŒ Error generating dashboard: ' + error.message);
    }
}

async function startRoleSelection(message) {
    try {
        const guild = message.guild;
        if (!guild) return;

        const roles = guild.roles.cache
            .filter(role => role.id !== guild.id)
            .sort((a, b) => b.position - a.position)
            .map((role, index) => ({ index: index + 1, role }));

        let roleList = '**ðŸ“‹ Available Roles:**\n\n';
        roles.forEach(({ index, role }) => {
            roleList += `${index}. ${role.name} (${role.members.size} members)\n`;
        });
        roleList += '\n**Reply with the number of the role:**';

        await message.reply(roleList);

        const filter = m => m.author.id === message.author.id;
        const collected = await message.channel.awaitMessages({ filter, max: 1, time: 30000 });

        if (collected.size === 0) {
            await message.reply('âŒ Timed out.');
            return;
        }

        const roleIndex = parseInt(collected.first().content);
        if (isNaN(roleIndex) || roleIndex < 1 || roleIndex > roles.length) {
            await message.reply('âŒ Invalid number.');
            return;
        }

        const selectedRole = roles[roleIndex - 1].role;
        userStates.set(message.author.id, { selectedRole, guild: guild.id });

        await message.reply(`âœ… Selected role: **${selectedRole.name}**\n\nUse \`!permission\` to modify permissions.`);
    } catch (error) {
        console.error(error);
        await message.reply('âŒ Error: ' + error.message);
    }
}

async function handlePermissionCommand(message) {
    const userState = userStates.get(message.author.id);
    if (!userState || !userState.selectedRole) {
        await message.reply('âŒ Please select a role first using `!role`');
        return;
    }

    const role = message.guild.roles.cache.get(userState.selectedRole.id);
    if (!role) {
        await message.reply('âŒ Role not found');
        return;
    }

    const permissions = [
        { name: 'Administrator', flag: Discord.PermissionFlagsBits.Administrator },
        { name: 'Manage Server', flag: Discord.PermissionFlagsBits.ManageGuild },
        { name: 'Manage Roles', flag: Discord.PermissionFlagsBits.ManageRoles },
        { name: 'Manage Channels', flag: Discord.PermissionFlagsBits.ManageChannels },
        { name: 'Kick Members', flag: Discord.PermissionFlagsBits.KickMembers },
        { name: 'Ban Members', flag: Discord.PermissionFlagsBits.BanMembers },
        { name: 'Send Messages', flag: Discord.PermissionFlagsBits.SendMessages },
        { name: 'Manage Messages', flag: Discord.PermissionFlagsBits.ManageMessages },
    ];

    let permList = `**ðŸ” Permissions for ${role.name}:**\n\n`;
    permissions.forEach((perm, index) => {
        const hasPermission = role.permissions.has(perm.flag);
        const status = hasPermission ? 'âœ…' : 'âŒ';
        permList += `${index + 1}. ${status} ${perm.name}\n`;
    });
    permList += '\n**Reply with permission number, then `enable` or `disable`**';

    await message.reply(permList);
}

async function collectServerData(guild) {
    const roles = guild.roles.cache
        .filter(role => role.id !== guild.id)
        .sort((a, b) => b.position - a.position);

    const channels = guild.channels.cache;
    const roleData = [];

    for (const [roleId, role] of roles) {
        const channelPermissions = [];

        for (const [channelId, channel] of channels) {
            if (channel.type === Discord.ChannelType.GuildCategory) continue;

            const permissions = channel.permissionsFor(role);
            if (!permissions) continue;

            const perms = {
                channelName: channel.name,
                channelType: channel.type,
                canView: permissions.has(Discord.PermissionFlagsBits.ViewChannel),
                canSend: channel.isTextBased() ? permissions.has(Discord.PermissionFlagsBits.SendMessages) : null,
                canConnect: channel.isVoiceBased() ? permissions.has(Discord.PermissionFlagsBits.Connect) : null,
                canSpeak: channel.isVoiceBased() ? permissions.has(Discord.PermissionFlagsBits.Speak) : null,
            };

            channelPermissions.push(perms);
        }

        roleData.push({
            id: role.id,
            name: role.name,
            color: role.hexColor,
            position: role.position,
            members: role.members.size,
            permissions: {
                administrator: role.permissions.has(Discord.PermissionFlagsBits.Administrator),
                manageGuild: role.permissions.has(Discord.PermissionFlagsBits.ManageGuild),
                manageRoles: role.permissions.has(Discord.PermissionFlagsBits.ManageRoles),
                manageChannels: role.permissions.has(Discord.PermissionFlagsBits.ManageChannels),
                kickMembers: role.permissions.has(Discord.PermissionFlagsBits.KickMembers),
                banMembers: role.permissions.has(Discord.PermissionFlagsBits.BanMembers),
                sendMessages: role.permissions.has(Discord.PermissionFlagsBits.SendMessages),
                manageMessages: role.permissions.has(Discord.PermissionFlagsBits.ManageMessages),
            },
            channelPermissions
        });
    }

    return {
        serverName: guild.name,
        serverIcon: guild.iconURL(),
        roles: roleData
    };
}

function generateHTML(data) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${data.serverName} Dashboard</title></head><body><h1>${data.serverName} Role Permissions</h1><p>Dashboard generated on ${new Date().toLocaleString()}</p></body></html>`;
}

function startKeepAliveServer() {
    const server = http.createServer(async (req, res) => {
        // Parse URL and method
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;

        // The dashboard is same-origin and local-only in the Windows application.
        res.setHeader('Access-Control-Allow-Origin', `http://${req.headers.host}`);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        // API: Get audit log
        if (pathname === '/api/audit-log' && req.method === 'GET') {
            const password = url.searchParams.get('password');
            if (password !== CONFIG.WEB_DASHBOARD_PASSWORD) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid password' }));
                return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                logs: auditLog.slice(0, 100),
                botStatus: client.user ? 'online' : 'offline',
                botTag: client.user?.tag || 'Not connected'
            }));
            return;
        }

        // API: Send message to main chat
        if (pathname === '/api/send-message' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);

                    if (data.password !== CONFIG.WEB_DASHBOARD_PASSWORD) {
                        res.writeHead(401, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Invalid password' }));
                        return;
                    }

                    if (!CONFIG.MAIN_CHAT_CHANNEL_ID) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'MAIN_CHAT_CHANNEL_ID not configured' }));
                        return;
                    }

                    const mainChannel = await client.channels.fetch(CONFIG.MAIN_CHAT_CHANNEL_ID);
                    await mainChannel.send(data.message);

                    addAuditLog('Message Sent', { tag: 'Web Dashboard', id: 'web' }, `Sent to main chat: ${data.message.substring(0, 50)}...`, 'success');

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: 'Message sent!' }));
                } catch (error) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: error.message }));
                }
            });
            return;
        }

        // API: Get role permissions
        if (pathname === '/api/roles' && req.method === 'GET') {
            const password = url.searchParams.get('password');
            if (password !== CONFIG.WEB_DASHBOARD_PASSWORD) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid password' }));
                return;
            }

            try {
                const guild = client.guilds.cache.first();
                if (!guild) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Bot not in any server' }));
                    return;
                }

                const rolesData = await collectServerData(guild);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(rolesData));
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
            }
            return;
        }

        // API: Search users
        if (pathname === '/api/users/search' && req.method === 'GET') {
            const password = url.searchParams.get('password');
            const query = url.searchParams.get('query');

            if (password !== CONFIG.WEB_DASHBOARD_PASSWORD) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid password' }));
                return;
            }

            try {
                const guild = client.guilds.cache.first();
                if (!guild) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Bot not in any server' }));
                    return;
                }

                await guild.members.fetch();

                let results = [];
                if (query) {
                    const lowerQuery = query.toLowerCase();
                    results = guild.members.cache.filter(member => {
                        return member.user.tag.toLowerCase().includes(lowerQuery) ||
                               member.user.id === query ||
                               member.displayName.toLowerCase().includes(lowerQuery);
                    }).map(member => ({
                        id: member.user.id,
                        tag: member.user.tag,
                        displayName: member.displayName,
                        avatar: member.user.displayAvatarURL(),
                        joinedAt: member.joinedTimestamp,
                        accountCreatedAt: member.user.createdTimestamp,
                        roles: member.roles.cache.map(r => ({ id: r.id, name: r.name, color: r.hexColor })),
                        timedOut: member.communicationDisabledUntilTimestamp ? member.communicationDisabledUntilTimestamp > Date.now() : false,
                        timeoutUntil: member.communicationDisabledUntilTimestamp
                    })).slice(0, 20);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ users: results }));
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
            }
            return;
        }

        // API: User action (timeout, kick, ban)
        if (pathname === '/api/users/action' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);

                    if (data.password !== CONFIG.WEB_DASHBOARD_PASSWORD) {
                        res.writeHead(401, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Invalid password' }));
                        return;
                    }

                    const guild = client.guilds.cache.first();
                    const member = await guild.members.fetch(data.userId);

                    let result = '';

                    switch(data.action) {
                        case 'timeout':
                            const duration = parseInt(data.duration) || 60;
                            await member.timeout(duration * 60 * 1000, data.reason || 'Timed out from web dashboard');
                            result = `Timed out for ${duration} minutes`;
                            addAuditLog('User Timed Out', { tag: 'Web Dashboard', id: 'web' }, `${member.user.tag} timed out for ${duration} minutes`, 'warning');
                            break;

                        case 'untimeout':
                            await member.timeout(null);
                            result = 'Timeout removed';
                            addAuditLog('Timeout Removed', { tag: 'Web Dashboard', id: 'web' }, `${member.user.tag} timeout removed`, 'success');
                            break;

                        case 'kick':
                            await member.kick(data.reason || 'Kicked from web dashboard');
                            result = 'User kicked';
                            addAuditLog('User Kicked', { tag: 'Web Dashboard', id: 'web' }, `${member.user.tag} kicked`, 'warning');
                            break;

                        case 'ban':
                            await guild.members.ban(data.userId, { reason: data.reason || 'Banned from web dashboard' });
                            result = 'User banned';
                            addAuditLog('User Banned', { tag: 'Web Dashboard', id: 'web' }, `${member.user.tag} banned`, 'error');
                            break;

                        default:
                            throw new Error('Invalid action');
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: result }));
                } catch (error) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: error.message }));
                }
            });
            return;
        }

        // API: Quick actions
        if (pathname === '/api/quick-action' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);

                    if (data.password !== CONFIG.WEB_DASHBOARD_PASSWORD) {
                        res.writeHead(401, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Invalid password' }));
                        return;
                    }

                    let result = '';

                    switch(data.action) {
                        case 'set-online':
                            await client.user.setStatus('online');
                            result = 'Bot status set to online';
                            addAuditLog('Status Changed', { tag: 'Web Dashboard', id: 'web' }, 'Bot status: online', 'info');
                            break;

                        case 'set-offline':
                            await client.user.setStatus('invisible');
                            result = 'Bot status set to offline';
                            addAuditLog('Status Changed', { tag: 'Web Dashboard', id: 'web' }, 'Bot status: offline', 'info');
                            break;

                        case 'clear-audit':
                            const count = auditLog.length;
                            auditLog.length = 0;
                            result = `Cleared ${count} audit entries`;
                            addAuditLog('Audit Log Cleared', { tag: 'Web Dashboard', id: 'web' }, `Cleared ${count} entries`, 'info');
                            break;

                        case 'get-stats':
                            const guild = client.guilds.cache.first();
                            const stats = {
                                totalMembers: guild.memberCount,
                                onlineMembers: guild.members.cache.filter(m => m.presence?.status !== 'offline').size,
                                roles: guild.roles.cache.size,
                                channels: guild.channels.cache.size,
                                auditEntries: auditLog.length,
                                botUptime: Math.floor(process.uptime()),
                                triviaEnabled: triviaEnabled,
                            };
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: true, stats }));
                            return;

                        case 'trivia-on':
                            if (triviaEnabled) {
                                result = 'Trivia is already enabled';
                            } else {
                                triviaEnabled = true;
                                startTriviaSystem();
                                result = 'Trivia enabled! Questions every 25 minutes';
                                addAuditLog('Trivia Enabled', { tag: 'Web Dashboard', id: 'web' }, 'Trivia system started', 'success');
                            }
                            break;

                        case 'trivia-off':
                            if (!triviaEnabled) {
                                result = 'Trivia is already disabled';
                            } else {
                                triviaEnabled = false;
                                if (triviaInterval) {
                                    clearInterval(triviaInterval);
                                    triviaInterval = null;
                                }
                                currentTrivia = null;
                                result = 'Trivia disabled';
                                addAuditLog('Trivia Disabled', { tag: 'Web Dashboard', id: 'web' }, 'Trivia system stopped', 'info');
                            }
                            break;

                        case 'trivia-now':
                            await postTriviaQuestion();
                            result = 'Trivia question posted!';
                            break;

                        case 'trivia-scores':
                            if (triviaScores.size === 0) {
                                result = 'No trivia scores yet';
                            } else {
                                const sortedScores = Array.from(triviaScores.entries())
                                    .sort((a, b) => b[1] - a[1])
                                    .slice(0, 10);

                                const scoresData = await Promise.all(sortedScores.map(async ([userId, score]) => {
                                    const user = await client.users.fetch(userId).catch(() => null);
                                    return { userId, tag: user?.tag || 'Unknown', score };
                                }));

                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ success: true, scores: scoresData }));
                                return;
                            }
                            break;

                        default:
                            throw new Error('Invalid action');
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: result }));
                } catch (error) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: error.message }));
                }
            });
            return;
        }

        // API: Get banned words
        if (pathname === '/api/banned-words' && req.method === 'GET') {
            const password = url.searchParams.get('password');
            if (password !== CONFIG.WEB_DASHBOARD_PASSWORD) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid password' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ words: bannedWords, offenses: Object.fromEntries(offenseTracker) }));
            return;
        }

        // API: Update banned words
        if (pathname === '/api/banned-words' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);
                    if (data.password !== CONFIG.WEB_DASHBOARD_PASSWORD) {
                        res.writeHead(401, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Invalid password' }));
                        return;
                    }

                    if (data.action === 'add' && data.word) {
                        const word = data.word.toLowerCase().trim();
                        if (!bannedWords.includes(word)) {
                            bannedWords.push(word);
                            addAuditLog('Banned Word Added', { tag: 'Web Dashboard', id: 'web' }, `Added: "${word}"`, 'info');
                        }
                        saveBannedWordsToDisk();
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, words: bannedWords }));
                    } else if (data.action === 'remove' && data.word) {
                        const word = data.word.toLowerCase().trim();
                        bannedWords = bannedWords.filter(w => w.toLowerCase() !== word);
                        addAuditLog('Banned Word Removed', { tag: 'Web Dashboard', id: 'web' }, `Removed: "${word}"`, 'info');
                        saveBannedWordsToDisk();
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, words: bannedWords }));
                    } else if (data.action === 'reset-offenses' && data.userId) {
                        offenseTracker.delete(data.userId);
                        addAuditLog('Offenses Reset', { tag: 'Web Dashboard', id: 'web' }, `Reset offenses for ${data.userId}`, 'info');
                        saveBannedWordsToDisk();
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true }));
                    } else {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Invalid action' }));
                    }
                } catch (error) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: error.message }));
                }
            });
            return;
        }

        // API: Get voice log
        if (pathname === '/api/voice-log' && req.method === 'GET') {
            const password = url.searchParams.get('password');
            if (password !== CONFIG.WEB_DASHBOARD_PASSWORD) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid password' }));
                return;
            }
            const dateFilter = url.searchParams.get('date');
            const today = getDateKey(new Date());
            const targetDate = dateFilter || today;

            const voiceDates = Array.from(voiceLogs.keys()).sort().reverse();
            const memberDates = Array.from(memberLogs.keys()).sort().reverse();
            const allDates = [...new Set([...voiceDates, ...memberDates])].sort().reverse();

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                dates: allDates,
                selectedDate: targetDate,
                voiceLog: voiceLogs.get(targetDate) || [],
                memberLog: memberLogs.get(targetDate) || [],
            }));
            return;
        }

        // Main dashboard HTML
        if (pathname === '/' || pathname === '/dashboard') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(generateDashboardHTML());
            return;
        }

        // Default: bot status
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`Bot Online: ${client.user?.tag || 'Starting...'}\nUptime: ${Math.floor(process.uptime())} seconds\nAudit Entries: ${auditLog.length}`);
    });

    const PORT = process.env.PORT || 10000;
    const HOST = process.env.HOST || '127.0.0.1';
    server.listen(PORT, HOST, () => {
        console.log(`âœ… Web dashboard running on port ${PORT}`);
        console.log(`ðŸ“Š Access at: http://${HOST}:${PORT}/dashboard`);
    });
}

// Dashboard HTML function
function generateDashboardHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>The Commission Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }

        :root {
            --bg-primary: #090a0c;
            --bg-secondary: #121419;
            --bg-tertiary: #1a1d23;
            --bg-hover: #23272f;
            --accent: #a9172f;
            --accent-hover: #cc2440;
            --success: #45a675;
            --warning: #d39a42;
            --danger: #c93646;
            --text-primary: #f1eee7;
            --text-secondary: #b8b2a7;
            --text-muted: #79766f;
            --border: #30343c;
        }

        body {
            font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            line-height: 1.6;
        }

        .container { max-width: 1400px; margin: 0 auto; padding: 20px; }

        .login-screen { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .login-box { background: var(--bg-secondary); border-radius: 16px; padding: 40px; width: 100%; max-width: 420px; border: 1px solid var(--border); }
        .login-box h1 { font-size: 28px; margin-bottom: 8px; font-weight: 700; }
        .login-box p { color: var(--text-secondary); margin-bottom: 24px; }

        .header { background: var(--bg-secondary); border-radius: 12px; padding: 20px 24px; margin-bottom: 24px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border); }
        .header-left { display: flex; align-items: center; gap: 16px; }
        .bot-status { display: flex; align-items: center; gap: 8px; background: var(--bg-tertiary); padding: 8px 16px; border-radius: 8px; }
        .status-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--success); animation: pulse 2s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

        .tabs { display: flex; gap: 8px; margin-bottom: 24px; background: var(--bg-secondary); padding: 8px; border-radius: 12px; border: 1px solid var(--border); overflow-x: auto; }
        .tab { padding: 12px 24px; background: transparent; border: none; color: var(--text-secondary); cursor: pointer; border-radius: 8px; font-weight: 500; transition: all 0.2s; white-space: nowrap; font-size: 14px; }
        .tab:hover { background: var(--bg-hover); color: var(--text-primary); }
        .tab.active { background: var(--accent); color: white; }

        .tab-content { display: none; }
        .tab-content.active { display: block; }

        .card { background: var(--bg-secondary); border-radius: 12px; padding: 24px; margin-bottom: 20px; border: 1px solid var(--border); }
        .card h2 { font-size: 18px; margin-bottom: 16px; font-weight: 600; }

        .form-group { margin-bottom: 20px; }
        .form-group label { display: block; margin-bottom: 8px; color: var(--text-secondary); font-size: 14px; font-weight: 500; }

        input[type="text"], input[type="password"], input[type="number"], textarea, select {
            width: 100%; padding: 12px 16px; background: var(--bg-tertiary); border: 1px solid var(--border);
            border-radius: 8px; color: var(--text-primary); font-family: inherit; font-size: 14px; transition: all 0.2s;
        }
        input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent); background: var(--bg-primary); }
        textarea { resize: vertical; min-height: 120px; }

        .btn { padding: 12px 24px; border: none; border-radius: 8px; font-weight: 500; cursor: pointer; transition: all 0.2s; font-size: 14px; font-family: inherit; }
        .btn-primary { background: var(--accent); color: white; }
        .btn-primary:hover { background: var(--accent-hover); }
        .btn-success { background: var(--success); color: white; }
        .btn-warning { background: var(--warning); color: white; }
        .btn-danger { background: var(--danger); color: white; }
        .btn-secondary { background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border); }
        .btn-secondary:hover { background: var(--bg-hover); }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }

        .alert { padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; display: none; }
        .alert.show { display: block; }
        .alert-success { background: rgba(59, 165, 93, 0.1); border: 1px solid var(--success); color: var(--success); }
        .alert-error { background: rgba(237, 66, 69, 0.1); border: 1px solid var(--danger); color: var(--danger); }

        .audit-entry { background: var(--bg-tertiary); padding: 16px; border-radius: 8px; margin-bottom: 12px; border-left: 3px solid var(--accent); }
        .audit-entry.warning { border-left-color: var(--warning); }
        .audit-entry.error { border-left-color: var(--danger); }
        .audit-entry.success { border-left-color: var(--success); }
        .audit-header { display: flex; justify-content: space-between; margin-bottom: 8px; }
        .audit-time { color: var(--text-muted); font-size: 12px; }
        .audit-action { font-weight: 600; font-size: 14px; }
        .audit-user { color: var(--text-secondary); font-size: 13px; }
        .audit-details { color: var(--text-secondary); font-size: 13px; margin-top: 4px; }

        .user-card { background: var(--bg-tertiary); border-radius: 8px; padding: 16px; margin-bottom: 12px; display: flex; gap: 16px; align-items: flex-start; }
        .user-avatar { width: 64px; height: 64px; border-radius: 50%; flex-shrink: 0; }
        .user-info { flex: 1; }
        .user-tag { font-weight: 600; font-size: 16px; margin-bottom: 4px; }
        .user-id { color: var(--text-muted); font-size: 12px; margin-bottom: 8px; }
        .user-meta { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 12px; }
        .user-meta-item { font-size: 13px; color: var(--text-secondary); }
        .user-actions { display: flex; gap: 8px; flex-wrap: wrap; }
        .user-actions .btn { padding: 8px 16px; font-size: 13px; }

        .quick-actions-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; }
        .quick-action-btn { background: var(--bg-tertiary); border: 1px solid var(--border); padding: 20px; border-radius: 8px; cursor: pointer; transition: all 0.2s; text-align: center; }
        .quick-action-btn:hover { background: var(--bg-hover); border-color: var(--accent); }
        .quick-action-icon { font-size: 32px; margin-bottom: 8px; }
        .quick-action-label { font-weight: 500; font-size: 14px; }

        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; margin-top: 20px; }
        .stat-card { background: var(--bg-tertiary); padding: 20px; border-radius: 8px; text-align: center; }
        .stat-value { font-size: 28px; font-weight: 700; color: var(--accent); }
        .stat-label { color: var(--text-secondary); font-size: 13px; margin-top: 4px; }

        .role-item { background: var(--bg-tertiary); padding: 16px; border-radius: 8px; margin-bottom: 12px; }
        .role-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
        .role-name { font-weight: 600; display: flex; align-items: center; gap: 8px; }
        .role-badge { width: 12px; height: 12px; border-radius: 50%; }
        .role-members { color: var(--text-muted); font-size: 13px; }
        .permissions-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px; margin-top: 12px; }
        .permission-item { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary); }

        .hidden { display: none !important; }
        .text-success { color: var(--success); }
        .text-warning { color: var(--warning); }
        .text-danger { color: var(--danger); }
        .mt-2 { margin-top: 8px; }
        .mb-2 { margin-bottom: 8px; }

        .loading { text-align: center; padding: 40px; color: var(--text-muted); }

        @media (max-width: 768px) {
            .container { padding: 12px; }
            .header { flex-direction: column; gap: 12px; }
            .tabs { overflow-x: scroll; }
            .quick-actions-grid { grid-template-columns: 1fr 1fr; }
        }
    </style>
</head>
<body>
    <div id="loginScreen" class="login-screen">
        <div class="login-box">
            <h1>The Commission</h1>
            <p>Enter password to access dashboard</p>
            <div id="loginAlert" class="alert"></div>
            <div class="form-group">
                <label>Password</label>
                <input type="password" id="loginPassword" placeholder="Enter dashboard password">
            </div>
            <button class="btn btn-primary" onclick="login()" style="width: 100%;">Login</button>
        </div>
    </div>

    <div id="dashboard" class="hidden container">
        <div class="header">
            <div class="header-left">
                <h1>The Commission Dashboard</h1>
                <div class="bot-status">
                    <div class="status-dot"></div>
                    <span id="botStatus">Online</span>
                </div>
            </div>
            <button class="btn btn-secondary" onclick="logout()">Logout</button>
        </div>

        <div class="tabs">
            <button class="tab active" onclick="showTab('messages', this)">ðŸ“¨ Messages</button>
            <button class="tab" onclick="showTab('users', this)">ðŸ‘¥ Users</button>
            <button class="tab" onclick="showTab('actions', this)">âš¡ Quick Actions</button>
            <button class="tab" onclick="showTab('audit', this)">ðŸ“‹ Audit Log</button>
            <button class="tab" onclick="showTab('roles', this)">ðŸ” Roles</button>
            <button class="tab" onclick="showTab('words', this)">ðŸš« Banned Words</button>
            <button class="tab" onclick="showTab('activity', this)">ðŸ“‹ Join/Leave Audits</button>
        </div>

        <div id="tab-messages" class="tab-content active">
            <div class="card">
                <h2>Send Message to Main Chat</h2>
                <div id="messageAlert" class="alert"></div>
                <div class="form-group">
                    <label>Message</label>
                    <textarea id="messageText" placeholder="Type your message here..."></textarea>
                </div>
                <button class="btn btn-primary" onclick="sendMessage()">Send to Main Chat</button>
            </div>
        </div>

        <div id="tab-users" class="tab-content">
            <div class="card">
                <h2>User Management</h2>
                <div id="userAlert" class="alert"></div>
                <div class="form-group">
                    <label>Search Users</label>
                    <input type="text" id="userSearch" placeholder="Enter username, tag, or ID...">
                </div>
                <button class="btn btn-primary" onclick="searchUsers()">Search</button>
                <div id="userResults" class="mt-2"></div>
            </div>
        </div>

        <div id="tab-actions" class="tab-content">
            <div class="card">
                <h2>Quick Actions</h2>
                <div id="actionAlert" class="alert"></div>
                <div class="quick-actions-grid">
                    <div class="quick-action-btn" onclick="quickAction('set-online')">
                        <div class="quick-action-icon">ðŸŸ¢</div>
                        <div class="quick-action-label">Set Online</div>
                    </div>
                    <div class="quick-action-btn" onclick="quickAction('set-offline')">
                        <div class="quick-action-icon">âš«</div>
                        <div class="quick-action-label">Set Offline</div>
                    </div>
                    <div class="quick-action-btn" onclick="quickAction('clear-audit')">
                        <div class="quick-action-icon">ðŸ—‘ï¸</div>
                        <div class="quick-action-label">Clear Audit</div>
                    </div>
                </div>
            </div>
            <div class="card">
                <h2>Server Statistics</h2>
                <button class="btn btn-secondary mb-2" onclick="loadStats()">Refresh Stats</button>
                <div id="statsContainer" class="stats-grid"></div>
            </div>
        </div>

        <div id="tab-audit" class="tab-content">
            <div class="card">
                <h2>Audit Log</h2>
                <button class="btn btn-secondary mb-2" onclick="loadAuditLog()">Refresh</button>
                <div id="auditLog"></div>
            </div>
        </div>

        <div id="tab-roles" class="tab-content">
            <div class="card">
                <h2>Server Roles & Permissions</h2>
                <button class="btn btn-secondary mb-2" onclick="loadRoles()">Refresh</button>
                <div id="rolesContainer"></div>
            </div>
        </div>

        <div id="tab-words" class="tab-content">
            <div class="card">
                <h2>ðŸš« Banned Words (Auto-Jail)</h2>
                <p style="color: var(--text-secondary); margin-bottom: 16px;">1st offense = 5 min jail | 2nd offense = 30 min jail | 3rd+ = permanent jail</p>
                <div id="wordsAlert" class="alert"></div>
                <div class="form-group" style="display: flex; gap: 8px;">
                    <input type="text" id="newWord" placeholder="Add a new banned word or phrase..." style="flex: 1;">
                    <button class="btn btn-danger" onclick="addBannedWord()">Add</button>
                </div>
                <button class="btn btn-secondary mb-2" onclick="loadBannedWords()">Refresh</button>
                <div id="bannedWordsList" style="margin-top: 12px;"></div>
            </div>
            <div class="card">
                <h2>Offense Tracker</h2>
                <p style="color: var(--text-secondary); margin-bottom: 16px;">Users who have triggered banned words</p>
                <div id="offensesList"></div>
            </div>
        </div>

        <div id="tab-activity" class="tab-content">
            <div class="card">
                <h2>ðŸ“‹ Join/Leave Audits</h2>
                <div style="display: flex; gap: 12px; align-items: center; margin-bottom: 16px;">
                    <label style="color: var(--text-secondary); font-size: 14px;">Select Date:</label>
                    <select id="activityDate" onchange="loadActivity()" style="padding: 8px 12px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 6px; color: var(--text-primary); font-size: 14px;">
                        <option value="">Today</option>
                    </select>
                    <button class="btn btn-secondary" onclick="loadActivity()" style="padding: 8px 16px;">Refresh</button>
                    <span id="activityDateLabel" style="color: var(--text-muted); font-size: 13px;"></span>
                </div>
            </div>
            <div class="card">
                <h2>ðŸŽ¤ Voice Chat Join / Leave Log</h2>
                <div id="voiceLogContainer" style="max-height: 500px; overflow-y: auto;"></div>
            </div>
            <div class="card">
                <h2>ðŸ“¥ Server Join / Leave Log</h2>
                <div id="memberLogContainer" style="max-height: 500px; overflow-y: auto;"></div>
            </div>
        </div>
    </div>

    <script>
        let password = '';

        function login() {
            password = document.getElementById('loginPassword').value;
            if (!password) {
                showAlert('loginAlert', 'Please enter password', 'error');
                return;
            }
            fetch('/api/audit-log?password=' + encodeURIComponent(password))
                .then(r => r.json())
                .then(data => {
                    if (data.error) {
                        showAlert('loginAlert', 'Invalid password', 'error');
                    } else {
                        document.getElementById('loginScreen').classList.add('hidden');
                        document.getElementById('dashboard').classList.remove('hidden');
                        document.getElementById('botStatus').textContent = data.botTag || 'Online';
                        loadAuditLog();
                    }
                })
                .catch(err => showAlert('loginAlert', 'Error: ' + err.message, 'error'));
        }

        function logout() {
            password = '';
            document.getElementById('loginScreen').classList.remove('hidden');
            document.getElementById('dashboard').classList.add('hidden');
            document.getElementById('loginPassword').value = '';
        }

        function showTab(tabName, el) {
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.getElementById('tab-' + tabName).classList.add('active');
            el.classList.add('active');
            if (tabName === 'audit') loadAuditLog();
            if (tabName === 'roles') loadRoles();
            if (tabName === 'actions') loadStats();
            if (tabName === 'words') loadBannedWords();
            if (tabName === 'activity') loadActivity();
        }

        function showAlert(id, message, type) {
            const alert = document.getElementById(id);
            alert.textContent = message;
            alert.className = 'alert alert-' + type + ' show';
            setTimeout(() => alert.classList.remove('show'), 5000);
        }

        async function sendMessage() {
            const message = document.getElementById('messageText').value;
            if (!message) return showAlert('messageAlert', 'Please enter a message', 'error');
            try {
                const res = await fetch('/api/send-message', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password, message })
                });
                const data = await res.json();
                if (data.success) {
                    showAlert('messageAlert', 'Message sent!', 'success');
                    document.getElementById('messageText').value = '';
                } else {
                    showAlert('messageAlert', data.error || 'Error', 'error');
                }
            } catch (err) {
                showAlert('messageAlert', 'Error: ' + err.message, 'error');
            }
        }

        async function searchUsers() {
            const query = document.getElementById('userSearch').value;
            if (!query) return showAlert('userAlert', 'Enter search term', 'error');
            try {
                const res = await fetch('/api/users/search?password=' + encodeURIComponent(password) + '&query=' + encodeURIComponent(query));
                const data = await res.json();
                if (data.error) return showAlert('userAlert', data.error, 'error');
                const container = document.getElementById('userResults');
                if (data.users.length === 0) {
                    container.innerHTML = '<p style="color: var(--text-muted); text-align: center; padding: 20px;">No users found</p>';
                    return;
                }
                container.innerHTML = data.users.map(user =>
                    '<div class="user-card">' +
                        '<img src="' + user.avatar + '" class="user-avatar" alt="Avatar">' +
                        '<div class="user-info">' +
                            '<div class="user-tag">' + user.tag + '</div>' +
                            '<div class="user-id">ID: ' + user.id + '</div>' +
                            '<div class="user-meta">' +
                                '<span class="user-meta-item">Joined: ' + new Date(user.joinedAt).toLocaleDateString() + '</span>' +
                                '<span class="user-meta-item">Account: ' + new Date(user.accountCreatedAt).toLocaleDateString() + '</span>' +
                                '<span class="user-meta-item ' + (user.timedOut ? 'text-warning' : '') + '">' + (user.timedOut ? 'â±ï¸ Timed Out' : 'âœ… Active') + '</span>' +
                            '</div>' +
                            '<div class="user-actions">' +
                                '<button class="btn btn-warning" onclick="timeoutUser(\\'' + user.id + '\\', \\'' + user.tag + '\\')">Timeout</button>' +
                                (user.timedOut ? '<button class="btn btn-success" onclick="untimeoutUser(\\'' + user.id + '\\', \\'' + user.tag + '\\')">Remove Timeout</button>' : '') +
                                '<button class="btn btn-danger" onclick="kickUser(\\'' + user.id + '\\', \\'' + user.tag + '\\')">Kick</button>' +
                                '<button class="btn btn-danger" onclick="banUser(\\'' + user.id + '\\', \\'' + user.tag + '\\')">Ban</button>' +
                            '</div>' +
                        '</div>' +
                    '</div>'
                ).join('');
            } catch (err) {
                showAlert('userAlert', 'Error: ' + err.message, 'error');
            }
        }

        async function timeoutUser(userId, tag) {
            const duration = prompt('Timeout duration in minutes:', '60');
            if (!duration) return;
            const reason = prompt('Reason (optional):', '');
            try {
                const res = await fetch('/api/users/action', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password, userId, action: 'timeout', duration, reason })
                });
                const data = await res.json();
                if (data.success) {
                    showAlert('userAlert', tag + ' timed out for ' + duration + ' minutes', 'success');
                    searchUsers();
                } else {
                    showAlert('userAlert', data.error, 'error');
                }
            } catch (err) {
                showAlert('userAlert', 'Error: ' + err.message, 'error');
            }
        }

        async function untimeoutUser(userId, tag) {
            try {
                const res = await fetch('/api/users/action', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password, userId, action: 'untimeout' })
                });
                const data = await res.json();
                if (data.success) {
                    showAlert('userAlert', tag + ' timeout removed', 'success');
                    searchUsers();
                } else {
                    showAlert('userAlert', data.error, 'error');
                }
            } catch (err) {
                showAlert('userAlert', 'Error: ' + err.message, 'error');
            }
        }

        async function kickUser(userId, tag) {
            if (!confirm('Kick ' + tag + '?')) return;
            const reason = prompt('Reason (optional):', '');
            try {
                const res = await fetch('/api/users/action', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password, userId, action: 'kick', reason })
                });
                const data = await res.json();
                if (data.success) {
                    showAlert('userAlert', tag + ' kicked', 'success');
                    searchUsers();
                } else {
                    showAlert('userAlert', data.error, 'error');
                }
            } catch (err) {
                showAlert('userAlert', 'Error: ' + err.message, 'error');
            }
        }

        async function banUser(userId, tag) {
            if (!confirm('Ban ' + tag + '? This is permanent.')) return;
            const reason = prompt('Reason (optional):', '');
            try {
                const res = await fetch('/api/users/action', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password, userId, action: 'ban', reason })
                });
                const data = await res.json();
                if (data.success) {
                    showAlert('userAlert', tag + ' banned', 'success');
                    searchUsers();
                } else {
                    showAlert('userAlert', data.error, 'error');
                }
            } catch (err) {
                showAlert('userAlert', 'Error: ' + err.message, 'error');
            }
        }

        async function quickAction(action) {
            try {
                const res = await fetch('/api/quick-action', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password, action })
                });
                const data = await res.json();
                if (data.success) {
                    showAlert('actionAlert', data.message || 'Action completed', 'success');
                    if (action === 'get-stats') displayStats(data.stats);
                } else {
                    showAlert('actionAlert', data.error, 'error');
                }
            } catch (err) {
                showAlert('actionAlert', 'Error: ' + err.message, 'error');
            }
        }

        async function loadStats() {
            try {
                const res = await fetch('/api/quick-action', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password, action: 'get-stats' })
                });
                const data = await res.json();
                if (data.success && data.stats) displayStats(data.stats);
            } catch (err) {
                console.error('Error loading stats:', err);
            }
        }

        function displayStats(stats) {
            const container = document.getElementById('statsContainer');
            const uptimeHours = Math.floor(stats.botUptime / 3600);
            const uptimeMins = Math.floor((stats.botUptime % 3600) / 60);
            container.innerHTML =
                '<div class="stat-card"><div class="stat-value">' + stats.totalMembers + '</div><div class="stat-label">Total Members</div></div>' +
                '<div class="stat-card"><div class="stat-value">' + stats.onlineMembers + '</div><div class="stat-label">Online Now</div></div>' +
                '<div class="stat-card"><div class="stat-value">' + stats.roles + '</div><div class="stat-label">Roles</div></div>' +
                '<div class="stat-card"><div class="stat-value">' + stats.channels + '</div><div class="stat-label">Channels</div></div>' +
                '<div class="stat-card"><div class="stat-value">' + stats.auditEntries + '</div><div class="stat-label">Audit Entries</div></div>' +
                '<div class="stat-card"><div class="stat-value">' + uptimeHours + 'h ' + uptimeMins + 'm</div><div class="stat-label">Bot Uptime</div></div>' +
                '<div class="stat-card"><div class="stat-value">' + (stats.triviaEnabled ? 'âœ… ON' : 'âŒ OFF') + '</div><div class="stat-label">Trivia System</div></div>';
        }

        async function loadAuditLog() {
            try {
                const res = await fetch('/api/audit-log?password=' + encodeURIComponent(password));
                const data = await res.json();
                if (data.error) return;
                const container = document.getElementById('auditLog');
                if (data.logs.length === 0) {
                    container.innerHTML = '<p style="color: var(--text-muted); text-align: center; padding: 20px;">No audit entries</p>';
                    return;
                }
                container.innerHTML = data.logs.map(function(log) {
                    const time = new Date(log.timestamp).toLocaleString();
                    const severity = log.severity || 'info';
                    return '<div class="audit-entry ' + severity + '">' +
                        '<div class="audit-header">' +
                            '<span class="audit-action">' + log.action + '</span>' +
                            '<span class="audit-time">' + time + '</span>' +
                        '</div>' +
                        '<div class="audit-user">By: ' + log.user + '</div>' +
                        '<div class="audit-details">' + log.details + '</div>' +
                    '</div>';
                }).join('');
            } catch (err) {
                console.error('Error loading audit log:', err);
            }
        }

        async function loadRoles() {
            try {
                const res = await fetch('/api/roles?password=' + encodeURIComponent(password));
                const data = await res.json();
                if (data.error) {
                    document.getElementById('rolesContainer').innerHTML = '<p style="color: var(--text-danger);">' + data.error + '</p>';
                    return;
                }
                const container = document.getElementById('rolesContainer');
                if (!data.roles || data.roles.length === 0) {
                    container.innerHTML = '<p style="color: var(--text-muted); text-align: center; padding: 20px;">No roles found</p>';
                    return;
                }
                container.innerHTML = data.roles.map(function(role) {
                    return '<div class="role-item">' +
                        '<div class="role-header">' +
                            '<div class="role-name">' +
                                '<span class="role-badge" style="background-color: ' + role.color + '"></span>' +
                                role.name +
                            '</div>' +
                            '<div class="role-members">' + role.members + ' members</div>' +
                        '</div>' +
                        '<div class="permissions-grid">' +
                            Object.entries(role.permissions).map(function(entry) {
                                return '<div class="permission-item">' +
                                    '<span>' + (entry[1] ? 'âœ…' : 'âŒ') + '</span>' +
                                    '<span>' + formatPermissionName(entry[0]) + '</span>' +
                                '</div>';
                            }).join('') +
                        '</div>' +
                    '</div>';
                }).join('');
            } catch (err) {
                console.error('Error loading roles:', err);
            }
        }

        function formatPermissionName(key) {
            return key.replace(/([A-Z])/g, ' $1').trim().split(' ').map(function(word) { return word.charAt(0).toUpperCase() + word.slice(1); }).join(' ');
        }

        // Banned Words functions
        async function loadBannedWords() {
            try {
                const res = await fetch('/api/banned-words?password=' + encodeURIComponent(password));
                const data = await res.json();
                if (data.error) return;

                var container = document.getElementById('bannedWordsList');
                if (data.words.length === 0) {
                    container.innerHTML = '<p style="color: var(--text-muted);">No banned words configured</p>';
                } else {
                    container.innerHTML = data.words.map(function(word) {
                        return '<div style="display: inline-flex; align-items: center; gap: 8px; background: var(--bg-tertiary); padding: 8px 12px; border-radius: 6px; margin: 4px; border: 1px solid var(--border);">' +
                            '<span>' + word + '</span>' +
                            '<button onclick="removeBannedWord(\\'' + word.replace(/'/g, "\\\\'") + '\\')" style="background: var(--danger); color: white; border: none; border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 12px;">X</button>' +
                        '</div>';
                    }).join('');
                }

                var offContainer = document.getElementById('offensesList');
                var offEntries = Object.entries(data.offenses || {});
                if (offEntries.length === 0) {
                    offContainer.innerHTML = '<p style="color: var(--text-muted);">No offenses recorded</p>';
                } else {
                    offContainer.innerHTML = offEntries.map(function(entry) {
                        var uid = entry[0];
                        var count = entry[1];
                        var label = count === 1 ? '5 min jail' : count === 2 ? '30 min jail' : 'Permanent jail';
                        return '<div style="display: flex; justify-content: space-between; align-items: center; background: var(--bg-tertiary); padding: 12px; border-radius: 8px; margin-bottom: 8px; border-left: 3px solid var(--warning);">' +
                            '<div><span style="font-weight: 600;">User ID: ' + uid + '</span><br><span style="color: var(--text-secondary); font-size: 13px;">Offenses: ' + count + ' (' + label + ')</span></div>' +
                            '<button onclick="resetOffenses(\\'' + uid + '\\')" class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;">Reset</button>' +
                        '</div>';
                    }).join('');
                }
            } catch (err) {
                console.error('Error loading banned words:', err);
            }
        }

        async function addBannedWord() {
            var word = document.getElementById('newWord').value.trim();
            if (!word) return showAlert('wordsAlert', 'Enter a word or phrase', 'error');
            try {
                var res = await fetch('/api/banned-words', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: password, action: 'add', word: word })
                });
                var data = await res.json();
                if (data.success) {
                    showAlert('wordsAlert', 'Added: ' + word, 'success');
                    document.getElementById('newWord').value = '';
                    loadBannedWords();
                } else {
                    showAlert('wordsAlert', data.error, 'error');
                }
            } catch (err) {
                showAlert('wordsAlert', 'Error: ' + err.message, 'error');
            }
        }

        async function removeBannedWord(word) {
            try {
                var res = await fetch('/api/banned-words', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: password, action: 'remove', word: word })
                });
                var data = await res.json();
                if (data.success) {
                    showAlert('wordsAlert', 'Removed: ' + word, 'success');
                    loadBannedWords();
                }
            } catch (err) {
                showAlert('wordsAlert', 'Error: ' + err.message, 'error');
            }
        }

        async function resetOffenses(userId) {
            try {
                var res = await fetch('/api/banned-words', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: password, action: 'reset-offenses', userId: userId })
                });
                var data = await res.json();
                if (data.success) {
                    showAlert('wordsAlert', 'Offenses reset for ' + userId, 'success');
                    loadBannedWords();
                }
            } catch (err) {
                showAlert('wordsAlert', 'Error: ' + err.message, 'error');
            }
        }

        // Activity tab functions
        async function loadActivity() {
            try {
                var dateSelect = document.getElementById('activityDate');
                var selectedDate = dateSelect.value;
                var url = '/api/voice-log?password=' + encodeURIComponent(password);
                if (selectedDate) url += '&date=' + selectedDate;

                var res = await fetch(url);
                var data = await res.json();
                if (data.error) return;

                // Update date dropdown
                var currentVal = dateSelect.value;
                dateSelect.innerHTML = '';

                // Add today option
                var todayKey = new Date().toISOString().split('T')[0];
                var todayOpt = document.createElement('option');
                todayOpt.value = '';
                todayOpt.textContent = 'Today (' + todayKey + ')';
                dateSelect.appendChild(todayOpt);

                // Add available dates
                if (data.dates) {
                    data.dates.forEach(function(d) {
                        if (d !== todayKey) {
                            var opt = document.createElement('option');
                            opt.value = d;
                            var dateObj = new Date(d + 'T12:00:00');
                            opt.textContent = dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
                            dateSelect.appendChild(opt);
                        }
                    });
                }

                dateSelect.value = currentVal;

                // Show selected date
                document.getElementById('activityDateLabel').textContent = 'Showing: ' + (data.selectedDate || todayKey) + ' (' + (data.voiceLog.length) + ' voice / ' + (data.memberLog.length) + ' member entries)';

                // Voice log
                var vContainer = document.getElementById('voiceLogContainer');
                if (!data.voiceLog || data.voiceLog.length === 0) {
                    vContainer.innerHTML = '<p style="color: var(--text-muted); text-align: center; padding: 20px;">No voice activity for this date</p>';
                } else {
                    vContainer.innerHTML = data.voiceLog.map(function(entry) {
                        var color, icon, actionText;
                        if (entry.action === 'joined') {
                            color = 'var(--success)'; icon = 'ðŸŸ¢'; actionText = 'joined';
                        } else if (entry.action === 'switched') {
                            color = 'var(--warning)'; icon = 'ðŸ”„'; actionText = 'switched from';
                        } else {
                            color = 'var(--danger)'; icon = 'ðŸ”´'; actionText = 'left';
                        }
                        var durText = entry.duration ? ' â€” <strong>' + entry.duration + '</strong>' : '';
                        var toText = entry.toChannel ? ' â†’ <strong>#' + entry.toChannel + '</strong>' : '';
                        return '<div style="background: var(--bg-tertiary); padding: 10px 14px; border-radius: 6px; margin-bottom: 4px; border-left: 3px solid ' + color + '; font-size: 13px;">' +
                            '<span style="color: var(--text-muted); font-size: 11px; float: right;">' + entry.timeStr + '</span>' +
                            icon + ' <strong>' + entry.username + '</strong> ' +
                            '<span style="color: ' + color + ';">' + actionText + '</span> ' +
                            '<strong>#' + entry.channelName + '</strong>' + toText + durText +
                        '</div>';
                    }).join('');
                }

                // Member log
                var mContainer = document.getElementById('memberLogContainer');
                if (!data.memberLog || data.memberLog.length === 0) {
                    mContainer.innerHTML = '<p style="color: var(--text-muted); text-align: center; padding: 20px;">No member activity for this date</p>';
                } else {
                    mContainer.innerHTML = data.memberLog.map(function(entry) {
                        var color = entry.action === 'joined' ? 'var(--success)' : 'var(--danger)';
                        var icon = entry.action === 'joined' ? 'ðŸ“¥' : 'ðŸ“¤';
                        var actionText = entry.action === 'joined' ? 'joined the server' : 'left the server';
                        return '<div style="background: var(--bg-tertiary); padding: 10px 14px; border-radius: 6px; margin-bottom: 4px; border-left: 3px solid ' + color + '; font-size: 13px;">' +
                            '<span style="color: var(--text-muted); font-size: 11px; float: right;">' + entry.timeStr + '</span>' +
                            icon + ' <strong>' + entry.username + '</strong> ' +
                            '<span style="color: ' + color + ';">' + actionText + '</span> at ' + entry.timeStr +
                        '</div>';
                    }).join('');
                }
            } catch (err) {
                console.error('Error loading activity:', err);
            }
        }

        setInterval(function() {
            if (document.getElementById('tab-audit').classList.contains('active')) loadAuditLog();
            if (document.getElementById('tab-activity').classList.contains('active')) loadActivity();
        }, 10000);

        document.addEventListener('DOMContentLoaded', function() {
            document.getElementById('loginPassword').addEventListener('keypress', function(e) {
                if (e.key === 'Enter') login();
            });
        });
    </script>
</body>
</html>`;
}

function sendBlueprintMessage(message) {
    if (typeof process.send === 'function') process.send(message);
}

process.on('message', async message => {
    if (!message) return;
    if (message.channel === 'commission:memberbridge-request') {
        const { id, action, payload = {} } = message;
        try {
            if (!client.isReady()) throw new Error('Start the bot and wait for Discord to connect first.');
            const data = await memberBridgeIntegration.admin(action, payload);
            if (typeof process.send === 'function') process.send({ channel: 'commission:memberbridge-response', id, ok: true, data });
        } catch (error) {
            if (typeof process.send === 'function') process.send({ channel: 'commission:memberbridge-response', id, ok: false, error: error.message });
        }
        return;
    }
    if (message.channel === 'commission:economy-request') {
        const { id, action, payload = {} } = message;
        try {
            if (!client.isReady()) throw new Error('Start the bot and wait for Discord to connect first.');
            const guildId = payload.guildId || client.guilds.cache.first()?.id;
            if (!guildId) throw new Error('The bot is not connected to a server.');
            let data;
            if (action === 'stats') data = economy.stats(guildId);
            else if (action === 'leaderboard') data = payload.type === 'rep'
                ? economy.repLeaderboard(guildId, 10)
                : economy.leaderboard(guildId, payload.type || 'balance', 10);
            else if (action === 'push-heist-panel') data = await economyIntegration.pushHeistPanel(guildId, payload.channelId);
            else if (action === 'reset-preview') data = await economyIntegration.previewReset(guildId, payload.action, payload.userId);
            else if (action === 'reset-execute') data = await economyIntegration.executeReset(guildId, payload.token);
            else if (action === 'bulk-grant-preview') data = await economyIntegration.previewBulkGrant(guildId, payload.amount);
            else if (action === 'bulk-grant-execute') data = await economyIntegration.executeBulkGrant(guildId, payload.token);
            else throw new Error(`Unknown economy action: ${action}`);
            if (typeof process.send === 'function') process.send({ channel: 'commission:economy-response', id, ok: true, data });
        } catch (error) {
            if (typeof process.send === 'function') process.send({ channel: 'commission:economy-response', id, ok: false, error: error.message });
        }
        return;
    }
    if (message.channel !== 'commission:blueprint-request') return;
    const { id, action, payload = {} } = message;

    try {
        if (!client.isReady()) throw new Error('Start the bot and wait for Discord to connect first.');

        if (action === 'list-guilds') {
            const guilds = client.guilds.cache
                .map(guild => ({ id: guild.id, name: guild.name, iconUrl: guild.iconURL({ extension: 'png', size: 128 }) }))
                .sort((a, b) => a.name.localeCompare(b.name));
            sendBlueprintMessage({ channel: 'commission:blueprint-response', id, ok: true, data: guilds });
            return;
        }

        if (action === 'capture') {
            const guild = await client.guilds.fetch(payload.guildId);
            sendBlueprintMessage({ channel: 'commission:blueprint-progress', id, message: `Capturing ${guild.name}` });
            const blueprint = await captureGuildBlueprint(guild);
            sendBlueprintMessage({ channel: 'commission:blueprint-response', id, ok: true, data: blueprint });
            return;
        }

        if (action === 'apply') {
            const guild = await client.guilds.fetch(payload.guildId);
            const result = await applyGuildBlueprint(
                guild,
                payload.blueprint,
                { applyEveryonePermissions: Boolean(payload.applyEveryonePermissions) },
                progressMessage => sendBlueprintMessage({
                    channel: 'commission:blueprint-progress',
                    id,
                    message: progressMessage,
                }),
            );
            sendBlueprintMessage({ channel: 'commission:blueprint-response', id, ok: true, data: result });
            return;
        }

        throw new Error(`Unknown blueprint action: ${action}`);
    } catch (error) {
        sendBlueprintMessage({
            channel: 'commission:blueprint-response',
            id,
            ok: false,
            error: error.message,
        });
    }
});

// Login
const TOKEN = process.env.DISCORD_TOKEN || '';
if (!TOKEN) {
    console.error('Discord token is missing. Add it in The Commission control panel.');
    process.exitCode = 1;
} else {
let shuttingDown = false;
async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[system] ${signal} received; closing MemberBridge and Discord cleanly.`);
    try { await memberBridgeIntegration.stop(); } catch (error) { console.error('[MemberBridge shutdown]', error.message); }
    try { economy.close?.(); } catch (error) { console.error('[Economy shutdown]', error.message); }
    try { client.destroy(); } catch {}
    process.exit(0);
}
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.once('SIGINT', () => gracefulShutdown('SIGINT'));

client.login(TOKEN).catch(error => {
        console.error('Discord login failed:', error.message);
        process.exitCode = 1;
    });
}
