'use strict';

const { Readable } = require('stream');
const Discord = require('discord.js');
const { NeuttsSynthesizer } = require('./tts/neutts_engine');
const {
    AudioPlayerStatus,
    NoSubscriberBehavior,
    StreamType,
    VoiceConnectionStatus,
    createAudioPlayer,
    createAudioResource,
    entersState,
    joinVoiceChannel,
} = require('@discordjs/voice');

const DISCORD_HOSTS = new Set([
    'discord.com',
    'www.discord.com',
    'ptb.discord.com',
    'canary.discord.com',
]);
const URL_PATTERN = /https?:\/\/[^\s<>]+/gi;
const CUSTOM_EMOJI_PATTERN = /<a?:([\w~]+):\d+>/g;

function parseDiscordMessageLink(raw) {
    let url;
    try {
        url = new URL(String(raw || '').trim());
    } catch {
        throw new Error('Paste a valid Discord message link.');
    }
    if (!DISCORD_HOSTS.has(url.hostname.toLowerCase())) {
        throw new Error('The message link must be from discord.com.');
    }
    const match = url.pathname.match(/^\/channels\/(\d+)\/(\d+)\/(\d+)\/?$/);
    if (!match) {
        throw new Error('In Discord, choose Copy Message Link and paste the complete link.');
    }
    return { guildId: match[1], channelId: match[2], messageId: match[3] };
}

function describeUrl(rawUrl) {
    const punctuation = rawUrl.match(/[),.!?]+$/)?.[0] || '';
    const candidate = punctuation ? rawUrl.slice(0, -punctuation.length) : rawUrl;
    try {
        const url = new URL(candidate);
        return `link to ${url.hostname.replace(/^www\./, '')}${punctuation}`;
    } catch {
        return `link${punctuation}`;
    }
}

function cleanForSpeech(input) {
    return String(input || '')
        .replace(URL_PATTERN, describeUrl)
        .replace(CUSTOM_EMOJI_PATTERN, '$1')
        .replace(/\|\|/g, '')
        .replace(/```[\s\S]*?```/g, ' code block ')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/[*_~>#]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 1800);
}

function messageToSpeech(message, voiceSlot) {
    if (message.system) return null;
    const content = cleanForSpeech(message.cleanContent || message.content || '');
    const attachments = [...message.attachments.values()].map(attachment => {
        const filename = cleanForSpeech(attachment.name || 'file');
        return `shared an attachment${filename ? ` named ${filename}` : ''}`;
    });
    const parts = [content, ...attachments].filter(Boolean);
    if (!parts.length) return null;
    const speaker = cleanForSpeech(
        message.member?.displayName
        || message.author?.globalName
        || message.author?.displayName
        || message.author?.username
        || 'Unknown speaker',
    );
    return {
        id: message.id,
        speakerId: message.author?.id || message.id,
        speaker,
        text: parts.join('. '),
        voiceSlot,
    };
}

function initialState() {
    return {
        status: 'idle',
        currentSpeaker: null,
        currentText: null,
        messageIndex: 0,
        messageCount: 0,
        speed: 1,
        guildName: null,
        textChannelName: null,
        voiceChannelName: null,
        error: null,
        truncated: false,
    };
}

function numericSpeed(value) {
    const speed = Number(value);
    if (!Number.isFinite(speed) || speed < 0.75 || speed > 1.5) {
        throw new Error('Playback speed must be between 0.75 and 1.5.');
    }
    return speed;
}

function messageLimit(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return 500;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 1) return 500;
    return Math.min(2000, Math.floor(parsed));
}

class ConversationTts {
    constructor(client, options = {}) {
        this.client = client;
        const configuredVoices = options.voices ?? process.env.TTS_VOICES ?? 'emily,paul,sophie';
        this.voices = (Array.isArray(configuredVoices) ? configuredVoices : configuredVoices.split(','))
            .map(value => value.trim())
            .filter(Boolean)
            .slice(0, 3);
        if (this.voices.length < 2) this.voices = ['emily', 'paul', 'sophie'];
        this.synthesizer = options.synthesizer || new NeuttsSynthesizer(options.neutts);
        this.allowedGuildIds = new Set(String(
            options.allowedGuildIds
            ?? process.env.TTS_ALLOWED_GUILD_IDS
            ?? process.env.GOING_LIVE_GUILD_ID
            ?? process.env.MEMBERSHIP_GUILD_ID
            ?? '',
        ).split(/[\s,]+/).filter(Boolean));
        this.maxMessages = messageLimit(options.maxMessages ?? process.env.TTS_MAX_MESSAGES);
        this.state = initialState();
        this.queue = [];
        this.index = 0;
        this.runId = 0;
        this.player = null;
        this.connection = null;
        this.abortController = null;
        this.disconnectTimer = null;
    }

    getState() {
        return { ...this.state, ttsConfigured: this.synthesizer.isConfigured() };
    }

    setState(patch) {
        this.state = { ...this.state, ...patch };
    }

    async resolve(rawLink) {
        if (!this.client.isReady()) throw new Error('The Discord bot is still connecting. Try again in a moment.');
        const reference = parseDiscordMessageLink(rawLink);
        if (!this.allowedGuildIds.size) {
            throw new Error('TTS_ALLOWED_GUILD_IDS must be configured before the public reader can access messages.');
        }
        if (this.allowedGuildIds.size && !this.allowedGuildIds.has(reference.guildId)) {
            throw new Error('That message is not in a server enabled for the conversation reader.');
        }
        const guild = await this.client.guilds.fetch(reference.guildId).catch(() => null);
        if (!guild) throw new Error('The bot cannot access the server in that link.');
        await guild.channels.fetch();
        const channel = await guild.channels.fetch(reference.channelId).catch(() => null);
        if (!channel || !channel.isTextBased() || channel.isDMBased()) {
            throw new Error('The linked channel is not an accessible server text channel.');
        }
        const me = guild.members.me;
        const permissions = me ? channel.permissionsFor(me) : null;
        if (!permissions?.has(Discord.PermissionFlagsBits.ViewChannel)
            || !permissions.has(Discord.PermissionFlagsBits.ReadMessageHistory)) {
            throw new Error('The bot needs View Channel and Read Message History in the linked channel.');
        }
        await channel.messages.fetch(reference.messageId).catch(() => {
            throw new Error('The starting message is missing or the bot cannot read it.');
        });
        return {
            guildId: guild.id,
            guildName: guild.name,
            channelId: channel.id,
            channelName: channel.name || 'Discord conversation',
            startMessageId: reference.messageId,
        };
    }

    async fetchConversation(resolved) {
        const guild = await this.client.guilds.fetch(resolved.guildId);
        const channel = await guild.channels.fetch(resolved.channelId);
        if (!channel || !channel.isTextBased() || channel.isDMBased()) {
            throw new Error('The linked text channel is no longer accessible.');
        }
        const discordMessages = [await channel.messages.fetch(resolved.startMessageId)];
        let cursor = resolved.startMessageId;
        while (discordMessages.length < this.maxMessages) {
            const pageLimit = Math.min(100, this.maxMessages - discordMessages.length);
            const page = await channel.messages.fetch({ after: cursor, limit: pageLimit });
            if (!page.size) break;
            const ordered = [...page.values()].sort((a, b) => {
                const left = BigInt(a.id);
                const right = BigInt(b.id);
                return left < right ? -1 : left > right ? 1 : 0;
            });
            discordMessages.push(...ordered);
            cursor = ordered.at(-1)?.id || cursor;
            if (page.size < pageLimit) break;
        }
        let truncated = false;
        if (discordMessages.length >= this.maxMessages) {
            const extra = await channel.messages.fetch({ after: cursor, limit: 1 });
            truncated = extra.size > 0;
        }
        const speakerSlots = new Map();
        const messages = [];
        for (const message of discordMessages) {
            const speakerId = message.author?.id || message.id;
            if (!speakerSlots.has(speakerId)) speakerSlots.set(speakerId, speakerSlots.size % this.voices.length);
            const spoken = messageToSpeech(message, speakerSlots.get(speakerId));
            if (spoken) messages.push(spoken);
        }
        return { messages, truncated };
    }

    async conversation(rawLink) {
        const resolved = await this.resolve(rawLink);
        return { resolved, ...await this.fetchConversation(resolved) };
    }

    async synthesize(text, voiceSlot, speed, signal) {
        return this.synthesizer.synthesize({
            text,
            voice: this.voices[voiceSlot % this.voices.length],
            speed,
            signal,
        });
    }

    async start(rawLink, voiceChannelId, rawSpeed) {
        const speed = numericSpeed(rawSpeed ?? 1);
        this.stop(false);
        const activeRun = ++this.runId;
        this.state = { ...initialState(), status: 'loading', speed };
        try {
            const resolved = await this.resolve(rawLink);
            if (activeRun !== this.runId) return;
            const voiceChannel = await this.client.channels.fetch(String(voiceChannelId || '')).catch(() => null);
            if (!voiceChannel || voiceChannel.guildId !== resolved.guildId
                || voiceChannel.type !== Discord.ChannelType.GuildVoice) {
                throw new Error('Choose an accessible voice channel in the linked server.');
            }
            const allowed = voiceChannel.permissionsFor(voiceChannel.guild.members.me);
            if (!allowed?.has(Discord.PermissionFlagsBits.Connect) || !allowed.has(Discord.PermissionFlagsBits.Speak)) {
                throw new Error('The bot needs Connect and Speak permission in that voice channel.');
            }
            const result = await this.fetchConversation(resolved);
            if (activeRun !== this.runId) return;
            if (!result.messages.length) throw new Error('No readable text was found at or after that message.');
            this.queue = result.messages;
            this.index = 0;
            this.setState({
                status: 'connecting',
                messageCount: this.queue.length,
                guildName: resolved.guildName,
                textChannelName: resolved.channelName,
                voiceChannelName: voiceChannel.name,
                truncated: result.truncated,
            });
            this.connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: resolved.guildId,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                selfDeaf: true,
            });
            await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
            if (activeRun !== this.runId) return;
            this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
            this.connection.subscribe(this.player);
            this.player.on(AudioPlayerStatus.Idle, () => {
                if (activeRun !== this.runId || this.state.status === 'stopped') return;
                this.index += 1;
                void this.playCurrent(activeRun);
            });
            this.player.on('error', error => this.fail(error, activeRun));
            await this.playCurrent(activeRun);
        } catch (error) {
            this.fail(error, activeRun);
        }
    }

    async playCurrent(activeRun) {
        if (activeRun !== this.runId) return;
        const message = this.queue[this.index];
        if (!message) {
            this.setState({
                status: 'complete',
                currentSpeaker: null,
                currentText: null,
                messageIndex: this.queue.length,
            });
            this.scheduleDisconnect();
            return;
        }
        this.abortController = new AbortController();
        this.setState({
            status: 'loading',
            currentSpeaker: message.speaker,
            currentText: message.text,
            messageIndex: this.index + 1,
            error: null,
        });
        try {
            const audio = await this.synthesize(
                `${message.speaker}: ${message.text}`,
                message.voiceSlot,
                this.state.speed,
                this.abortController.signal,
            );
            if (activeRun !== this.runId) return;
            const resource = createAudioResource(Readable.from(audio), { inputType: StreamType.OggOpus });
            this.player.play(resource);
            this.setState({ status: 'playing' });
        } catch (error) {
            if (error?.name === 'AbortError') return;
            this.fail(error, activeRun);
        }
    }

    pause() {
        if (this.state.status === 'playing' && this.player?.pause(true)) this.setState({ status: 'paused' });
        return this.getState();
    }

    resume() {
        if (this.state.status === 'paused' && this.player?.unpause()) this.setState({ status: 'playing' });
        return this.getState();
    }

    skip() {
        if (!['playing', 'paused', 'loading'].includes(this.state.status)) return this.getState();
        if (this.state.status === 'loading') {
            this.abortController?.abort();
            this.index += 1;
            void this.playCurrent(this.runId);
        } else {
            this.player?.stop(true);
        }
        return this.getState();
    }

    setSpeed(value) {
        this.setState({ speed: numericSpeed(value) });
        return this.getState();
    }

    stop(publish = true) {
        this.runId += 1;
        this.abortController?.abort();
        this.abortController = null;
        this.player?.stop(true);
        this.player = null;
        this.connection?.destroy();
        this.connection = null;
        this.queue = [];
        this.index = 0;
        if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
        if (publish) this.state = { ...initialState(), status: 'stopped', speed: this.state.speed };
        return this.getState();
    }

    async browserAudio(message, rawSpeed) {
        if (!message || typeof message !== 'object') throw new Error('That conversation message is unavailable.');
        const speed = numericSpeed(rawSpeed ?? 1);
        const speaker = cleanForSpeech(message.speaker || 'Unknown speaker').slice(0, 120);
        const text = cleanForSpeech(message.text || '');
        if (!text) throw new Error('That conversation message has no readable text.');
        const voiceSlot = Math.max(0, Number.parseInt(message.voiceSlot, 10) || 0);
        return this.synthesizer.synthesizeBrowser({
            text: `${speaker}: ${text}`,
            voice: this.voices[voiceSlot % this.voices.length],
            speed,
        });
    }

    destroy() {
        this.stop(false);
        this.synthesizer.destroy?.();
    }

    scheduleDisconnect() {
        if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
        this.disconnectTimer = setTimeout(() => {
            this.connection?.destroy();
            this.connection = null;
            this.player = null;
        }, 10 * 60_000);
        this.disconnectTimer.unref?.();
    }

    fail(error, activeRun) {
        if (activeRun !== this.runId) return;
        console.error('[Conversation TTS]', error);
        this.abortController?.abort();
        this.player?.stop(true);
        this.player = null;
        this.setState({ status: 'error', error: error?.message || 'Playback failed.' });
        this.connection?.destroy();
        this.connection = null;
    }

    async handle(action, payload = {}) {
        if (action === 'state') return this.getState();
        if (action === 'resolve') return this.resolve(payload.messageLink);
        if (action === 'conversation') return this.conversation(payload.messageLink);
        if (action === 'browser-audio') return this.browserAudio(payload.message, payload.speed);
        if (action === 'play') {
            numericSpeed(payload.speed ?? 1);
            if (!payload.voiceChannelId) throw new Error('Choose a Discord voice channel.');
            void this.start(payload.messageLink, payload.voiceChannelId, payload.speed ?? 1);
            return { ...this.getState(), accepted: true };
        }
        if (action === 'pause') return this.pause();
        if (action === 'resume') return this.resume();
        if (action === 'skip') return this.skip();
        if (action === 'stop') return this.stop();
        if (action === 'speed') return this.setSpeed(payload.speed);
        throw new Error(`Unknown TTS action: ${action}`);
    }
}

function createConversationTts(client, options) {
    return new ConversationTts(client, options);
}

module.exports = {
    ConversationTts,
    cleanForSpeech,
    createConversationTts,
    messageToSpeech,
    parseDiscordMessageLink,
};
