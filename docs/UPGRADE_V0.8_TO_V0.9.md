# Upgrade v0.8 -> v0.9

## What changes

- TiDB becomes the default durable backend.
- `mysql2` is the only SQL client dependency.
- No dependency on the main application's ORM or server code is introduced.
- Startup validates the five `biometric_svc_*` tables read-only and fails closed on schema mismatch.
- Device metadata from sanitized OPTIONS is stored in `biometric_svc_devices`.
- Sanitized ATTLOG ingress is committed to `biometric_svc_ingest_events` before ACK eligibility.
- Canonical punches are stored in `biometric_svc_punches`.
- Processing state/retry metadata is stored in `biometric_svc_event_processing`.
- Safe device-user metadata is stored in `biometric_svc_device_users`.

## Important

There is no automatic DDL and no automatic import of historical `var/captures/*.ndjson` files.

After upgrade run `npm install` to install the database client, configure the dedicated `BIOMETRIC_DB_*` variables, and start the first real-device database test with `BIOMETRIC_ATTLOG_ACK_MODE=observe`.
