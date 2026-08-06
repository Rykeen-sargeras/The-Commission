# MemberBridge troubleshooting

## Callback server unavailable

Confirm the callback port is unused, the bind address is valid, and the public base URL matches the reverse proxy/tunnel. Production mode requires HTTPS. Restart the bot after changing settings.

## OAuth redirect mismatch

Copy the two redirect URIs exactly as shown in the app. The Discord callback belongs in the Discord Developer Portal; the creator Google callback belongs on the Google OAuth web client. Scheme, hostname, port, path, and trailing slash must match exactly.

## Creator OAuth connects but endpoint access fails

The channel must have paid channel memberships enabled, the authorizing account must own it, and the project may need membership-endpoint access from Google/YouTube. Reconnect with consent after correcting access. The app does not scrape or use browser cookies.

## Member not found

Have the member open Discord **User Settings → Connections**, connect and verify the YouTube identity used for the paid membership, then unlink and run `/membership-link` again. Permanent channel ID, not display name, is matched.

## Creator cannot sign into the portal

For a creator that has never connected, generate a fresh one-time invitation in the owner app; invitations expire after 24 hours and are consumed when OAuth begins. For an already connected creator, generate the permanent creator sign-in link. Google must authorize the same permanent YouTube creator channel already bound to that source.

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
