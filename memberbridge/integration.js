'use strict';

const Discord = require('discord.js');
const crypto = require('crypto');
const { SecretBox, randomToken } = require('./crypto');
const { DiscordRoleAdapter, MembershipEngine } = require('./engine');
const { MemberBridgeStore, now } = require('./store');
const { GoogleYouTubeClient, SimulatedYouTubeClient } = require('./youtube');
const { MemberBridgeWeb } = require('./web');
const { ROLE_MODE, STATUS } = require('./constants');

function memberBridgeCommandData() {
    return [
        new Discord.SlashCommandBuilder().setName('membership-link').setDescription('Privately link your Discord account to a YouTube channel').toJSON(),
        new Discord.SlashCommandBuilder().setName('membership-status').setDescription('Privately view your YouTube membership and role status').toJSON(),
        new Discord.SlashCommandBuilder().setName('membership-recheck').setDescription('Queue an immediate YouTube membership recheck').toJSON(),
        new Discord.SlashCommandBuilder().setName('membership-unlink').setDescription('Disconnect your linked YouTube channel').toJSON(),
        new Discord.SlashCommandBuilder().setName('membership-help').setDescription('Learn how MemberBridge verification and privacy work').toJSON(),
        new Discord.SlashCommandBuilder().setName('memberbridge-health').setDescription('Show MemberBridge health (administrators only)').toJSON(),
        new Discord.SlashCommandBuilder().setName('memberbridge-sync').setDescription('Synchronize a creator source (administrators only)')
            .addIntegerOption(option => option.setName('creator').setDescription('Creator source ID from The Commission').setRequired(true).setMinValue(1)).toJSON(),
        new Discord.SlashCommandBuilder().setName('memberbridge-check-user').setDescription('Recheck one linked member (administrators only)')
            .addUserOption(option => option.setName('member').setDescription('Discord member to recheck').setRequired(true)).toJSON(),
        new Discord.SlashCommandBuilder().setName('memberbridge-reload-commands').setDescription('Confirm MemberBridge commands are loaded (administrators only)').toJSON(),
    ];
}

class MemberBridgeIntegration {
    constructor(client, options) {
        this.client = client;
        this.config = { enabled: false, callbackHost: '127.0.0.1', callbackPort: 17842, verificationIntervalMinutes: 360, levelSyncHours: 24, missingChecksBeforeGrace: 2, gracePeriodHours: 168, massAbsencePercent: 20, verifyCategoryId: '1532513761573863577', verifyChannelId: '1534990967923282080', verifyChannelName: 'verify-membership', ...options.config };
        this.store = new MemberBridgeStore({ dataDir: options.dataDir, secretBox: new SecretBox(options.encryptionKey) });
        this.youtube = new GoogleYouTubeClient({ clientId: this.config.googleClientId, clientSecret: options.googleClientSecret, publicBaseUrl: this.config.publicBaseUrl });
        this.simulatedYoutube = new SimulatedYouTubeClient(this.store);
        this.roleAdapter = new DiscordRoleAdapter(client, this.store);
        this.engine = new MembershipEngine({ store: this.store, youtube: this.youtube, simulatedYoutube: this.simulatedYoutube, roleAdapter: this.roleAdapter, simulationMode: Boolean(this.config.simulationMode) });
        this.web = new MemberBridgeWeb({ store: this.store, youtube: this.youtube, engine: this.engine, config: { ...this.config, discordClientSecret: options.discordClientSecret }, onLinked: link => this.verifyUser(link.guild_id, link.discord_user_id) });
        this.recheckCooldowns = new Map();
        this.scheduler = null;
        this.schedulerRunning = false;
        this.callbackAddress = null;
        this.panelRepairTimer = null;
        this.onPanelMessageDelete = message => {
            const state = message.guildId ? this.store.getVerifyPanel(message.guildId) : null;
            if (state?.message_id === message.id) this.schedulePanelRepair();
        };
        this.onPanelChannelDelete = channel => {
            const state = channel.guildId ? this.store.getVerifyPanel(channel.guildId) : null;
            if (state?.channel_id === channel.id) {
                this.store.saveVerifyPanel(channel.guildId, { categoryId: state.category_id, channelId: '', messageId: '' });
                this.schedulePanelRepair();
            }
        };
    }

    async start() {
        if (!this.config.enabled) {
            console.log('[MemberBridge] Disabled in The Commission settings.');
            return;
        }
        try {
            this.callbackAddress = await this.web.start();
            console.log(`[MemberBridge] OAuth callback server listening on ${this.config.callbackHost}:${this.config.callbackPort}`);
        } catch (error) {
            console.error(`[MemberBridge] Callback server unavailable: ${error.message}`);
            this.store.audit('Public callback misconfigured', error.message, { severity: 'error' });
        }
        this.client.on('messageDelete', this.onPanelMessageDelete);
        this.client.on('channelDelete', this.onPanelChannelDelete);
        try {
            const panel = await this.publishVerifyPanel();
            console.log(`[MemberBridge] Verification panel ready in #${panel.channelName} (${panel.channelId}).`);
        } catch (error) {
            console.error(`[MemberBridge] Verification panel unavailable: ${error.message}`);
            this.store.audit('Verification panel unavailable', error.message, { severity: 'error' });
        }
        this.scheduler = setInterval(() => this.tick().catch(error => console.error('[MemberBridge scheduler]', error)), 60000);
        this.scheduler.unref?.();
        setTimeout(() => this.tick().catch(error => console.error('[MemberBridge initial sync]', error)), 5000).unref?.();
    }

    async stop() {
        clearInterval(this.scheduler);
        clearTimeout(this.panelRepairTimer);
        this.client.off('messageDelete', this.onPanelMessageDelete);
        this.client.off('channelDelete', this.onPanelChannelDelete);
        await this.web.stop();
        this.store.close();
    }

    schedulePanelRepair() {
        clearTimeout(this.panelRepairTimer);
        this.panelRepairTimer = setTimeout(() => this.publishVerifyPanel().catch(error => {
            console.error(`[MemberBridge] Verification panel repair failed: ${error.message}`);
            this.store.audit('Verification panel repair failed', error.message, { severity: 'error' });
        }), 1500);
        this.panelRepairTimer.unref?.();
    }

    async tick() {
        if (this.schedulerRunning || !this.client.isReady()) return;
        this.schedulerRunning = true;
        try {
            const guildIds = this.client.guilds.cache.map(guild => guild.id);
            const backups = this.store.listBackups();
            if (!backups.length || Date.now() - new Date(backups[0].createdUtc).getTime() >= 24 * 3600000) {
                try { this.store.createBackup(); } catch (error) { this.store.audit('Backup failed', error.message, { severity: 'error' }); }
            }
            for (const guildId of guildIds) {
                for (const creator of this.store.enabledCreators(guildId)) {
                    const verifyDue = !creator.last_attempt_utc || Date.now() - new Date(creator.last_attempt_utc).getTime() >= creator.verification_interval_minutes * 60000;
                    const levelsDue = !creator.last_level_sync_utc || Date.now() - new Date(creator.last_level_sync_utc).getTime() >= Number(this.config.levelSyncHours || 24) * 3600000;
                    if (levelsDue) {
                        try { await this.engine.syncLevels(creator.id); }
                        catch (error) { this.store.markCreatorError(creator.id, error.code || 'level_sync_failed', error.message); }
                    }
                    if (verifyDue) {
                        try { await this.engine.verifyCreator(creator.id); }
                        catch (error) { console.error(`[MemberBridge] ${creator.display_name} verification failed:`, error.message); }
                    }
                }
            }
        } finally { this.schedulerRunning = false; }
    }

    isAdmin(interaction) {
        if (interaction.memberPermissions?.has(Discord.PermissionFlagsBits.Administrator)) return true;
        const configured = new Set(String(this.config.administratorRoleIds || '').split(',').filter(Boolean));
        return interaction.member?.roles?.cache?.some(role => configured.has(role.id)) || false;
    }

    async verifyUser(guildId, discordUserId) {
        const results = [];
        for (const creator of this.store.enabledCreators(guildId)) {
            try { results.push(await this.engine.verifyCreator(creator.id, discordUserId)); }
            catch (error) { results.push({ error: error.message, creatorId: creator.id }); }
        }
        return results;
    }

    verificationPanelPayload() {
        const embed = new Discord.EmbedBuilder()
            .setColor(0x9f1239)
            .setTitle('Verify Your Channel Membership')
            .setDescription('Connect your Discord account to your YouTube channel membership. Once verified, The Commission applies the Discord role mapped to your current membership level.')
            .addFields(
                { name: '1. Verify membership', value: 'Click **Verify Membership** and use the private, single-use link. The link expires after 10 minutes.' },
                { name: '2. Choose your YouTube channel', value: 'Discord confirms who you are, then Google lets you select the YouTube identity that holds the membership.' },
                { name: '3. Receive your role', value: 'The bot checks the configured creator membership and applies the matching role automatically.' },
                { name: 'Privacy', value: 'Your Google password is never shared with or stored by the bot. Button responses and account links are private.' },
            )
            .setFooter({ text: 'The Commission • MemberBridge verification' });
        const row = new Discord.ActionRowBuilder().addComponents(
            new Discord.ButtonBuilder().setCustomId('memberbridge:panel-link').setStyle(Discord.ButtonStyle.Success).setLabel('Verify Membership'),
            new Discord.ButtonBuilder().setCustomId('memberbridge:panel-status').setStyle(Discord.ButtonStyle.Primary).setLabel('Check Status'),
            new Discord.ButtonBuilder().setCustomId('memberbridge:panel-recheck').setStyle(Discord.ButtonStyle.Secondary).setLabel('Recheck Membership'),
        );
        return { embeds: [embed], components: [row] };
    }

    async publishVerifyPanel(overrides = {}) {
        if (!this.client.isReady()) throw new Error('The bot is not connected to Discord yet.');
        const guildId = String(overrides.guildId || this.client.guilds.cache.first()?.id || '');
        if (!guildId) throw new Error('The bot is not connected to a Discord server.');
        const guild = this.client.guilds.cache.get(guildId) || await this.client.guilds.fetch(guildId);
        const state = this.store.getVerifyPanel(guildId);
        const categoryId = String(overrides.categoryId || this.config.verifyCategoryId || state?.category_id || '').trim();
        if (!categoryId) throw new Error('Set the verification category ID in The Commission first.');
        const category = guild.channels.cache.get(categoryId) || await guild.channels.fetch(categoryId).catch(() => null);
        if (!category || category.type !== Discord.ChannelType.GuildCategory) throw new Error(`Verification category ${categoryId} does not exist or is not a category.`);

        const channelName = String(overrides.channelName || this.config.verifyChannelName || 'verify-membership').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 90) || 'verify-membership';
        const channelCandidates = [...new Set([overrides.channelId, this.config.verifyChannelId, state?.channel_id].map(value => String(value || '').trim()).filter(Boolean))];
        let channel = null;
        for (const channelId of channelCandidates) {
            channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
            if (channel?.type === Discord.ChannelType.GuildText) break;
            channel = null;
        }
        if (!channel) {
            channel = await guild.channels.create({
                name: channelName,
                type: Discord.ChannelType.GuildText,
                parent: category.id,
                topic: 'Private YouTube channel membership verification and Discord role assignment.',
                reason: 'The Commission membership verification channel',
            });
        }
        if (channel.parentId !== category.id) await channel.setParent(category.id, { lockPermissions: false, reason: 'Place membership verification under Announcements' });
        if (channel.name !== channelName) await channel.setName(channelName, 'Keep The Commission verification channel name synchronized');
        await channel.permissionOverwrites.edit(guild.roles.everyone, {
            ViewChannel: true,
            ReadMessageHistory: true,
            SendMessages: false,
            CreatePublicThreads: false,
            CreatePrivateThreads: false,
            SendMessagesInThreads: false,
        }, { reason: 'Lock membership verification channel to the bot panel' });
        await channel.permissionOverwrites.edit(this.client.user.id, {
            ViewChannel: true,
            ReadMessageHistory: true,
            SendMessages: true,
            EmbedLinks: true,
            ManageMessages: true,
        }, { reason: 'Allow The Commission to maintain verification panel' });

        let message = null;
        if (state?.message_id && state.channel_id === channel.id) message = await channel.messages.fetch(state.message_id).catch(() => null);
        if (!message) {
            const recent = await channel.messages.fetch({ limit: 25 }).catch(() => null);
            message = recent?.find(item => item.author.id === this.client.user.id && item.components.some(row => row.components.some(component => component.customId === 'memberbridge:panel-link'))) || null;
        }
        const payload = this.verificationPanelPayload();
        message = message ? await message.edit(payload) : await channel.send(payload);
        if (!message.pinned) await message.pin('Keep the membership verification panel visible').catch(() => {});
        const saved = this.store.saveVerifyPanel(guildId, { categoryId: category.id, channelId: channel.id, messageId: message.id });
        this.store.audit('Verification panel published', `Membership verification panel is active in #${channel.name}.`, { guildId, data: { categoryId: category.id, channelId: channel.id, messageId: message.id } });
        return { guildId, categoryId: saved.category_id, channelId: saved.channel_id, messageId: saved.message_id, channelName: channel.name };
    }

    async replyWithMembershipLink(interaction) {
        if (!this.config.enabled) return interaction.reply({ content: 'Membership verification is currently disabled. Ask an owner to enable MemberBridge in The Commission.', ephemeral: true });
        if (!this.web.server) return interaction.reply({ content: 'The private verification service is not ready. Ask an owner to check the MemberBridge callback settings.', ephemeral: true });
        const token = randomToken(32);
        this.store.createLinkSession({ token, guildId: interaction.guildId, discordUserId: interaction.user.id, discordUsername: interaction.user.tag, expiresUtc: new Date(Date.now() + 10 * 60000).toISOString() });
        this.store.audit('Account link started', `${interaction.user.id} started a private account link.`, { guildId: interaction.guildId, discordUserId: interaction.user.id });
        const row = new Discord.ActionRowBuilder().addComponents(new Discord.ButtonBuilder().setStyle(Discord.ButtonStyle.Link).setLabel('Continue Private Verification').setURL(this.web.memberUrl(token)));
        return interaction.reply({ content: 'Your single-use verification link expires in 10 minutes. Discord confirms your identity, then Google lets you choose your YouTube channel. Your Google password is never shared with the bot.', components: [row], ephemeral: true });
    }

    async replyWithMembershipStatus(interaction) {
        const link = this.store.findLink(interaction.guildId, interaction.user.id);
        if (!link) return interaction.reply({ content: 'YouTube account: **Not linked**\nClick **Verify Membership** to connect privately.', ephemeral: true });
        const records = this.store.userRecords(interaction.guildId, interaction.user.id);
        const lines = [`YouTube account: **Linked**`, `YouTube channel: **${link.youtube_display_name || link.youtube_channel_id}**`, `Last linked: <t:${Math.floor(new Date(link.linked_utc).getTime()/1000)}:F>`];
        for (const record of records) {
            lines.push('', `**${record.creator_name}**`, `Status: **${record.status}**`, `Membership level: **${record.current_level_name || record.current_highest_level_id || 'Not verified'}**`);
            if (record.managedRoleIds.length) lines.push(`Discord role${record.managedRoleIds.length === 1 ? '' : 's'}: ${record.managedRoleIds.map(id => `<@&${id}>`).join(', ')}`);
            if (record.last_successful_utc) lines.push(`Last verified: <t:${Math.floor(new Date(record.last_successful_utc).getTime()/1000)}:R>`);
            if (record.grace_expires_utc) lines.push(`Grace deadline: <t:${Math.floor(new Date(record.grace_expires_utc).getTime()/1000)}:F>`);
            if (record.status === STATUS.UNAVAILABLE) lines.push('Technical verification is temporarily unavailable; current roles are preserved.');
        }
        return interaction.reply({ content: lines.join('\n').slice(0, 1900), ephemeral: true });
    }

    async replyWithMembershipRecheck(interaction) {
        const previous = this.recheckCooldowns.get(`${interaction.guildId}:${interaction.user.id}`) || 0;
        const remaining = previous + 10 * 60000 - Date.now();
        if (remaining > 0) return interaction.reply({ content: `A recheck was already requested. Try again <t:${Math.floor((Date.now()+remaining)/1000)}:R>.`, ephemeral: true });
        if (!this.store.findLink(interaction.guildId, interaction.user.id)) return interaction.reply({ content: 'Click **Verify Membership** to link a YouTube account first.', ephemeral: true });
        this.recheckCooldowns.set(`${interaction.guildId}:${interaction.user.id}`, Date.now());
        await interaction.deferReply({ ephemeral: true });
        const results = await this.verifyUser(interaction.guildId, interaction.user.id);
        const failures = results.filter(item => item.error);
        return interaction.editReply(failures.length ? `Recheck completed with ${failures.length} creator error(s). Existing roles were preserved for unavailable checks.` : `Recheck completed for ${results.length} creator source(s). Use **Check Status** for the result.`);
    }

    async handleButton(interaction) {
        if (!interaction.isButton() || !interaction.customId.startsWith('memberbridge:')) return false;
        const [, action, userId] = interaction.customId.split(':');
        if (action === 'panel-link') { await this.replyWithMembershipLink(interaction); return true; }
        if (action === 'panel-status') { await this.replyWithMembershipStatus(interaction); return true; }
        if (action === 'panel-recheck') { await this.replyWithMembershipRecheck(interaction); return true; }
        if (userId !== interaction.user.id) {
            await interaction.reply({ content: 'This private confirmation belongs to another member.', ephemeral: true });
            return true;
        }
        if (action === 'unlink-cancel') {
            await interaction.update({ content: 'YouTube unlink canceled.', components: [] });
            return true;
        }
        if (action === 'unlink-confirm') {
            const linked = this.store.unlinkAccount(interaction.guildId, interaction.user.id);
            this.store.audit('Account unlinked', `${interaction.user.id} unlinked their YouTube identity. Managed roles remain subject to the configured creator grace policy.`, { guildId: interaction.guildId, discordUserId: interaction.user.id });
            await interaction.update({ content: linked ? 'Your YouTube identity is unlinked. Existing membership roles will follow each creator’s configured grace policy.' : 'No active YouTube link was found.', components: [] });
            return true;
        }
        return false;
    }

    async handleCommand(interaction) {
        if (!interaction.isChatInputCommand()) return false;
        const name = interaction.commandName;
        if (!name.startsWith('membership-') && !name.startsWith('memberbridge-')) return false;
        if (!this.config.enabled && name !== 'memberbridge-health') {
            await interaction.reply({ content: 'MemberBridge is disabled. An owner can enable it in The Commission → MemberBridge.', ephemeral: true });
            return true;
        }
        if (name === 'membership-link') {
            await this.replyWithMembershipLink(interaction);
            return true;
        }
        if (name === 'membership-status') {
            await this.replyWithMembershipStatus(interaction);
            return true;
        }
        if (name === 'membership-recheck') {
            await this.replyWithMembershipRecheck(interaction);
            return true;
        }
        if (name === 'membership-unlink') {
            const row = new Discord.ActionRowBuilder().addComponents(
                new Discord.ButtonBuilder().setCustomId(`memberbridge:unlink-confirm:${interaction.user.id}`).setStyle(Discord.ButtonStyle.Danger).setLabel('Unlink YouTube'),
                new Discord.ButtonBuilder().setCustomId(`memberbridge:unlink-cancel:${interaction.user.id}`).setStyle(Discord.ButtonStyle.Secondary).setLabel('Cancel'),
            );
            await interaction.reply({ content: 'Unlinking removes the saved identity connection. Membership roles may enter grace or be removed according to the server’s creator settings. Continue?', components: [row], ephemeral: true });
            return true;
        }
        if (name === 'membership-help') {
            await interaction.reply({ content: '**How MemberBridge works**\nMemberBridge links your Discord account to the permanent channel ID of the YouTube identity you choose. Each accepted creator separately authorizes the official YouTube membership API. During a check, your channel ID is sent to YouTube with that creator’s authorization. YouTube reports whether it is active and the highest accessible membership-level ID. The Commission maps that permanent level ID to a permanent Discord role ID.\n\nA successfully confirmed absence begins the server’s grace process. Network, YouTube, Discord, authorization, quota, malformed-data, and app errors never count as canceled membership and do not remove roles. Use `/membership-unlink` at any time. No Google password or email address is stored.', ephemeral: true });
            return true;
        }
        if (!this.isAdmin(interaction)) {
            await interaction.reply({ content: 'This MemberBridge command requires Discord Administrator or a configured MemberBridge administrator role.', ephemeral: true });
            return true;
        }
        if (name === 'memberbridge-health') {
            const health = this.health(interaction.guildId);
            await interaction.reply({ content: `MemberBridge: **${health.status}**\nDatabase: **${health.database ? 'Healthy' : 'Unhealthy'}**\nCallback server: **${health.callback ? 'Listening' : 'Unavailable'}**\nMode: **${health.simulation ? 'DEVELOPMENT SIMULATION' : 'Official YouTube API'}**\nCreators: ${health.dashboard.operationalCreators}/${health.dashboard.creators} operational\nLinked members: ${health.dashboard.linkedMembers}\nSafe-mode creators: ${health.dashboard.safeModeCreators}`, ephemeral: true });
            return true;
        }
        if (name === 'memberbridge-sync') {
            await interaction.deferReply({ ephemeral: true });
            const result = await this.engine.verifyCreator(interaction.options.getInteger('creator', true));
            await interaction.editReply(`Sync complete: ${result.checked} checked, ${result.active} active, ${result.missing} missing.${result.safeMode ? ' Role removals are paused by safe mode.' : ''}`);
            return true;
        }
        if (name === 'memberbridge-check-user') {
            await interaction.deferReply({ ephemeral: true });
            const member = interaction.options.getUser('member', true);
            const results = await this.verifyUser(interaction.guildId, member.id);
            await interaction.editReply(`Checked ${member} against ${results.length} enabled creator source(s).`);
            return true;
        }
        if (name === 'memberbridge-reload-commands') {
            await interaction.reply({ content: 'MemberBridge commands are loaded. Restarting The Commission re-registers the full slash-command set for this server.', ephemeral: true });
            return true;
        }
        return false;
    }

    health(guildId) {
        const resolvedGuildId = guildId || this.client.guilds.cache.first()?.id || '';
        const dashboard = this.store.dashboard(resolvedGuildId);
        const database = dashboard.integrity;
        const callback = !this.config.enabled || Boolean(this.web.server);
        return { status: database && callback ? (dashboard.safeModeCreators ? 'Degraded' : 'Healthy') : 'Unhealthy', database, callback, simulation: Boolean(this.config.simulationMode), verifyPanel: this.store.getVerifyPanel(resolvedGuildId) || null, dashboard };
    }

    async admin(action, payload = {}) {
        const guildId = payload.guildId || this.client.guilds.cache.first()?.id;
        if (!guildId) throw new Error('The bot is not connected to a Discord server.');
        switch (action) {
            case 'dashboard': return this.health(guildId);
            case 'publish-verify-panel': return this.publishVerifyPanel({ guildId, categoryId: payload.categoryId, channelId: payload.channelId, channelName: payload.channelName });
            case 'creators': return this.store.listCreators(guildId);
            case 'create-creator': return this.store.createCreator({ guildId, displayName: String(payload.displayName || '').trim() || 'New creator', roleMode: payload.roleMode || ROLE_MODE.HIGHEST, missingChecksBeforeGrace: this.config.missingChecksBeforeGrace, gracePeriodHours: this.config.gracePeriodHours, verificationIntervalMinutes: this.config.verificationIntervalMinutes, massAbsencePercent: this.config.massAbsencePercent, administratorUserId: payload.administratorUserId });
            case 'update-creator': return this.store.updateCreator(payload.creatorId, payload.patch || {});
            case 'connect-creator': {
                if (this.config.simulationMode) throw new Error('Creator OAuth is disabled in simulation mode. Use Activate simulator creator.');
                if (!this.web.server) throw new Error('The callback server is unavailable. Fix the callback settings and restart the bot.');
                return { url: this.web.creatorAuthorizationUrl(payload.creatorId) };
            }
            case 'activate-simulator': {
                if (!this.config.simulationMode) throw new Error('Simulation mode is not enabled.');
                const creator = this.store.getCreator(payload.creatorId);
                if (!creator) throw new Error('Creator source not found.');
                this.store.db.prepare("UPDATE mb_creator_sources SET youtube_channel_id=?,connection_status='Operational',enabled=1,updated_utc=? WHERE id=?").run(payload.youtubeChannelId || `SIM_CREATOR_${creator.id}`, now(), creator.id);
                return this.store.getCreator(creator.id);
            }
            case 'levels': return this.store.listLevels(payload.creatorId);
            case 'sync-levels': return this.engine.syncLevels(payload.creatorId);
            case 'seed-level': {
                if (!this.config.simulationMode) throw new Error('Fake levels are available only in simulation mode.');
                const current = this.store.listLevels(payload.creatorId).map(level => ({ id: level.youtube_level_id, displayName: level.display_name }));
                const index = current.findIndex(level => level.id === payload.youtubeLevelId);
                const item = { id: String(payload.youtubeLevelId || '').trim(), displayName: String(payload.displayName || '').trim() };
                if (!item.id || !item.displayName) throw new Error('Level ID and display name are required.');
                if (index >= 0) current[index] = item; else current.push(item);
                return this.store.saveLevels(payload.creatorId, current);
            }
            case 'map-level': return this.store.setRoleMapping(payload.creatorId, payload.youtubeLevelId, payload.roleId, payload.enabled !== false);
            case 'verify': return this.engine.verifyCreator(payload.creatorId, payload.discordUserId || '');
            case 'reconcile': return this.engine.reconcileCreator(payload.creatorId);
            case 'set-safe-mode': return this.store.updateCreator(payload.creatorId, { safe_mode: payload.enabled ? 1 : 0, safe_mode_reason: payload.enabled ? String(payload.reason || 'Enabled manually by administrator.') : '' });
            case 'create-override': {
                const allowed = new Set(['ForceMembershipActive','ForceSpecificMembershipLevel','PreserveCurrentRole','SuppressRoleRemoval','DisableAutomaticVerification']);
                if (!allowed.has(payload.overrideType)) throw new Error('Invalid manual override type.');
                return this.store.createOverride({ recordId: payload.recordId, overrideType: payload.overrideType, forcedLevelId: payload.forcedLevelId, forcedRoleId: payload.forcedRoleId, reason: String(payload.reason || '').trim() || 'Created from The Commission desktop app.', administratorUserId: payload.administratorUserId || 'desktop-owner', expiresUtc: payload.expiresUtc || null });
            }
            case 'remove-override': return { removed: this.store.removeOverride(payload.recordId, payload.administratorUserId || 'desktop-owner') };
            case 'links': return this.store.activeLinks(guildId).map(link => ({ ...link, records: this.store.userRecords(guildId, link.discord_user_id) }));
            case 'audit': return this.store.listAudit(payload.limit || 100);
            case 'guild-roles': {
                const guild = await this.client.guilds.fetch(guildId);
                const me = guild.members.me || await guild.members.fetchMe();
                return (await guild.roles.fetch()).filter(role => role.id !== guild.id).map(role => ({ id: role.id, name: role.name, color: role.hexColor, managed: role.managed, editable: !role.managed && role.position < me.roles.highest.position })).sort((a,b) => a.name.localeCompare(b.name));
            }
            case 'simulator-link': {
                if (!this.config.simulationMode) throw new Error('Simulator controls are disabled.');
                return this.store.linkAccount({ guildId, discordUserId: String(payload.discordUserId), discordUsername: payload.discordUsername || `sim-${payload.discordUserId}`, youtubeChannelId: String(payload.youtubeChannelId), youtubeDisplayName: payload.youtubeDisplayName || String(payload.youtubeChannelId) });
            }
            case 'simulator-member': {
                if (!this.config.simulationMode) throw new Error('Simulator controls are disabled.');
                this.store.simulatorSetMember({ creatorId: payload.creatorId, youtubeChannelId: String(payload.youtubeChannelId), displayName: payload.displayName || '', highestLevelId: payload.highestLevelId || null, accessibleLevelIds: payload.accessibleLevelIds || (payload.highestLevelId ? [payload.highestLevelId] : []), active: payload.active !== false });
                return { saved: true };
            }
            case 'simulator-failure': {
                if (!this.config.simulationMode) throw new Error('Simulator controls are disabled.');
                this.store.simulatorSetFailure(payload.creatorId, payload.mode || ''); return { mode: payload.mode || '' };
            }
            case 'export-member': {
                const link = this.store.findLink(guildId, String(payload.discordUserId));
                return link ? { link, memberships: this.store.userRecords(guildId, link.discord_user_id) } : null;
            }
            case 'delete-member': return { unlinked: this.store.unlinkAccount(guildId, String(payload.discordUserId)) };
            case 'backup-create': return this.store.createBackup();
            case 'backup-list': return this.store.listBackups();
            case 'backup-verify': return this.store.verifyBackup(payload.fileName);
            default: throw new Error(`Unknown MemberBridge action: ${action}`);
        }
    }
}

module.exports = { MemberBridgeIntegration, memberBridgeCommandData };
