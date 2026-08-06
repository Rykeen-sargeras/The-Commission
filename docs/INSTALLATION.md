# Installation and upgrades

Run `The Commission Setup 3.0.1.exe` and choose an installation directory. The installer creates Start Menu and desktop shortcuts. Existing configuration and bot data live in the current Windows user's Electron application-data directory, outside the installed binaries, so normal upgrades and repairs preserve them.

On first launch, sign in, save the existing Discord bot token, and start the bot. Enable **Launch with Windows**, **Start protection automatically**, and **Close to system tray** under Windows if desired.

MemberBridge is disabled by default during an upgrade. Open its page, keep simulation mode on, save, restart, and run the simulator before configuring public OAuth. Production requires an HTTPS callback domain/reverse proxy/relay/tunnel forwarding only the MemberBridge callback port.

Before an upgrade, use **MemberBridge → Create backup** and keep the existing application-data directory private. The app also creates a verified backup automatically every 24 hours while the bot runs.

Normal uninstall removes the installed application. Copy the application-data folder first if the data must be retained across a manual uninstall/reinstall.
