# Railway deployment

Railway runs `railway_start.js`, which manages the Discord worker and the hosted control surface. Configure `DISCORD_TOKEN`, the required Discord IDs, `WEB_DASHBOARD_PASSWORD`, and a persistent `DATA_DIR` such as `/data`.

The hosted YouTube clipper is available at `https://YOUR-DOMAIN.up.railway.app/clipper`. Configure a separate `CLIPPER_PASSWORD` to share with clipper users; they never need the Discord token or dashboard password. Optional settings are `MAX_CLIP_MINUTES` (default `15`) and `YOUTUBE_PROXY_URL` if YouTube blocks requests from the Railway server. Generated MP4 files are temporary direct downloads only, always expire after three hours, and are not listed, sent to Discord, copied to Google Drive, or retained permanently.

The hosted service also provides the replacement YouTube membership verifier. It supports creator Google OAuth, member Discord Connections OAuth, per-streamer tier mappings and grace periods, automatic synchronization, and audit history. Follow `docs/YOUTUBE_MEMBERSHIPS.md`; Google must separately approve each creator channel for the restricted YouTube Memberships API.

Mount persistent storage before deployment. Without a volume, Blood Money balances, membership links, REP data, moderation state, Going Live schedules, and logs can disappear when Railway replaces a container.

Use the Railway health check endpoint and review the worker logs after every deployment. Keep secrets in Railway variables rather than committing them to the repository.
