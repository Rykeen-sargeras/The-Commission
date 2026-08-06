# MemberBridge privacy

MemberBridge stores the minimum identifiers needed to verify membership and manage roles:

- Discord guild ID, user ID, and display-name snapshots;
- selected YouTube member channel ID, display-name snapshot, and optional public thumbnail URL;
- creator channel IDs and encrypted creator authorization;
- membership-level IDs, role IDs, verification status/history, role-operation history, and grace dates;
- administrator actions and non-secret diagnostics.

It does not store Google passwords or member email addresses. Member identity OAuth tokens are discarded after identifying the selected channel.

Members can run `/membership-unlink` and confirm the private button. Administrators can export the current link/membership record or unlink a member from the desktop service API. Historical audit rows contain permanent/pseudonymous IDs needed for security accountability but never OAuth secrets.

The server owner is responsible for telling members why this data is processed, controlling retention and backups, securing the Windows host, and honoring applicable deletion/export obligations.
