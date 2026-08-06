# Discord setup for MemberBridge

MemberBridge reuses the existing The Commission Discord application and bot token.

1. Open the application's page in the Discord Developer Portal.
2. Under **OAuth2**, copy the application ID into **The Commission → MemberBridge → Discord application ID**.
3. Copy the OAuth client secret into the encrypted Discord OAuth client-secret field.
4. Add the exact redirect URI shown by the app: `https://YOUR_DOMAIN/oauth/discord/callback`.
5. Under **Bot**, keep **Server Members Intent** and **Message Content Intent** enabled for the existing features.
6. Invite the bot with `bot` and `applications.commands` scopes.
7. Give the bot **Manage Roles**, plus its existing moderation permissions.
8. Move the bot's highest role above every membership role it will manage.

MemberBridge rejects roles that are missing, managed by an integration, or at/above the bot's highest role. It adds a replacement role before removing an obsolete role.

The member link flow uses Discord OAuth `identify` to ensure the browser user is the same permanent Discord user ID that ran `/membership-link`. The OAuth state is single use and expires with the ten-minute link session.

Administrator slash commands require Discord Administrator or one of the MemberBridge administrator role IDs configured in the desktop app. Member commands always reply ephemerally so linked identity details are not exposed publicly.
