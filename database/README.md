# biometric-service database boundary

The service uses the existing TiDB database `test`, but only through five tables with the `biometric_svc_` prefix.

The tables were created manually by the operator on 2026-08-30 and verified empty before runtime integration:

- `biometric_svc_devices`
- `biometric_svc_ingest_events`
- `biometric_svc_event_processing`
- `biometric_svc_punches`
- `biometric_svc_device_users`

The previous legacy tables (`biometric_devices`, `biometric_raw_events`, `biometric_worker_mappings`) were empty and were manually removed after dependency checks.

No file in this directory is executed automatically. `biometric-service` performs only read-only schema validation at startup and runtime DML against its own five tables.

No service-owned table contains `worker_id`, `attendance_event_id`, finance/payroll, shift, or QR links.
