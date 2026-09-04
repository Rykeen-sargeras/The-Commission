'use strict';

const API_ROOT = 'https://www.googleapis.com/youtube/v3';

async function responseJson(response, label) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const detail = data?.error?.message || data?.error_description || `${response.status} ${response.statusText}`;
        throw new Error(`${label}: ${detail}`);
    }
    return data;
}

async function exchangeGoogleCode(code, redirectUri, config, fetchImpl = fetch) {
    const response = await fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: config.MEMBERSHIP_GOOGLE_CLIENT_ID, client_secret: config.MEMBERSHIP_GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
    });
    const tokens = await responseJson(response, 'Google authorization failed');
    return { ...tokens, expiry_date: Date.now() + Number(tokens.expires_in || 3600) * 1000 };
}

async function refreshGoogleToken(tokens, config, fetchImpl = fetch) {
    if (tokens.access_token && Number(tokens.expiry_date || 0) > Date.now() + 60000) return tokens;
    if (!tokens.refresh_token) throw new Error('The creator must reconnect YouTube because no refresh token is available.');
    const response = await fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ refresh_token: tokens.refresh_token, client_id: config.MEMBERSHIP_GOOGLE_CLIENT_ID, client_secret: config.MEMBERSHIP_GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token' }),
    });
    const fresh = await responseJson(response, 'YouTube token refresh failed');
    return { ...tokens, ...fresh, refresh_token: fresh.refresh_token || tokens.refresh_token, expiry_date: Date.now() + Number(fresh.expires_in || 3600) * 1000 };
}

async function youtubeGet(path, accessToken, params = {}, fetchImpl = fetch) {
    const url = new URL(`${API_ROOT}/${path}`);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
    return responseJson(response, `YouTube ${path} request failed`);
}

async function creatorChannel(accessToken, fetchImpl = fetch) {
    const data = await youtubeGet('channels', accessToken, { part: 'id,snippet', mine: 'true' }, fetchImpl);
    const item = data.items?.[0];
    if (!item?.id) throw new Error('Google did not return a YouTube channel for this account.');
    return { id: item.id, title: item.snippet?.title || item.id };
}

async function membershipLevels(accessToken, fetchImpl = fetch) {
    const data = await youtubeGet('membershipsLevels', accessToken, { part: 'id,snippet' }, fetchImpl);
    return (data.items || []).map(item => ({
        youtubeLevelId: item.id,
        displayName: item.snippet?.levelDetails?.displayName || item.snippet?.title || item.id,
    }));
}

async function currentMembers(accessToken, memberChannelIds = [], fetchImpl = fetch) {
    const items = [];
    const uniqueIds = [...new Set(memberChannelIds.map(value => String(value || '').trim()).filter(Boolean))];
    for (let offset = 0; offset < uniqueIds.length; offset += 100) {
        let pageToken = '';
        do {
            const data = await youtubeGet('members', accessToken, { part: 'snippet', mode: 'all_current', maxResults: 1000, filterByMemberChannelId: uniqueIds.slice(offset, offset + 100).join(','), pageToken }, fetchImpl);
            items.push(...(data.items || []));
            pageToken = data.nextPageToken || '';
        } while (pageToken);
    }
    const result = new Map();
    for (const item of items) {
        const details = item.snippet?.memberDetails || {};
        const level = item.snippet?.membershipsDetails?.highestAccessibleLevel;
        if (details.channelId) result.set(details.channelId, { channelId: details.channelId, displayName: details.displayName || '', levelId: level || '' });
    }
    return result;
}

module.exports = { exchangeGoogleCode, refreshGoogleToken, creatorChannel, membershipLevels, currentMembers, youtubeGet };
