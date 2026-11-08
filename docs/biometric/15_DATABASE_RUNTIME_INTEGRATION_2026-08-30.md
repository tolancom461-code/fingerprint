# Database runtime integration — 2026-08-30

## State

`biometric-service` v0.9.2 is database-capable and real-device verified while remaining independent from the workforce application.

The operator manually removed the three empty legacy biometric tables and manually created/verified five new service-owned tables in the existing `test` database:

- `biometric_svc_devices`
- `biometric_svc_ingest_events`
- `biometric_svc_event_processing`
- `biometric_svc_punches`
- `biometric_svc_device_users`

## Runtime contract

- No automatic CREATE/ALTER/DROP.
- Startup schema checks are read-only and fail closed.
- ATTLOG ACK eligibility starts only after sanitized ingest has committed.
- Canonical processing is idempotent and retryable after durable capture.
- Database mode has no silent fallback to file persistence.
- File mode remains explicit lab compatibility only.
- No `worker_id`, attendance, finance, payroll, shifts, or QR integration exists.
- No biometric templates or credentials are persisted.

## Hardware gate result

Completed successfully. Database mode was first run with ATTLOG ACK=`observe`; durable rows were verified, duplicate terminal retries were suppressed, then ACK was changed to `ack`. The terminal stopped retrying the acknowledged event and delivered the next event. Canonical punches, processing state, device registry and device-user registry were verified in TiDB.

v0.9.2 adds a runtime retry sweep so canonical failures after durable ACK can recover without requiring process restart.
