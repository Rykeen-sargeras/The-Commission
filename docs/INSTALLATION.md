# Installation and upgrades

Run the current The Commission installer and choose an installation directory. The installer creates Start Menu and desktop shortcuts. Configuration and bot data live in the current Windows user's Electron application-data directory, outside the installed binaries, so normal upgrades preserve them.

On first launch, sign in, save the Discord bot token, review the configured Discord IDs, and start protection. Windows startup, automatic protection, and close-to-tray behavior are optional.

The old MemberBridge database and panels are removed during startup. The new hosted verifier uses a separate database and is configured from the Railway control room; see `YOUTUBE_MEMBERSHIPS.md`.

Normal uninstall removes the installed application. Copy the application-data folder first if other Commission data must survive a manual uninstall or machine migration.
