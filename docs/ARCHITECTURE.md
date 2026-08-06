# The Commission MemberBridge architecture

## Decision: integrate, do not replace

MemberBridge is implemented as a first-party feature inside The Commission. The existing Electron desktop process remains the administrator application and continues to own Windows startup, tray behavior, application authentication, and Windows `safeStorage` secret protection. The existing Discord.js child process remains the only Discord gateway connection. This preserves the configured bot application, token, guild, channel IDs, and Blood Money database.

The attached standalone .NET/WPF proposal is therefore translated to the repository's established Node.js/Electron architecture. Building a second WPF application and Windows service would duplicate the Discord connection and force the owner to configure a second product, contradicting the explicit requirement to insert the feature into the already-configured app.

## Runtime boundaries

```text
The Commission.exe (Electron main process)
  - encrypted configuration and machine-local login
  - desktop MemberBridge admin UI
  - IPC request/response bridge
  - starts the existing Discord worker

discord_bot.js (existing Discord worker)
  - single Discord gateway session
  - existing moderation and Blood Money features
  - MemberBridge Discord slash commands
  - MemberBridge callback server and scheduler

memberbridge/
  store.js       SQLite schema and durable state
  crypto.js      AES-256-GCM protection using a safeStorage-wrapped key
  youtube.js     official Google OAuth and YouTube Data API client
  engine.js      centralized membership state machine and role reconciliation
  web.js         OAuth routes, state/PKCE validation, privacy and result pages
  integration.js Discord commands, admin API, scheduler and simulator
```

## Persistent data compatibility

Existing files remain unchanged. MemberBridge creates `bot-data/memberbridge.db` beside the existing economy database. Schema creation is forward-only and idempotent. Updates never replace `commission-config.json` or the `bot-data` directory.

Secret values are never stored in plaintext configuration. Electron encrypts the Discord token, Discord OAuth client secret, Google OAuth client secret, and the MemberBridge database-encryption key with Windows `safeStorage`. Only decrypted values are passed to the already-local child process. Creator refresh tokens are additionally encrypted with AES-256-GCM before they enter SQLite.

## Identity and authorization

- Permanent Discord guild, user, and role IDs are authoritative.
- Permanent YouTube creator channel, member channel, and membership-level IDs are authoritative.
- Member linking begins with an ephemeral Discord command and a single-use ten-minute token.
- Discord OAuth `identify` confirms the browser user matches the command user.
- Google OAuth with PKCE retrieves the user's YouTube channel identity; member OAuth tokens are discarded after linking.
- Creator OAuth is a separate administrator-initiated flow using the creator-memberships scope. Its refresh token is encrypted and retained.
- Production callback URLs must be HTTPS. Loopback HTTP is permitted only in development mode.

## Failure and role safety

Membership absence is counted only after a successful, structurally valid targeted `members.list` response containing the requested ID batch. Network, quota, authorization, malformed-response, Discord, and database failures preserve current roles.

Role upgrades and downgrades add the replacement role first and remove obsolete MemberBridge-managed roles only after the add succeeds. Creator sources remain independent. A creator-wide sudden-absence threshold automatically enables safe mode for that source and pauses removals.

## External production boundary

The app uses only official Google OAuth and YouTube Data API endpoints. It never scrapes YouTube, imports browser cookies, or automates YouTube Studio. Google documents that `members.list` and `membershipsLevels.list` are for creators checking their own memberships-enabled channel and may require access approved by Google/YouTube. Simulation mode provides deterministic local validation but is blocked when production mode is enabled.
