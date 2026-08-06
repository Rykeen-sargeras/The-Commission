# Google and YouTube setup

1. Create or select a Google Cloud project.
2. Enable **YouTube Data API v3**.
3. Configure the OAuth consent screen. While testing, add the owner and test members as test users. Public production use may require Google verification.
4. Create an OAuth 2.0 client of type **Web application** because the bot hosts stable callback routes and securely stores the client secret on the Windows host.
5. Copy the client ID and client secret into **The Commission → MemberBridge**. The secret is encrypted with Windows and is not displayed again.
6. Add all three exact authorized redirect URIs displayed in the app:

   - `https://YOUR_DOMAIN/oauth/google/callback`
   - `https://YOUR_DOMAIN/oauth/google/creator-callback`
   - Discord's callback is configured in Discord, not Google.

7. Save, restart the bot, create a creator source, and select **Connect creator OAuth**.
8. Sign into the Google account that owns the exact memberships-enabled creator channel and approve the requested scopes.
9. MemberBridge tests `channels.list`, `membershipsLevels.list`, and `members.list` before marking the creator operational.
10. Import the permanent membership-level IDs and map them to editable Discord roles.

The creator flow requests `https://www.googleapis.com/auth/youtube.channel-memberships.creator`. The member identity flow requests read-only YouTube access only long enough to retrieve the selected permanent channel ID. Member access/refresh tokens are not retained.

Important: Google's official documentation says `members.list` and `membershipsLevels.list` can be used by an individual creator for their own channel-memberships-enabled channel, and directs developers to contact a Google or YouTube representative for endpoint access. Ordinary OAuth approval alone does not guarantee access. If the endpoint denies access, MemberBridge leaves the creator disabled and never scrapes YouTube or requests cookies.

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
