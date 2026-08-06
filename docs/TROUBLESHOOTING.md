# MemberBridge troubleshooting

## Callback server unavailable

Confirm the callback port is unused, the bind address is valid, and the public base URL matches the reverse proxy/tunnel. Production mode requires HTTPS. Restart the bot after changing settings.

## OAuth redirect mismatch

Copy the three redirect URIs exactly as shown in the app. The Discord callback belongs in the Discord Developer Portal; both Google callbacks belong on the Google OAuth web client. Scheme, hostname, port, path, and trailing slash must match exactly.

## Creator OAuth connects but endpoint access fails

The channel must have paid channel memberships enabled, the authorizing account must own it, and the project may need membership-endpoint access from Google/YouTube. Reconnect with consent after correcting access. The app does not scrape or use browser cookies.

## Member not found

Have the member unlink and run `/membership-link` again, then choose the YouTube identity actually used for the paid membership. Permanent channel ID, not display name, is matched.

## Unmapped level

Open MemberBridge, select the creator, import levels, and map the exact returned level ID to an editable Discord role. Existing valid roles are preserved while the level is unmapped.

## Role hierarchy or permission error

Give the bot Manage Roles and move its highest Discord role above every mapped role. Integration-managed roles cannot be mapped.

## VerificationUnavailable

The last check failed because of network, quota, authorization, response, or Discord conditions. Current roles are preserved. Review Live logs and the MemberBridge audit, then reconnect the creator if authorization was revoked.

## Safe mode

Safe mode pauses role removals after database/integration danger or mass absence. Investigate creator authorization, imported levels, role hierarchy, and the audit log. Run a healthy manual verification before disabling safe mode.

## Database recovery

Stop the bot before copying or restoring `bot-data/memberbridge.db`. Preserve the entire bot-data directory before repair. Never delete the database as an automatic troubleshooting step.
