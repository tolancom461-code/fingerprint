# Upgrade v0.15.0 -> v0.15.1

This is a reporting-semantics correction only. No SQL or schema migration is required.

## Changes

- The System Health report no longer shows a completion percentage derived from all canonical punches. Historical test punches can predate automatic Finalization and historical automatic backfill is intentionally disabled, so that percentage can be misleading.
- Resolved `automatic_finalization_pending` rows are treated as internal durability lifecycle records, not user-facing operational problems. They are excluded from report issue counts and history. Open pending rows remain visible.
- Arabic/English copy was updated to explain the distinction.

No main-application files are changed. The existing theme and `mode=test` remain unchanged.
