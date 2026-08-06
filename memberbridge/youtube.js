'use strict';

const { CREATOR_SCOPE, CREATOR_IDENTITY_SCOPE } = require('./constants');

class ExternalApiError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'ExternalApiError';
        this.code = options.code || 'external_error';
        this.httpStatus = options.httpStatus || 0;
        this.classification = options.classification || 'temporary';
        this.retryable = options.retryable ?? this.classification === 'temporary';
    }
}

function extractGoogleError(body, status) {
    const detail = body?.error?.errors?.[0]?.reason || body?.error?.status || (typeof body?.error === 'string' ? body.error : '') || `http_${status}`;
    const message = body?.error?.message || body?.error_description || `Google API returned HTTP ${status}.`;
    const configurationCodes = new Set(['invalid_grant','insufficientPermissions','forbidden','channelMembershipsNotEnabled','accessNotConfigured']);
    const quotaCodes = new Set(['quotaExceeded','dailyLimitExceeded','rateLimitExceeded','userRateLimitExceeded']);
    const classification = configurationCodes.has(detail) || status === 401 ? 'configuration' : (quotaCodes.has(detail) || status === 429 || status >= 500 ? 'temporary' : 'member');
    return new ExternalApiError(message, { code: detail, httpStatus: status, classification, retryable: classification === 'temporary' });
}

function normalizeMember(item) {
    const snippet = item?.snippet;
    const channelId = snippet?.memberDetails?.channelId;
    const details = snippet?.membershipsDetails;
    if (!snippet || !details || !Array.isArray(details.accessibleLevels)) throw new ExternalApiError('YouTube returned a structurally invalid membership resource.', { code: 'malformed_member', classification: 'configuration' });
    return {
        creatorChannelId: snippet.creatorChannelId || '',
        channelId: channelId || '',
        displayName: snippet.memberDetails?.displayName || '',
        profileImageUrl: snippet.memberDetails?.profileImageUrl || '',
        highestLevelId: details.highestAccessibleLevel || '',
        highestLevelName: details.highestAccessibleLevelDisplayName || '',
        accessibleLevelIds: details.accessibleLevels.map(level => typeof level === 'string' ? level : level.id).filter(Boolean),
        memberSinceUtc: details.membershipsDuration?.memberSince || null,
        totalDurationMonths: Number(details.membershipsDuration?.memberTotalDurationMonths || 0),
    };
}

async function requestJson(url, options = {}, attempts = 3) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            const text = await response.text();
            let body = {};
            try { body = text ? JSON.parse(text) : {}; } catch { throw new ExternalApiError('External API returned malformed JSON.', { code: 'malformed_response', classification: 'configuration' }); }
            if (response.ok) return body;
            const error = extractGoogleError(body, response.status);
            if (!error.retryable || attempt === attempts) throw error;
            lastError = error;
        } catch (error) {
            const wrapped = error instanceof ExternalApiError ? error : new ExternalApiError(error.name === 'AbortError' ? 'External API request timed out.' : error.message, { code: error.name === 'AbortError' ? 'timeout' : 'network_error' });
            if (!wrapped.retryable || attempt === attempts) throw wrapped;
            lastError = wrapped;
        } finally { clearTimeout(timer); }
        await new Promise(resolve => setTimeout(resolve, 250 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 150)));
    }
    throw lastError;
}

class GoogleYouTubeClient {
    constructor({ clientId, clientSecret, publicBaseUrl }) {
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.publicBaseUrl = String(publicBaseUrl || '').replace(/\/$/, '');
    }

    assertConfigured() {
        if (!this.clientId || !this.clientSecret) throw new ExternalApiError('Save the Google OAuth client ID and client secret first.', { code: 'google_not_configured', classification: 'configuration' });
    }

    redirectUri(kind) {
        if (kind !== 'creator') throw new ExternalApiError('Google OAuth is available only to approved creators.', { code: 'creator_oauth_only', classification: 'configuration' });
        return `${this.publicBaseUrl}/oauth/google/creator-callback`;
    }

    authorizationUrl({ kind, state, challenge }) {
        this.assertConfigured();
        const creator = kind === 'creator';
        if (!creator) throw new ExternalApiError('Google OAuth is available only to approved creators.', { code: 'creator_oauth_only', classification: 'configuration' });
        const params = new URLSearchParams({
            client_id: this.clientId,
            redirect_uri: this.redirectUri(kind),
            response_type: 'code',
            scope: `${CREATOR_IDENTITY_SCOPE} ${CREATOR_SCOPE}`,
            state,
            code_challenge: challenge,
            code_challenge_method: 'S256',
            access_type: creator ? 'offline' : 'online',
            include_granted_scopes: 'true',
            prompt: creator ? 'consent select_account' : 'select_account',
        });
        return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    }

    async exchangeCode({ code, verifier, kind }) {
        this.assertConfigured();
        return requestJson('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: this.redirectUri(kind) }),
        }, 1);
    }

    async refresh(refreshToken) {
        this.assertConfigured();
        return requestJson('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
        }, 2);
    }

    async channelsMine(accessToken) {
        const url = new URL('https://www.googleapis.com/youtube/v3/channels');
        url.searchParams.set('part', 'id,snippet');
        url.searchParams.set('mine', 'true');
        url.searchParams.set('maxResults', '50');
        const body = await requestJson(url, { headers: { authorization: `Bearer ${accessToken}` } });
        if (!Array.isArray(body.items)) throw new ExternalApiError('YouTube channel identity response was malformed.', { code: 'malformed_channels', classification: 'configuration' });
        return body.items;
    }

    async membershipLevels(accessToken) {
        const url = new URL('https://www.googleapis.com/youtube/v3/membershipsLevels');
        url.searchParams.set('part', 'id,snippet');
        const body = await requestJson(url, { headers: { authorization: `Bearer ${accessToken}` } });
        if (!Array.isArray(body.items)) throw new ExternalApiError('YouTube membership-level response was malformed.', { code: 'malformed_levels', classification: 'configuration' });
        return body.items;
    }

    async members(accessToken, channelIds) {
        if (!channelIds.length || channelIds.length > 100) throw new Error('YouTube member batches must contain 1 to 100 channel IDs.');
        const url = new URL('https://www.googleapis.com/youtube/v3/members');
        url.searchParams.set('part', 'snippet');
        url.searchParams.set('filterByMemberChannelId', channelIds.join(','));
        url.searchParams.set('maxResults', '100');
        const body = await requestJson(url, { headers: { authorization: `Bearer ${accessToken}` } });
        if (!Array.isArray(body.items)) throw new ExternalApiError('YouTube membership response was malformed.', { code: 'malformed_members', classification: 'configuration' });
        return body.items.map(normalizeMember);
    }

    async allCurrentMembers(accessToken) {
        const members = [];
        let pageToken = '';
        do {
            const url = new URL('https://www.googleapis.com/youtube/v3/members');
            url.searchParams.set('part', 'snippet');
            url.searchParams.set('mode', 'all_current');
            url.searchParams.set('maxResults', '1000');
            if (pageToken) url.searchParams.set('pageToken', pageToken);
            const body = await requestJson(url, { headers: { authorization: `Bearer ${accessToken}` } });
            if (!Array.isArray(body.items)) throw new ExternalApiError('YouTube membership-list response was malformed.', { code: 'malformed_members', classification: 'configuration' });
            members.push(...body.items.map(normalizeMember));
            pageToken = String(body.nextPageToken || '');
            if (members.length > 100000) throw new ExternalApiError('YouTube returned an unexpectedly large membership list.', { code: 'member_list_too_large', classification: 'configuration' });
        } while (pageToken);
        return members;
    }
}

class SimulatedYouTubeClient {
    constructor(store) { this.store = store; }
    async membershipLevels(_accessToken, creatorId) {
        return this.store.listLevels(creatorId).map(level => ({ id: level.youtube_level_id, snippet: { levelDetails: { displayName: level.display_name } } }));
    }
    async members(_accessToken, channelIds, creatorId) {
        const mode = this.store.simulatorFailure(creatorId);
        if (mode === 'timeout') throw new ExternalApiError('Simulated YouTube timeout.', { code: 'timeout' });
        if (mode === 'rate_limit') throw new ExternalApiError('Simulated YouTube rate limit.', { code: 'rateLimitExceeded', httpStatus: 429 });
        if (mode === 'revoked') throw new ExternalApiError('Simulated creator authorization revoked.', { code: 'invalid_grant', httpStatus: 401, classification: 'configuration', retryable: false });
        if (mode === 'malformed') throw new ExternalApiError('Simulated malformed YouTube response.', { code: 'malformed_response', classification: 'configuration', retryable: false });
        return this.store.simulatorMembers(creatorId, channelIds);
    }
    async allCurrentMembers(_accessToken, creatorId) {
        return this.store.db.prepare('SELECT youtube_channel_id,display_name,highest_level_id,accessible_levels_json FROM mb_simulator_members WHERE creator_source_id=? AND is_active=1 ORDER BY display_name').all(Number(creatorId)).map(row => ({
            creatorChannelId: `SIM_CREATOR_${creatorId}`,
            channelId: row.youtube_channel_id,
            displayName: row.display_name,
            profileImageUrl: '',
            highestLevelId: row.highest_level_id || '',
            highestLevelName: row.highest_level_id || '',
            accessibleLevelIds: JSON.parse(row.accessible_levels_json || '[]'),
            memberSinceUtc: null,
            totalDurationMonths: 0,
        }));
    }
}

module.exports = { ExternalApiError, GoogleYouTubeClient, SimulatedYouTubeClient, normalizeMember, requestJson };
