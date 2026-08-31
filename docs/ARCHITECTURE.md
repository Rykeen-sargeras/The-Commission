# The Commission architecture

The Commission runs one Discord.js worker from either the Electron desktop control panel or the Railway launcher. `discord_bot.js` creates the Discord client, and `discord_features.js` explicitly installs each client-bound feature before login.

## Runtime boundaries

- `desktop/` owns the Windows UI, encrypted configuration, process lifecycle, and tray behavior.
- `railway_start.js` owns hosted configuration, process lifecycle, and public Going Live pages.
- `discord_bot.js` owns the Discord gateway client and coordinates moderation, economy, REP, tickets, and voice systems.
- `economy.js` owns economy persistence and core game behavior.
- `economy/` contains Luck Shop and slots modules; `economy_discord.js` owns Discord commands and panels.
- `memberbridge/integration.js` is a temporary retirement migration only. It removes legacy MemberBridge data and panels and exposes no commands or active verification service.

## Membership verification

MemberBridge is retired. YouTube membership verification is owned by the standalone Safetybot project. The Commission must not start OAuth callbacks, YouTube polling, membership schedulers, or role reconciliation.

The small retirement integration remains so upgrades can remove legacy SQLite files, backups, and bot-authored verification panels safely. It should be removed only after all deployed installations have completed that migration.

## Startup rule

Feature modules must export explicit installers. Importing a module must not patch `Discord.Client.login()` or another library prototype. Add new client-bound features to `discord_features.js` so startup order stays visible and testable.
