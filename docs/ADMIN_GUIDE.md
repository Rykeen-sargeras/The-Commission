# MemberBridge administrator guide

1. Save the callback, Discord OAuth, and Google OAuth settings and restart the bot.
2. Confirm the verification category and channel IDs, then click **Create / repair verification panel**. The bot makes the channel read-only for members and maintains the pinned button panel after restarts or deletion.
3. In simulation mode, add a creator, activate it, add permanent-looking fake levels, and map each to an editable Discord role.
4. Add a linked test member and choose a level. The simulator immediately verifies it.
5. Test upgrades, confirmed downgrades, membership expiration, timeouts, rate limits, revoked authorization, malformed responses, restoration, and safe mode.
6. Turn off simulation, enable production mode, save, and restart.
7. Connect each real creator separately. A creator is operational only after both membership endpoints succeed.
8. Import levels and map every exact level ID. Never map by display name alone.
9. Use the dashboard, linked-member list, audit log, backups, and administrator commands for operations.

Use **Preserve role 7 days** for a time-limited, audited exception. **Resume automatic** ends the override; the next check recalculates state. Safe mode is creator-specific and pauses removals without blocking safe role additions.

Do not disable safe mode until the underlying problem is understood and a healthy verification has completed. Do not delete `memberbridge.db` to fix configuration problems.
