# Railway deployment

The Commission can run either as the Windows desktop app or as one Railway service. Do not run both copies of the Discord worker at the same time because both would use the same bot token and process every event twice.

## What Railway hosts

- The Discord gateway worker, moderation systems, Blood Money, REP, gambling, heists, and MemberBridge scheduler.
- The public MemberBridge HTTPS pages, password-protected owner creator manager, isolated creator portals, Discord Connections callback, and creator Google OAuth callback.
- Persistent bot data on a Railway volume mounted at `/data`.

The Electron control panel itself is a Windows application and is not served by Railway. Railway configuration is managed through service variables.

## Deploy

1. Create a Railway project from the private GitHub repository.
2. Add a volume to the bot service and mount it at `/data`.
3. Generate a Railway public domain for the service.
4. Open the service **Variables** tab and copy the names from `.env.railway.example`. Paste real secrets only into Railway, never into GitHub.
5. Set `DATA_DIR=/data`, `COMMISSION_RAILWAY_MODE=true`, and a long unique `WEB_DASHBOARD_PASSWORD`.
6. Deploy. The health check is `GET /health`.

Railway provides `PORT` and `RAILWAY_PUBLIC_DOMAIN`. In Railway mode the bot automatically listens on `0.0.0.0:$PORT` and uses `https://$RAILWAY_PUBLIC_DOMAIN` as the MemberBridge public base URL. The full local moderation dashboard is deliberately not exposed. The limited creator manager is available at `https://YOUR-DOMAIN/owner`; it can add creator sources and generate invitations but cannot change moderation or economy settings.

## Owner and creator pages

1. Visit `https://YOUR-DOMAIN/owner` and sign in with `WEB_DASHBOARD_PASSWORD`.
2. Add an approved creator source.
3. Select **Create invitation** and privately send the one-time 24-hour URL to that creator.
4. The creator authorizes the Google account that owns their memberships-enabled channel and lands on their isolated member-list dashboard.
5. After the channel is connected, the owner page produces a permanent sign-in URL. Every sign-in still requires Google to prove control of that exact channel.

## OAuth redirects

After Railway generates the domain, register these exact HTTPS redirects:

- Discord: `https://YOUR-DOMAIN/oauth/discord/callback`
- Google creator: `https://YOUR-DOMAIN/oauth/google/creator-callback`

Reset any OAuth secret that was ever posted in chat or otherwise exposed, and enter only the replacement secret in Railway.

## Persistence

The SQLite databases and JSON state must live under `/data`. Without a volume, balances, REP, membership links, ban words, and logs can disappear when Railway replaces a deployment container.
