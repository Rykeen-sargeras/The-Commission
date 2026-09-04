# Google OAuth approval checklist

Use the production Google Cloud project `misfit-mafia-youtube-bot`.

## Production settings

- App name: `Misfit Mafia YouTube Bot`
- Homepage: `https://verify.misfitmafia.site/`
- Privacy policy: `https://verify.misfitmafia.site/privacy`
- Terms: `https://verify.misfitmafia.site/terms`
- Authorized domain: `misfitmafia.site`
- User type: External
- Publishing status: In production
- APIs: YouTube Data API v3 enabled
- Scopes:
  - `https://www.googleapis.com/auth/youtube.channel-memberships.creator`
  - `https://www.googleapis.com/auth/youtube.readonly`

The final authorized redirect URI must exactly match `MEMBERSHIP_PUBLIC_BASE_URL` plus `/membership/google/callback`. Do not replace the old `/auth/google/callback` redirect until the integrated Commission deployment is live and ready to test. During the cutover, both redirect URIs may be kept temporarily so the old verifier remains recoverable.

## Scope explanation for Google

Misfit Mafia YouTube Bot lets participating YouTube creators connect a channel they own or manage so their paid membership levels can be mapped to Discord roles. The `youtube.channel-memberships.creator` scope is used to read the creator's membership levels and current active members during initial setup and scheduled synchronization. The `youtube.readonly` scope is used only to identify the YouTube channel that authorized the connection and confirm it matches the creator selected by the administrator. The app does not modify YouTube data. OAuth tokens are encrypted at rest and used only for membership verification and role synchronization. Google data is not sold, used for advertising, or shared with unrelated third parties. No narrower scopes provide the required channel-membership data and authorized-channel identity.

## Demonstration video

Record one continuous, unlisted YouTube video showing:

1. The public homepage, privacy policy, and terms pages.
2. The administrator adding a supported creator with the expected `UC...` channel ID and grace period.
3. The administrator generating the private creator link.
4. The creator opening the link and reaching Google's consent screen.
5. The consent screen showing the exact app name and both requested YouTube permissions.
6. The creator approving access and returning to the success page.
7. The dashboard showing the connected channel and returned membership tiers.
8. A tier being mapped to a Discord role.
9. A Discord member running `/verify` with a linked YouTube connection.
10. A successful sync assigning or maintaining the corresponding Discord role.
11. The creator disconnect control and the privacy-policy deletion instructions.

Do not expose client secrets, OAuth tokens, Discord tokens, passwords, database URLs, or private invite tokens in the recording.

## Submission order

1. Deploy and test the integrated application with a test creator.
2. Verify `misfitmafia.site` ownership in Google Search Console using the same Google account that submits the OAuth review.
3. Update the OAuth client with the integrated callback URI.
4. Record and upload the unlisted demonstration video.
5. Paste the scope explanation and video URL into Data Access.
6. In Branding, select **I have fixed the issues** for the previous review findings.
7. Review every field, then submit for verification.

YouTube grants access to the memberships endpoints at the creator-channel level. Google OAuth approval does not by itself grant an otherwise ineligible channel access to `members.list` or `membershipsLevels.list`.
