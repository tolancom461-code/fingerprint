# Upgrade v0.9.2 -> v0.9.3

No TiDB schema change is required.

## Why this patch exists

`service.ndjson` intentionally retained historical diagnostic records. After a restart, a simple `Get-Content ... -Tail` could therefore show device requests from an older run before any current-run request arrived. Those timestamps were correct UTC timestamps, but the mixed sessions were operationally confusing.

## What changed

- A new service start rotates any existing active `service.ndjson` before current-run diagnostics are written.
- The active `service.ndjson` therefore represents only the current service session.
- Historical diagnostics remain available through `service.ndjson.1`, `.2`, and so on within the existing retention limit.
- Every new diagnostic record includes:
  - `sessionId`
  - UTC `occurredAt`
  - local `occurredAtLocal`
  - `logTimezone`
- A `diagnostic_session_started` record is the first entry of every run.
- The default diagnostic display timezone is `Asia/Riyadh`.

This change affects diagnostics only. Device event persistence, ACK behavior, TiDB tables, deduplication, canonical punches, device policy, and per-device event timezone handling are unchanged.

## Optional environment setting

The default is already correct for the current deployment:

```text
BIOMETRIC_LOG_TIMEZONE=Asia/Riyadh
```

You do not need to add this line unless you want to make the setting explicit.

## Database

Do not run CREATE/ALTER/DROP for this upgrade. The same five `biometric_svc_*` tables are used unchanged.
