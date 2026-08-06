# Membership verification

MemberBridge first links a Discord account to the permanent channel ID of its verified YouTube connection in Discord. Regular members do not sign into Google. Each accepted creator separately authorizes MemberBridge to check that creator's own channel memberships.

During verification, MemberBridge sends up to 100 linked YouTube channel IDs to YouTube using that creator's authorization. YouTube reports which IDs are active and returns the highest accessible membership-level ID and accessible level IDs. MemberBridge compares those permanent IDs to the Discord role-ID mappings configured in The Commission.

Default **Highest level only** mode grants only the role mapped to `highestAccessibleLevel`. **Cumulative** mode grants mapped accessible-level roles. **General + highest** grants one general creator role plus the highest mapped level role. One creator's expiration never removes roles owned by another creator.

## State and safety

The durable states are Unverified, Active, PendingMissingConfirmation, GracePeriod, Expired, VerificationUnavailable, UnmappedLevel, ManualOverride, and Unlinked.

A member counts as missing only after the correct creator's targeted request succeeds, includes the linked ID in its request batch, parses as structurally valid data, and does not return that ID. Failures do not increment missing counters.

After the configured successful-missing threshold, the member enters grace and keeps all creator roles. If membership returns, grace is canceled immediately. After the deadline, MemberBridge performs a final check and removes managed roles only if that check succeeds and still confirms absence. If the final check cannot run, roles remain.

Downgrades require the creator's configured confirmation count. Upgrades are applied immediately. Both add the replacement role before removing an obsolete role. Unmapped levels preserve the current valid role during the mapping problem.

If more than the configured percentage of at least five active members suddenly appears absent, the creator enters safe mode and all role removals pause for administrator review. Only role IDs recorded in MemberBridge mappings are ever managed.

## Creator portal

The owner creates a creator source and generates a one-time 24-hour invitation in **The Commission → MemberBridge**. The creator authorizes the Google account that owns the intended memberships-enabled YouTube channel. MemberBridge binds that permanent channel ID to the approved source and creates a private 24-hour portal session.

The portal shows only that creator's current YouTube members, current tier, membership start date, and total duration. It supports search, pagination, manual refresh, and sign-out. Every new sign-in reauthorizes the already-bound creator channel; a different channel is denied. Member lists are cached per creator source, and portal sessions never accept a creator ID from the browser when selecting data.
