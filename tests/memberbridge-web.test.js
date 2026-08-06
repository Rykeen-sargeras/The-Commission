'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SecretBox } = require('../memberbridge/crypto');
const { MemberBridgeStore } = require('../memberbridge/store');
const { MemberBridgeWeb } = require('../memberbridge/web');

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commission-memberbridge-web-'));
    const store = new MemberBridgeStore({ dataDir: dir, secretBox: new SecretBox(crypto.randomBytes(32).toString('base64')) });
    const youtube = {
        authorizationUrl({ state }) { return `https://accounts.google.test/oauth?state=${encodeURIComponent(state)}`; },
        async exchangeCode() { return { access_token: 'google-access', refresh_token: 'google-refresh', scope: 'creator-scope' }; },
        async channelsMine() { return [{ id: 'UCaaaaaaaaaaaaaaaaaaaaaa', snippet: { title: 'Creator Alpha' } }]; },
        async membershipLevels() { return [{ id: 'LEVEL_ONE', snippet: { levelDetails: { displayName: 'Associate' } } }]; },
        async allCurrentMembers() { return [{ creatorChannelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', channelId: 'UCbbbbbbbbbbbbbbbbbbbbbb', displayName: 'Member One', profileImageUrl: '', highestLevelId: 'LEVEL_ONE', highestLevelName: 'Associate', accessibleLevelIds: ['LEVEL_ONE'], memberSinceUtc: '2026-01-02T12:00:00.000Z', totalDurationMonths: 7 }]; },
        async refresh() { return { access_token: 'refreshed-access' }; },
    };
    const web = new MemberBridgeWeb({
        store,
        youtube,
        engine: {},
        config: { enabled: true, publicBaseUrl: 'http://127.0.0.1', productionMode: false, simulationMode: false, callbackHost: '127.0.0.1', callbackPort: 0, discordApplicationId: '1532475152284258483', discordClientSecret: 'test-only', ownerPassword: 'owner-test-password' },
        onLinked: async () => {},
        guildIdProvider: () => '22345678901234567',
    });
    return { dir, store, youtube, web, close() { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

async function run() {
    const originalFetch = global.fetch;
    const f = fixture();
    const address = await f.web.start();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const discordCalls = [];
    let discordUserId = '12345678901234567';
    let discordConnections = [{ type: 'youtube', id: 'UCbbbbbbbbbbbbbbbbbbbbbb', name: 'Member One', verified: true }];
    global.fetch = async (url, options = {}) => {
        const target = String(url);
        if (!target.startsWith('https://discord.com/')) return originalFetch(url, options);
        discordCalls.push(target);
        if (target.endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'discord-access' }), { status: 200 });
        if (target.endsWith('/users/@me/connections')) return new Response(JSON.stringify(discordConnections), { status: 200 });
        if (target.endsWith('/users/@me')) return new Response(JSON.stringify({ id: discordUserId, username: 'member' }), { status: 200 });
        throw new Error(`Unexpected Discord request: ${target}`);
    };

    try {
        for (const [route, heading] of [['/', 'Membership verification'], ['/creator', 'Creator Portal'], ['/terms', 'Terms of Service'], ['/privacy-policy', 'Privacy Policy']]) {
            const response = await originalFetch(`${baseUrl}${route}`);
            const body = await response.text();
            assert.equal(response.status, 200);
            assert.match(body, new RegExp(`<h1>${heading}</h1>`));
        }

        const wrongOwner = await originalFetch(`${baseUrl}/owner/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: 'wrong' }), redirect: 'manual' });
        assert.equal(wrongOwner.status, 403);
        const ownerLogin = await originalFetch(`${baseUrl}/owner/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: 'owner-test-password' }), redirect: 'manual' });
        assert.equal(ownerLogin.status, 302);
        const ownerCookie = ownerLogin.headers.get('set-cookie').split(';')[0];
        const ownerDashboard = await originalFetch(`${baseUrl}/owner`, { headers: { cookie: ownerCookie } });
        const ownerBody = await ownerDashboard.text();
        const ownerCsrf = ownerBody.match(/name="csrf" value="([^"]+)"/)?.[1];
        assert(ownerCsrf, 'owner dashboard provides a CSRF token');
        const createCreator = await originalFetch(`${baseUrl}/owner/creator-create`, { method: 'POST', headers: { cookie: ownerCookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: ownerCsrf, displayName: 'Portal Managed Creator' }), redirect: 'manual' });
        assert.equal(createCreator.status, 302);
        const portalManagedCreator = f.store.listAllCreators().find(item => item.display_name === 'Portal Managed Creator');
        assert(portalManagedCreator);
        const ownerLink = await originalFetch(`${baseUrl}/owner/creator-link`, { method: 'POST', headers: { cookie: ownerCookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: ownerCsrf, creatorId: String(portalManagedCreator.id) }) });
        assert.equal(ownerLink.status, 200);
        assert.match(await ownerLink.text(), /Creator invitation ready/);

        const linkToken = 'member-link-token';
        f.store.createLinkSession({ token: linkToken, guildId: '22345678901234567', discordUserId, discordUsername: 'member', expiresUtc: new Date(Date.now() + 600000).toISOString() });
        const start = await originalFetch(`${baseUrl}/oauth/discord/start?token=${linkToken}`, { redirect: 'manual' });
        assert.equal(start.status, 302);
        const discordAuthorize = new URL(start.headers.get('location'));
        assert.equal(discordAuthorize.searchParams.get('scope'), 'identify connections');
        const memberCallback = await originalFetch(`${baseUrl}/oauth/discord/callback?state=${encodeURIComponent(discordAuthorize.searchParams.get('state'))}&code=test`, { redirect: 'manual' });
        const memberBody = await memberCallback.text();
        assert.equal(memberCallback.status, 200);
        assert.match(memberBody, /Discord connection verified/);
        assert.equal(f.store.findLink('22345678901234567', discordUserId).youtube_channel_id, 'UCbbbbbbbbbbbbbbbbbbbbbb');
        assert(discordCalls.some(call => call.endsWith('/users/@me/connections')));
        assert(!discordCalls.some(call => call.includes('google')), 'member verification must not call Google');

        const unverifiedUser = '32345678901234567';
        discordUserId = unverifiedUser;
        discordConnections = [{ type: 'youtube', id: 'UCcccccccccccccccccccccc', name: 'Unverified', verified: false }];
        f.store.createLinkSession({ token: 'unverified-link', guildId: '22345678901234567', discordUserId: unverifiedUser, discordUsername: 'unverified', expiresUtc: new Date(Date.now() + 600000).toISOString() });
        const unverifiedStart = await originalFetch(`${baseUrl}/oauth/discord/start?token=unverified-link`, { redirect: 'manual' });
        const unverifiedState = new URL(unverifiedStart.headers.get('location')).searchParams.get('state');
        const unverifiedCallback = await originalFetch(`${baseUrl}/oauth/discord/callback?state=${encodeURIComponent(unverifiedState)}&code=test`);
        assert.equal(unverifiedCallback.status, 400);
        assert.match(await unverifiedCallback.text(), /User Settings/);
        assert.equal(f.store.findLink('22345678901234567', unverifiedUser), undefined);

        const creator = f.store.createCreator({ guildId: '22345678901234567', displayName: 'Creator Alpha' });
        const invite = f.web.creatorPortalAccessUrl(creator.id);
        assert.equal(invite.kind, 'invite');
        const invitePage = await originalFetch(invite.url.replace(f.web.baseUrl, baseUrl));
        assert.equal(invitePage.status, 200);
        const inviteStartPath = new URL(invite.url).pathname + '/start';
        const inviteStart = await originalFetch(`${baseUrl}${inviteStartPath}`, { redirect: 'manual' });
        const googleAuthorize = new URL(inviteStart.headers.get('location'));
        const creatorCallback = await originalFetch(`${baseUrl}/oauth/google/creator-callback?state=${encodeURIComponent(googleAuthorize.searchParams.get('state'))}&code=creator-code`, { redirect: 'manual' });
        assert.equal(creatorCallback.status, 302);
        assert.equal(creatorCallback.headers.get('location'), '/creator/dashboard');
        const portalCookie = creatorCallback.headers.get('set-cookie').split(';')[0];
        const dashboard = await originalFetch(`${baseUrl}/creator/dashboard`, { headers: { cookie: portalCookie } });
        const dashboardBody = await dashboard.text();
        assert.equal(dashboard.status, 200);
        assert.match(dashboardBody, /Member One/);
        assert.match(dashboardBody, /Associate/);
        assert.match(dashboardBody, /7 month\(s\)/);
        assert.equal(f.store.creatorMemberCache(creator.id).cachedTotal, 1);
        assert.equal(f.web.creatorPortalAccessUrl(creator.id).kind, 'login');

        const wrongCreator = f.store.createCreator({ guildId: '22345678901234567', displayName: 'Different Creator' });
        f.store.db.prepare("UPDATE mb_creator_sources SET youtube_channel_id='UCdddddddddddddddddddddd',connection_status='Operational' WHERE id=?").run(wrongCreator.id);
        const wrongLogin = await originalFetch(`${baseUrl}/creator/login/${wrongCreator.id}`, { redirect: 'manual' });
        const wrongState = new URL(wrongLogin.headers.get('location')).searchParams.get('state');
        const denied = await originalFetch(`${baseUrl}/oauth/google/creator-callback?state=${encodeURIComponent(wrongState)}&code=creator-code`, { redirect: 'manual' });
        assert.equal(denied.status, 403);
        assert.match(await denied.text(), /Wrong creator channel/);

        const removedMemberGoogle = await originalFetch(`${baseUrl}/oauth/google/start`);
        assert.equal(removedMemberGoogle.status, 410);
    } finally {
        global.fetch = originalFetch;
        await f.web.stop();
        f.close();
    }

    console.log('MemberBridge web, Discord Connections, and creator portal tests passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
