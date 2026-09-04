'use strict';

const Discord = require('discord.js');
const { MembershipStore, signState, graceDecision } = require('./membership_store');
const { refreshGoogleToken, membershipLevels, currentMembers } = require('./membership_youtube');

const VERIFY_COMMAND = {
    name: 'verify',
    description: 'Verify your YouTube membership and receive the matching role',
    type: 1,
};

function config() { return process.env; }
function baseUrl() {
    const explicit = process.env.MEMBERSHIP_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL;
    const railway = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '';
    return String(explicit || railway || '').replace(/\/$/, '');
}

class MembershipDiscord {
    constructor(client, options = {}) {
        this.client = client;
        this.store = options.store || null;
        this.dataDir = options.dataDir;
        this.timer = null;
        this.syncing = false;
        this.fetch = options.fetch || fetch;
    }

    install() {
        this.client.on('interactionCreate', interaction => this.handleInteraction(interaction).catch(error => console.error('[Membership verify]', error)));
        this.client.once('ready', () => {
            this.ensureStore();
            const minutes = Math.max(15, Number.parseInt(process.env.MEMBERSHIP_SYNC_MINUTES || '360', 10) || 360);
            this.timer = setInterval(() => this.syncAll().catch(error => console.error('[Membership sync]', error)), minutes * 60000);
            this.timer.unref?.();
            setTimeout(() => this.syncAll().catch(error => console.error('[Membership sync]', error)), 30000).unref?.();
        });
        process.on('message', message => this.handleIpc(message));
        return this;
    }

    ensureStore() { if (!this.store) this.store = new MembershipStore({ dataDir: this.dataDir }); return this.store; }

    async handleInteraction(interaction) {
        if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'verify') return false;
        const root = baseUrl();
        if (!root) return interaction.reply({ content: 'Membership verification is not configured yet. Please tell the server owner.', ephemeral: true });
        let token;
        try { token = signState({ purpose: 'member-verify', discordUserId: interaction.user.id }, config(), 15 * 60); }
        catch { return interaction.reply({ content: 'Membership verification is not configured yet. Please tell the server owner.', ephemeral: true }); }
        const button = new Discord.ButtonBuilder().setLabel('Verify YouTube Membership').setStyle(Discord.ButtonStyle.Link).setURL(`${root}/membership/verify?token=${encodeURIComponent(token)}`);
        return interaction.reply({ content: 'Click below. Discord will confirm the YouTube account already linked in your Discord Connections. You will not enter a Google password into the bot.', components: [new Discord.ActionRowBuilder().addComponents(button)], ephemeral: true });
    }

    async handleIpc(message) {
        if (message?.channel !== 'commission:membership-request') return;
        const { id, action, payload = {} } = message;
        try {
            let data;
            if (action === 'sync') data = await this.syncAll(payload.streamerId || '', payload.discordUserId || '');
            else if (action === 'roles') {
                const guild = await this.guild();
                data = guild.roles.cache.filter(r => !r.managed && r.id !== guild.id).map(r => ({ id: r.id, name: r.name, position: r.position })).sort((a, b) => b.position - a.position);
            } else throw new Error(`Unknown membership action: ${action}`);
            process.send?.({ channel: 'commission:membership-response', id, ok: true, data });
        } catch (error) { process.send?.({ channel: 'commission:membership-response', id, ok: false, error: error.message }); }
    }

    async guild() {
        const guildId = process.env.MEMBERSHIP_GUILD_ID || process.env.GOING_LIVE_GUILD_ID;
        const guild = guildId ? await this.client.guilds.fetch(guildId) : this.client.guilds.cache.first();
        if (!guild) throw new Error('The membership Discord server is not configured or connected.');
        return guild;
    }

    async syncAll(onlyStreamerId = '', onlyDiscordUserId = '') {
        this.ensureStore();
        if (this.syncing) throw new Error('A membership sync is already running.');
        this.syncing = true;
        const summary = { streamers: 0, membersChecked: 0, rolesAdded: 0, rolesRemoved: 0, errors: [] };
        try {
            const guild = await this.guild();
            const links = this.store.listLinks().filter(link => !onlyDiscordUserId || link.discordUserId === onlyDiscordUserId);
            for (const streamer of this.store.listStreamers().filter(s => s.enabled && s.connected && (!onlyStreamerId || s.id === onlyStreamerId))) {
                try {
                    const secret = process.env.MEMBERSHIP_ENCRYPTION_KEY;
                    let tokens = this.store.credentials(streamer.id, secret);
                    const fresh = await refreshGoogleToken(tokens, config(), this.fetch);
                    if (fresh.access_token !== tokens.access_token || fresh.expiry_date !== tokens.expiry_date) this.store.saveCredentials(streamer.id, fresh, secret);
                    const levels = await membershipLevels(fresh.access_token, this.fetch);
                    this.store.replaceTiers(streamer.id, levels);
                    const members = await currentMembers(fresh.access_token, links.map(link => link.youtubeChannelId), this.fetch);
                    const updated = this.store.getStreamer(streamer.id);
                    const mappedRoles = updated.tiers.map(t => t.discordRoleId).filter(Boolean);
                    for (const link of links) {
                        const discordMember = await guild.members.fetch(link.discordUserId).catch(() => null);
                        if (!discordMember) continue;
                        summary.membersChecked++;
                        const active = members.get(link.youtubeChannelId);
                        const previous = this.store.getStatus(streamer.id, link.discordUserId);
                        if (active) {
                            const roleId = updated.tiers.find(t => t.youtubeLevelId === active.levelId)?.discordRoleId || '';
                            if (roleId && !discordMember.roles.cache.has(roleId)) { await discordMember.roles.add(roleId, `Verified ${updated.displayName} YouTube member`); summary.rolesAdded++; }
                            for (const oldRole of mappedRoles) if (oldRole !== roleId && discordMember.roles.cache.has(oldRole)) { await discordMember.roles.remove(oldRole, `${updated.displayName} membership tier changed`); summary.rolesRemoved++; }
                            this.store.saveStatus({ streamerId: streamer.id, discordUserId: link.discordUserId, youtubeChannelId: link.youtubeChannelId, youtubeLevelId: active.levelId, roleId, status: roleId ? 'active' : 'active-unmapped', lastActiveAt: new Date().toISOString(), lastCheckedAt: new Date().toISOString() });
                        } else {
                            const grace = graceDecision(previous, updated.graceDays);
                            if (grace.expired) for (const roleId of mappedRoles) if (discordMember.roles.cache.has(roleId)) { await discordMember.roles.remove(roleId, `${updated.displayName} membership grace period expired`); summary.rolesRemoved++; }
                            this.store.saveStatus({ streamerId: streamer.id, discordUserId: link.discordUserId, youtubeChannelId: link.youtubeChannelId, youtubeLevelId: previous?.youtube_level_id || '', roleId: grace.expired ? '' : (previous?.role_id || ''), status: grace.expired ? 'expired' : 'grace', lastActiveAt: previous?.last_active_at || '', lapseDetectedAt: grace.lapseDetectedAt, graceExpiresAt: grace.graceExpiresAt, lastCheckedAt: new Date().toISOString() });
                        }
                    }
                    this.store.setSyncResult(streamer.id);
                    this.store.audit('sync-completed', streamer.id, '', `${links.length} linked members checked`);
                    summary.streamers++;
                } catch (error) {
                    this.store.setSyncResult(streamer.id, error.message);
                    this.store.audit('sync-failed', streamer.id, '', error.message);
                    summary.errors.push(`${streamer.displayName}: ${error.message}`);
                }
            }
            return summary;
        } finally { this.syncing = false; }
    }
}

let installed = null;
function installMembershipDiscord(client) { if (!installed) installed = new MembershipDiscord(client).install(); return installed; }

module.exports = { VERIFY_COMMAND, MembershipDiscord, installMembershipDiscord };
