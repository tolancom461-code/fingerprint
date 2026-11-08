# Upgrade v0.5 -> v0.6

> **Historical status:** This upgrade has already been applied. Current standalone service baseline is v0.8.0; do not treat this file as the current execution plan.

This upgrade changes only the isolated `biometric-service`.

## What changes
- Adds safe `OPERLOG` observation for ZKTeco.
- Recognized and sanitized `OPERLOG` batches receive HTTP 200 `OK`.
- `USER` metadata is retained only in sanitized form.
- Password/card-like values are redacted.
- Fingerprint/face/palm/template payload values are discarded; only non-biometric metadata is retained.
- Unknown `OPERLOG` record types are not acknowledged and are not persisted raw.
- `ATTLOG` remains independent and defaults to observe/no-ACK.
- `BIOMETRIC_ATTLOG_ACK_MODE=ack` no longer causes unsupported/template tables to be acknowledged implicitly.

## Files removed
None.

## Database changes
None.

## Existing application changes
None.
