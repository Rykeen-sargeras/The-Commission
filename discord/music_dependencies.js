'use strict';

function loadMusicDependencies() {
    try {
        const dependencies = {
            voice: require('@discordjs/voice'),
            playDl: require('play-dl'),
            ytdl: require('@distube/ytdl-core'),
        };
        console.log('✅ Music dependencies loaded');
        return dependencies;
    } catch (error) {
        console.warn('⚠️ Music dependencies not installed. Run: npm install @discordjs/voice play-dl @distube/ytdl-core libsodium-wrappers ffmpeg-static');
        console.warn(error.message);
        return { voice: undefined, playDl: undefined, ytdl: undefined };
    }
}

module.exports = { loadMusicDependencies };
