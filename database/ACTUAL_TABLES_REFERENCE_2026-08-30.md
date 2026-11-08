# Actual biometric-service table set — 2026-08-30

Database: `test`

Runtime-owned tables:

1. `biometric_svc_devices`
2. `biometric_svc_ingest_events`
3. `biometric_svc_event_processing`
4. `biometric_svc_punches`
5. `biometric_svc_device_users`

All five were created manually by the operator and verified empty before v0.9 runtime integration.

The runtime does not run DDL. Any future database change must be supplied as SQL for manual execution, verified against TiDB, and only then reflected in schema/code.
