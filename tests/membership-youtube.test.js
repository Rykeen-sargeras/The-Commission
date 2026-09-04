'use strict';

const assert = require('assert');
const { creatorChannel, currentMembers } = require('../membership_youtube');
const { MembershipDiscord } = require('../membership_discord');

(async () => {
    const channel = await creatorChannel('access-token', async url => {
        assert(String(url).includes('/channels?'));
        assert(String(url).includes('mine=true'));
        return { ok: true, json: async () => ({ items: [{ id: 'UCcreator', snippet: { title: 'Creator Channel' } }] }) };
    });
    assert.deepStrictEqual(channel, { id: 'UCcreator', title: 'Creator Channel' });

    const requested = [];
    const members = await currentMembers('access-token', ['viewer-channel'], async url => {
        requested.push(String(url));
        return { ok: true, json: async () => ({ items: [{ snippet: { memberDetails: { channelId: 'viewer-channel', displayName: 'Viewer' }, membershipsDetails: { highestAccessibleLevel: 'gold-level' } } }] }) };
    });
    assert(requested[0].includes('filterByMemberChannelId=viewer-channel'), 'sync should query only linked member channel IDs');
    assert.equal(members.get('viewer-channel').levelId, 'gold-level');

    let statusWrites = 0;
    const fakeStore = {
        listLinks: () => [{ discordUserId: 'member-1', youtubeChannelId: 'viewer-channel' }],
        listStreamers: () => [{ id: 'streamer-1', displayName: 'Creator', enabled: true, connected: true }],
        credentials: () => ({ access_token: 'valid', refresh_token: 'refresh', expiry_date: Date.now() + 3600000 }),
        saveCredentials: () => {}, replaceTiers: () => {}, getStreamer: () => ({ tiers: [] }),
        saveStatus: () => { statusWrites++; }, setSyncResult: () => {}, audit: () => {},
    };
    const fakeGuild = { members: { fetch: async () => ({ roles: { cache: new Map(), add: async () => {}, remove: async () => {} } }) } };
    const verifier = new MembershipDiscord({ guilds: { cache: new Map([['guild', fakeGuild]]) } }, { store: fakeStore, fetch: async () => ({ ok: false, status: 503, statusText: 'Unavailable', json: async () => ({ error: { message: 'temporary outage' } }) }) });
    verifier.guild = async () => fakeGuild;
    const result = await verifier.syncAll();
    assert.equal(result.errors.length, 1);
    assert.equal(statusWrites, 0, 'an API failure must not create a lapse or remove a role');
    console.log('membership YouTube filtering and fail-safe sync tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
