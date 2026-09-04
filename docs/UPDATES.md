# Updates

The Electron/NSIS package replaces application binaries while leaving `commission-config.json` and `bot-data` outside the installation directory.

Before installing an update:

1. Stop protection from The Commission or the tray menu.
2. Back up the application-data directory.
3. Install the newer trusted package over the current version.
4. Start the app and protection worker.
5. Check Live logs, Discord connectivity, economy panels, tickets, and Going Live.

The old MemberBridge database and bot-authored panels may be removed during upgrade. The replacement verifier stores its data separately in `commission-memberships.sqlite`.

The source repository does not contain production signing credentials or an update-manifest URL. Configure Windows code signing and any hosted update feed outside the repository.
