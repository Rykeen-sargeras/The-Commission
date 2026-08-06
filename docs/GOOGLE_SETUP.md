# Google and YouTube setup

1. Create or select a Google Cloud project.
2. Enable **YouTube Data API v3**.
3. Configure the OAuth consent screen. While testing, add each approved creator as a test user. Regular Discord members do not use Google OAuth. Public creator use may require Google verification.
4. Create an OAuth 2.0 client of type **Web application** because the bot hosts stable callback routes and securely stores the client secret on the Windows host.
5. Copy the client ID and client secret into **The Commission → MemberBridge**. The secret is encrypted with Windows and is not displayed again.
6. Add the exact Google authorized redirect URI displayed in the app:

   - `https://YOUR_DOMAIN/oauth/google/creator-callback`
   - Discord's callback is configured in Discord, not Google.

7. Save, restart the bot, and create a creator source.
8. Select **Generate creator portal link**, copy the one-time invitation, and send it privately to that creator. The invitation expires after 24 hours and can be used once.
9. The creator signs into the Google account that owns the exact memberships-enabled channel and approves the requested scopes.
10. MemberBridge tests `channels.list`, `membershipsLevels.list`, and `members.list`, imports the current member list, and opens that creator's private dashboard.
11. In the owner app, map the imported permanent membership-level IDs to editable Discord roles.

The creator flow requests `https://www.googleapis.com/auth/youtube.channel-memberships.creator` plus read-only YouTube identity access. Creator refresh tokens are encrypted. Regular members authorize Discord's `identify` and `connections` scopes instead of Google; their Discord access token is discarded immediately after the verified YouTube connection is read.

After the first connection, **Generate creator portal link** returns a permanent sign-in URL for that creator source. Google authorization proves the channel identity on every new portal login. A 24-hour server-side session then grants access only to that creator's cached member list.

Important: Google's official documentation says `members.list` and `membershipsLevels.list` can be used by an individual creator for their own channel-memberships-enabled channel, and directs developers to contact a Google or YouTube representative for endpoint access. Ordinary OAuth approval alone does not guarantee access. If either endpoint denies access, MemberBridge retains the verified creator authorization, opens the creator's private setup page, explains how to enable memberships or request endpoint access, and provides a retry button. The source becomes operational only after a successful live API refresh. MemberBridge never scrapes YouTube, accepts uploaded rosters, or requests browser cookies.

Official references:

- https://developers.google.com/youtube/v3/docs/members/list
- https://developers.google.com/youtube/v3/docs/membershipsLevels/list
- https://developers.google.com/identity/protocols/oauth2/web-server

## Local testing

Keep **Development simulator** enabled and **Production mode** disabled. The default loopback callback is `http://127.0.0.1:17842`. Add simulated creator levels, permanent-looking test role mappings, and a Discord test member from the MemberBridge page. Simulation data cannot be used after production mode is enabled.

## Public HTTPS choices

The Windows PC still hosts the bot. Point the configured HTTPS domain to it through one of these owner-managed choices:

- a domain and reverse proxy terminating TLS;
- a small trusted OAuth relay forwarding callbacks to the PC;
- a secure tunnel forwarding the MemberBridge callback port.

Restrict any public forwarding to the MemberBridge callback port. Do not expose the separate local moderation dashboard.
