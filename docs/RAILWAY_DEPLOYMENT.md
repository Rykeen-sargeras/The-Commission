# Railway deployment

Railway runs `railway_start.js`, which manages the Discord worker and the hosted control surface. Configure `DISCORD_TOKEN`, the required Discord IDs, `WEB_DASHBOARD_PASSWORD`, and a persistent `DATA_DIR` such as `/data`.

The hosted service provides health and Going Live endpoints. It does not provide MemberBridge OAuth, creator portals, membership scheduling, or YouTube role reconciliation; those retired responsibilities belong to Safetybot.

Mount persistent storage before deployment. Without a volume, Blood Money balances, REP data, moderation state, Going Live schedules, and logs can disappear when Railway replaces a container.

Use the Railway health check endpoint and review the worker logs after every deployment. Keep secrets in Railway variables rather than committing them to the repository.
