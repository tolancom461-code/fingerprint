# Upgrade v0.6 → v0.7 — Durable Ingest Boundary

## Scope

This upgrade changes only `biometric-service/`. It does not integrate with the existing workforce application and does not execute or require any TiDB migration.

## What changed

ATTLOG is now handled in two local persistence layers:

1. `var/captures/ingest.ndjson` — sanitized durable source event.
2. `var/captures/attlog.ndjson` — canonical punch record.

The existing `attlog.ndjson` filename is intentionally retained so prior real-device captures are not rewritten or migrated.

## ACK rule

For ATTLOG in `ack` mode:

- unauthorized device → no ACK;
- durable ingest write failure → no ACK;
- unknown/unsafe ATTLOG shape → no success ACK;
- safe event durably inserted → ACK eligible;
- safe durable duplicate → ACK eligible;
- canonical punch processing failure after durable ingest → source remains recoverable and ACK eligibility is preserved.

## Recovery

On service startup, durable ingest records that contain a safe canonical payload are replayed into the canonical punch store using idempotent event keys. Existing canonical records remain duplicates and are not rewritten.

## Privacy change

New v0.7 ATTLOG records do not persist the raw ATTLOG line or raw field array. The durable record stores only:

- device identity;
- vendor-specific dedupe identity/version;
- wire hash;
- byte/field counts;
- safe parsed attendance fields;
- conservatively classified extra numeric fields;
- timestamps and safe diagnostic metadata.

Unknown record content is not stored raw. Fingerprint, face, palm, vein, image or credential templates remain prohibited.

## Architecture

Vendor-specific parsing, sanitization and event identity remain in the vendor adapter. The application/domain core remains vendor-neutral.
