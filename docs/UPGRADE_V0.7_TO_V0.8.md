# Upgrade v0.7 → v0.8

## Scope

v0.8 remains fully standalone and database-disabled. No TiDB migration is executed.

## Main change

v0.7 relied on the vendor-provided `dedupeKey` as the in-memory/file lookup key. The current ZKTeco strategy already included vendor and serial in that hash, but that was not a guaranteed contract for future vendors.

v0.8 introduces a vendor-neutral global storage identity derived from:

```text
vendor + serialNumber + dedupeStrategy + dedupeVersion + dedupeKey
```

The resulting `ingestKey` is a SHA-256 identifier owned by the core storage boundary. This prevents a future vendor or second device from colliding merely because it emits the same local dedupe key.

## Backward compatibility

Historical v0.7 ingest records are normalized in memory without rewriting their append-only file. Historical canonical `attlog.ndjson` records are recognized through a device-scoped legacy event key so startup replay does not append the same physical punch again after upgrade.

The previously captured real-device `attlog.ndjson` is not migrated or rewritten.

## Database preparation

`database/PROPOSED_SCHEMA_V1_NOT_APPLIED.sql` documents the future standalone storage shape. It is not connected to runtime and must not be executed without separate approval.

## Canonical identity semantics

Canonical punches now distinguish the core-owned global `eventKey` from `vendorDedupeKey/vendorDedupeStrategy/vendorDedupeVersion`. This avoids implying that a globally qualified storage key is itself a vendor key.
