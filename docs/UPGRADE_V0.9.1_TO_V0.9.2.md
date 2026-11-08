# Upgrade v0.9.1 -> v0.9.2

No TiDB schema change is required.

## What changed

- Runtime retry sweep reprocesses due `pending`/`retry` durable ingests while the service stays running.
- Retry metadata is now upserted safely even if the processing row was unexpectedly absent.
- Device `timezone` now flows into canonical punches and `device_event_time_utc` is derived safely from IANA time zones.
- Database device policy is active: `status=active` plus `mode=test|live` is required.
- `accept_events_from` now prevents older durably-captured events from becoming canonical punches while still allowing safe ACK/drain behavior.
- `service.ndjson` now rotates by size with bounded retained files and serialized writes.
- The duplicate legacy `src/infrastructure/zkteco/` path was removed; vendor code has one canonical location under `src/infrastructure/vendors/zkteco/`.
- `mysql2` is pinned to exact version `3.24.2`.
- Documentation now records the successful real-device TiDB/ACK test.

## Environment additions

Optional; defaults are already safe:

```text
BIOMETRIC_DB_RETRY_SWEEP_SECONDS=10
BIOMETRIC_LOG_MAX_BYTES=10485760
BIOMETRIC_LOG_RETAIN_FILES=5
```

Keep the existing `BIOMETRIC_DB_RETRY_DELAY_SECONDS=30` unless there is an operational reason to change it.

## Dependency lock note

This release was built in an environment without npm registry or mysql2 cache access, so a fake/incomplete `package-lock.json` was deliberately not created. Run `npm install` once on the deployment machine; npm will generate the real lockfile from the exact `mysql2=3.24.2` dependency. Keep that generated `package-lock.json` with the deployment thereafter.

## Database

Do not run CREATE/ALTER/DROP for this upgrade. The same five `biometric_svc_*` tables are used unchanged.
