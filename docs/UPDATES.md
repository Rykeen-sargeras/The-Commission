# Updates

The Commission's Electron/NSIS package replaces application binaries while leaving `commission-config.json`, `bot-data`, MemberBridge SQLite data, encrypted credentials, role mappings, grace periods, overrides, audit records, and backups outside the installation directory.

Before installing an update:

1. Create and verify a MemberBridge backup.
2. Stop the bot from The Commission or the tray menu.
3. Install the newer signed/trusted package over the current version.
4. Start the app and bot.
5. Check Live logs, `/memberbridge-health`, creator status, role mappings, and a simulated or authorized test member.

The source repository does not contain production signing credentials or an update-manifest URL. Windows code signing and any hosted auto-update feed must be configured by the owner before distributing builds to other PCs.
