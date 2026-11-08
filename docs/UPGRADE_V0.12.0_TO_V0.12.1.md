# Upgrade v0.12.0 → v0.12.1

This is a small compatibility hotfix for the standalone local administration UI.

## Fixed

- TiDB/mysql2 could return `ER_WRONG_ARGUMENTS` when the v0.12.0 admin read layer used prepared-statement placeholders for `LIMIT`/`OFFSET`.
- v0.12.1 validates pagination values as bounded integers and embeds only those validated integers in the SQL text. Search text and identifiers remain parameterized.
- The same fix is applied to People and Device User list stores so the issue cannot reappear when those list paths are used.

## Unchanged

- No database migration.
- Same ten service-owned tables.
- Same Arabic/English UI and RTL/LTR behavior.
- Same local-only admin listener (`127.0.0.1:9096`).
- Same device-facing listener (`9095`).
- Automatic Finalization remains enabled for new canonical punches only.
- Historical backfill remains disabled.
- No main-application integration.
- Keep the device in `mode=test`.
