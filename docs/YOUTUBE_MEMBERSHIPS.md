# YouTube memberships setup

The Commission supports multiple creator channels. The owner chooses the creators and maps each YouTube membership tier to a Discord role. A creator authorizes YouTube once through a private link. Regular members use `/verify`, which reads the YouTube account already connected in Discord.

## Before deployment

1. Mount a Railway volume at `/data` and set `DATA_DIR=/data`.
2. Confirm the Discord bot role is above every membership role it will manage.
3. Enable the YouTube Data API v3 in a Google Cloud project and configure its OAuth consent screen.
   Add both `youtube.channel-memberships.creator` (to read membership levels and active members) and `youtube.readonly` (to identify the creator channel that approved the connection). The app requests no write access.
4. Create a Google Web application OAuth client. Add exactly:
   `https://YOUR-DOMAIN.up.railway.app/membership/google/callback`
5. In the Discord Developer Portal for the same bot application, add exactly:
   `https://YOUR-DOMAIN.up.railway.app/membership/discord/callback`
6. Each supported creator must have access to the restricted YouTube Memberships API. OAuth cannot bypass YouTube's channel eligibility or API allowlisting.

## Control-room settings

Open **Membership Setup** and enter:

- `MEMBERSHIP_PUBLIC_BASE_URL`: the Railway HTTPS domain, with no trailing path.
- `MEMBERSHIP_GUILD_ID`: the Discord server ID.
- Google OAuth client ID and secret.
- Discord application ID and OAuth client secret.
- Two different long random values for the encryption key and state secret. Back up the encryption key; changing it makes stored creator credentials unreadable and requires creators to reconnect.
- Sync interval in minutes. The minimum is 15 and the default is 360 (six hours).

Save and restart the bot. Secrets are masked when the page reloads.

## Add a creator

1. Open **YouTube Members**.
2. Enter the creator/show name, the channel ID beginning with `UC`, and a grace period in days.
3. Select **Creator link** and send the generated link privately to that creator. It is single-use and expires after seven days.
4. The creator opens the link, selects the correct YouTube channel, and approves access. She does not share her Google password or OAuth tokens with the owner.
5. Reload the page. Assign one Discord role to each returned YouTube tier.
6. Select **Sync now** for a controlled first test.

## Member experience

1. The member connects YouTube under Discord **User Settings → Connections** if it is not connected already.
2. In the server, the member runs `/verify`.
3. The member clicks **Verify YouTube Membership** and approves Discord's `identify` and `connections` permissions.
4. The bot checks every supported creator and assigns the mapped role for the member's highest accessible tier.

The bot does not ask regular members to sign into Google. It stores the Discord user ID and the YouTube channel ID returned by Discord.

## Grace periods and failures

When a successful YouTube sync no longer returns a member, the configured grace period begins. The existing role remains until that period expires. A reactivated membership cancels the lapse and updates the role normally. Google, YouTube, network, credential, and rate-limit failures are recorded as errors and never count as a lapse, so an outage cannot strip roles.

Deleting a creator configuration does not remove roles immediately. This is intentional protection against an accidental dashboard deletion; remove obsolete roles manually or allow a final successful sync before deleting the configuration.
