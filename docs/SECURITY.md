# MemberBridge security

- The Discord bot token, Discord OAuth secret, Google OAuth secret, and MemberBridge encryption key use Electron's Windows `safeStorage` protection.
- Creator refresh tokens use AES-256-GCM before being stored in `memberbridge.db`.
- Member identity tokens are discarded after the YouTube channel is identified.
- Link tokens are random, stored only as SHA-256 hashes, expire in ten minutes, and are single use.
- Discord and Google callbacks validate independently generated single-use OAuth state.
- Google authorization uses PKCE S256.
- OAuth pages use secure/no-store headers, restrictive content security policy, SameSite cookies, input limits, and per-IP rate limits.
- Production mode requires an HTTPS public base URL and refuses simulation mode.
- Logs and audit records never contain access tokens, refresh tokens, client secrets, raw link tokens, passwords, or full sensitive HTTP responses.
- Membership verification and role removal fail closed: technical failures preserve roles.
- Database integrity failure or mass-absence detection pauses destructive role operations.

The Windows account running The Commission controls the encrypted configuration. Protect that account with a strong Windows password and disk encryption. Do not publish `commission-config.json`, `memberbridge.db`, the bot-data directory, or backups. Rotate a client secret immediately if it is exposed.

The desktop lock has no password or password hash embedded in the source. On a fresh install, the first login sets a password of at least 12 characters and protects its derived hash with Windows `safeStorage`. Existing installations migrate automatically from the previously saved, Windows-encrypted login.

Only forward the MemberBridge callback port through a reverse proxy or tunnel. The legacy moderation dashboard is bound to loopback and must remain private.
