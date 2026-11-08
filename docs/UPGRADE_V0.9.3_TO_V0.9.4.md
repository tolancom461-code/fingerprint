# Upgrade v0.9.3 -> v0.9.4

No database schema change or DDL is required.

## Fixed

- `accept_events_from` is treated consistently as a UTC `DATETIME(6)` value.
- Device-local ATTLOG timestamps are converted to UTC using the device IANA timezone before cutoff comparison.
- Retry/startup replay no longer compares a device-local JSON timestamp directly with a UTC database cutoff.
- Pending/retry records that are safely captured but fall before the cutoff are retired as `not_applicable`.
- Invalid cutoff/timezone conversion fails canonical creation closed while preserving durable sanitized ingest.

This fixes the real-device integration case discovered on 2026-08-31 with an `Asia/Riyadh` ZKTeco terminal.
