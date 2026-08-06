# MemberBridge privacy

MemberBridge stores the minimum identifiers needed to verify membership and manage roles:

- Discord guild ID, user ID, and display-name snapshots;
- verified YouTube connection channel ID and display-name snapshot supplied by Discord;
- per-creator current member-list snapshots, tier IDs, membership start dates, and total-duration values supplied by YouTube;
- creator channel IDs and encrypted creator authorization;
- membership-level IDs, role IDs, verification status/history, role-operation history, and grace dates;
- administrator actions and non-secret diagnostics.

It does not store Discord or Google passwords or member email addresses. Regular members do not authorize Google. Member Discord OAuth tokens are discarded after the verified YouTube connection is identified. Creator refresh tokens remain encrypted, and creator portal cookies map only to hashed, expiring server-side sessions.

Members can run `/membership-unlink` and confirm the private button. Administrators can export the current link/membership record or unlink a member from the desktop service API. Historical audit rows contain permanent/pseudonymous IDs needed for security accountability but never OAuth secrets.

The server owner is responsible for telling members why this data is processed, controlling retention and backups, securing the Windows host, and honoring applicable deletion/export obligations.
