# The Commission

The Commission is a Windows control panel for the existing Discord protection bot. It replaces Railway-only configuration and hard-coded Discord IDs with an encrypted local UI.

## Included

- Password-locked desktop control panel
- Windows-encrypted Discord token and API-key storage
- Editable channel, category, role, user, moderation, report, jail, and Blood Money settings
- Join-triggered preemptive ban list with username, display name, avatar, ID, account age, reason, and timestamp logging
- Local server blueprints for roles, permissions, categories, channels, ordering, and role-based channel overrides
- Start/stop controls and live process logs
- Existing moderation dashboard in a local-only window
- Start-with-Windows, automatic bot startup, and close-to-system-tray background operation
- Transactional local SQLite Blood Money economy with activity rewards, daily claims, transfers, dynamic-limit dice, blackjack, video poker, duels, audit history, and anti-farming reward protections
- Preview-and-confirm reset controls that preserve lifetime statistics and archive final weekly/monthly rankings
- Locked monthly REP system: +1 per message after a two-minute cooldown and +10 per 30 qualifying voice minutes with at least two people
- NSIS installer and portable Windows executable builds
- Local persistence under the current Windows user's application-data folder
- Integrated MemberBridge for official YouTube channel-membership verification and permanent level-ID → Discord role-ID mapping

## First run

1. Install and open **The Commission**.
2. Sign in with the password configured for this build.
3. Open **Connection**, paste the Discord bot token, and save.
4. Review every Discord ID. Existing IDs were migrated as editable defaults.
5. Rotate the Positionstack API key that was previously committed in source, then save the replacement under **API services**.
6. Select **Start protection** and review **Live logs**.
7. The Commission starts with Windows and closes to the system tray by default. Use the tray menu to reopen or exit it.

## MemberBridge

Version 3 adds MemberBridge inside the same The Commission app and Discord bot. It does not require a second bot token or replace the existing Blood Money database. MemberBridge has its own SQLite database under the existing `bot-data` folder and receives the same start-with-Windows, tray, encrypted-secret, installer, and update-preservation behavior as the rest of The Commission.

Member commands are `/membership-link`, `/membership-status`, `/membership-recheck`, `/membership-unlink`, and `/membership-help`. Administrator commands are `/memberbridge-health`, `/memberbridge-sync`, `/memberbridge-check-user`, and `/memberbridge-reload-commands`.

Start with simulation mode to add fake creator levels and linked test members from the MemberBridge page. Production mode rejects simulated responses and requires an HTTPS public callback URL. Member links use a single-use ten-minute token and Discord OAuth `identify connections` to read a verified YouTube channel ID; members do not sign into Google and their Discord OAuth token is discarded. Approved creators authorize the official creator-memberships scope through a private invitation and receive an isolated web portal for their own current member list. Creator refresh tokens are encrypted before they enter SQLite.

On Railway, `/owner` is a limited password-protected creator manager backed by `WEB_DASHBOARD_PASSWORD`. It adds approved creator sources and generates private creator access links against the live hosted database; it does not expose the full moderation or economy control panel.

Verification batches up to 100 member channel IDs per official `members.list` request. API errors, quota errors, malformed data, revoked creator authorization, Discord outages, and database problems preserve current roles and do not count as missing membership. Confirmed absence requires the configured number of successful checks, then enters grace. Final role removal requires another successful check after the grace deadline. Sudden mass absence automatically pauses removals in safe mode.

Production setup is described in [GOOGLE_SETUP.md](docs/GOOGLE_SETUP.md), [DISCORD_SETUP.md](docs/DISCORD_SETUP.md), and [MEMBERSHIP_VERIFICATION.md](docs/MEMBERSHIP_VERIFICATION.md). YouTube states that the membership endpoints are for individual creators checking their own memberships-enabled channel and that access may require contacting a Google or YouTube representative. The Commission never falls back to scraping, browser cookies, or YouTube Studio automation.

## Blood Money economy

The **Blood Money** page controls text, media, voice, daily, transfer, gambling, audit, and exclusion settings. Blackjack and video poker each have separate administrator-configured minimum wagers, per-game maximums, and daily wager caps. A global daily wager-amount cap and global gambling-action limits per minute and per hour apply across dice, poker, blackjack (including doubles and splits), and duel stakes. A value of zero disables the corresponding global limit. Wagers over the member's balance, game cap, remaining daily allowance, or rate allowance are rejected.

Member commands include `/balance`, `/daily`, `/leaderboard`, `/economy-stats`, `/pay`, `/dice`, `/poker`, `/blackjack`, and `/duel`. Administrators use `/economy` for balance adjustments, account freezes, daily resets, channel exclusions, audits, and the gambling switch.

Daily, weekly, monthly, balance, lifetime, gambling, and voice leaderboards are available. Completed weekly and monthly leaderboards are saved in durable local snapshots and uploaded as text archives. At monthly rollover, every current balance resets to zero while lifetime statistics and the transaction ledger remain intact. Missed rollovers run after the bot starts again, and failed Discord uploads remain queued for retry.

The desktop reset console supports weekly/monthly rankings, activity statistics, gambling statistics, every current balance, one member's current balance, and daily blackjack/poker allowances. Every operation requires a five-minute preview followed by confirmation and writes to the economy audit channel. Period resets use cutoffs rather than deleting history. Final weekly/monthly ranking previews are uploaded before a manual ranking reset is applied.

The desktop bulk-grant panel can add any positive amount, such as 2,500 or 5,000, to every human member in the Discord server. It fetches the full server member list, excludes bots, previews the recipient count and total currency created, and requires confirmation within five minutes. Each recipient gets an `admin-bulk-add` ledger entry sharing one batch ID, and the server-wide operation is posted to the economy audit channel. Administrative grants change current balances without counting as earned leaderboard or lifetime income.

The desktop UI also accepts dedicated leaderboard and heist channel IDs. The bot maintains one persistent leaderboard panel and one timed heist panel, edits them after restarts, and recreates them if deleted. A new free heist opens every hour at `:00`, entries remain open through `:57`, the result resolves at `:58`, and the two-minute closed period lasts until the next hour. Entry deducts no Blood Money, and every crew member receives the configured fixed reward when the heist succeeds. Crew minimums, success chances, and rewards remain configurable. The panel provides Enter Free Heist and private My Entry Status buttons; entries and active rounds are stored transactionally in SQLite.

A dedicated public gambling channel can be configured for `/dice`, `/poker`, `/blackjack`, and `/duel`. The `/dice` maximum recalculates before every roll and equals 10% of the richest current member balance in the server. The jackpot and mid-tier multipliers accept decimal values, and the jackpot, mid-tier, 1× refund, and 0× loss probabilities each accept decimal percentages that must total exactly 100%. Decimal payouts round down to whole Blood Money. Poker is rendered as a public text table: the initial hand, held-card state, automatic timeout draw, final hand, payout, and balance remain visible to everyone while button security limits Hold and Draw to the player. The Blood Money page includes a **Push / repair heist panel** action for immediate manual publication.

Blackjack is public and text based, with secure Hit, Stay, Double Down, and Split buttons, dealer stay on 17, and natural blackjack at 3:2. Its opening limit is configured in the app. Doubles and splits may raise the total above the per-game opening cap when the player has enough balance and daily blackjack allowance. Split hands are played separately with full Hit, Stay, and Double Down choices. The configured payout adjustment is applied internally without cluttering the public game table. Dealer natural 21 ends the hand immediately and is labeled clearly; inactive hands automatically stay after two minutes. `/duel @member amount` creates a fair 50/50 player wager with no fee; the challenged member types `!accept` or `!deny` in the same channel. The challenger stake is reserved immediately, accepted duels reserve the matching stake, and denied or unanswered five-minute challenges refund the challenger automatically.

Prize-eligible months can be listed in the app as month numbers or exact `YYYY-MM` periods. Prize results exclude bots, configured staff roles, Discord administrators, the server owner, and configured excluded accounts. Members holding a configured staff role may use `/economy add`, `remove`, `set`, and `reset-user`; every correction remains fully logged. Other economy administration actions still require Discord Administrator permission.

REP is stored separately from Blood Money and has no administrator adjustment command. The Blood Money and REP panels share the single configured leaderboard channel, where members can privately check their REP points and position. REP comes only from typing (+1 after a personal two-minute cooldown) and qualifying voice participation (+10 after each accumulated 30 minutes in a non-AFK voice channel containing at least two human members). On the first day of each month at 8:00 AM Eastern, REP resets automatically, the top five are announced in the shared leaderboard channel, and the full ranking is uploaded as a text file to the Blood Money audit/log channel. Missed offline rollovers and failed Discord deliveries retry when the bot is running again. Blood Money reset controls do not modify REP.

The manual heist action saves the current desktop form first and passes its channel ID directly to the running bot, so a configuration restart is no longer required just to publish or repair the panel.

The control panel can remain signed in on the current Windows account. The saved password is recovered through Electron's Windows user-scoped encrypted storage at startup; no plaintext password is written to the configuration file. Automatic login can be disabled under Windows settings, and **Lock panel** still locks the current session immediately.

## Preemptive ban list

1. Open **Protection → Preemptive ban list**.
2. Paste one Discord user ID per line, or separate IDs with commas.
3. Enter the reason that should appear in Discord's audit log.
4. Save settings, then restart the bot.

When a listed user joins, the bot bans them immediately. The configured audit-log channel receives an embed containing the username, display name, user ID, account creation date, avatar captured at enforcement time, reason, result, and timestamp. If no audit-log channel is configured, the moderator channel is used.

## Server blueprints

1. Install the bot in both the source and destination servers.
2. Give it **Manage Roles**, **Manage Channels**, **View Channels**, and **Manage Server** permissions. Administrator is simplest during a private one-time setup.
3. Start the bot and open **Blueprints**.
4. Refresh servers, select the source, and capture the blueprint.
5. Select the saved blueprint and destination server.
6. Leave **Apply @everyone base permissions** off unless you intentionally want to change that existing server-wide role.
7. Apply the blueprint.

Blueprints are saved locally. Applying one creates roles, categories, supported channels, channel settings, ordering, and role-based permission overrides. It never deletes destination content and does not copy messages, members, bans, webhooks, or member-specific permission overrides.

## Discord requirements

In the Discord Developer Portal, enable:

- Server Members Intent
- Message Content Intent

The bot account also needs the Discord permissions used by its moderation, channel, role, voice, and message features.

## Development

Requires Node.js 22.13 or newer.

```powershell
npm install
npm start
```

Syntax validation:

```powershell
npm run check
```

Build the installer and portable executable:

```powershell
npm run dist
```

Artifacts are written to `dist`.

## Security notes

- The desktop lock is an application-level control, not a replacement for a secured Windows account.
- Secrets are encrypted with Electron `safeStorage`, which uses Windows data protection for the signed-in user.
- The moderation dashboard binds to `127.0.0.1` and is not exposed to the LAN.
- Railway deployment uses the generated HTTPS domain and port automatically; see `docs/RAILWAY_DEPLOYMENT.md`.
