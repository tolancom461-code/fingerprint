> **Historical status document.** Current runtime database state is documented in `biometric/15_DATABASE_RUNTIME_INTEGRATION_2026-08-30.md`.

# Phase 2 — ADMS Observer Status

## Status: completed for the current real-device baseline

The isolated observer has been validated against a real ZKTeco SpeedFace-V5L and now provides a proven protocol baseline.

## Implemented and verified

- vendor-qualified allow-list;
- multi-device-ready identity model (`vendor + serialNumber`);
- vendor adapter registry;
- ZKTeco `/iclock/*` handling;
- OPTIONS negotiation and sanitized capture;
- safe OPERLOG observation and ACK for known records;
- ATTLOG parsing and append-only local capture;
- raw Status/Verify/work-code/extra-field preservation;
- vendor/device-scoped deduplication;
- retry detection across repeated device submissions;
- configurable ATTLOG ACK mode;
- no TiDB integration;
- no current-application integration;
- privacy protections for template-like data.

## Automated tests

Current service package: **0.8.0**  
Latest local suite: **52 tests, 52 pass, 0 fail**. The proven real-device gates listed below were not repeated for v0.7.

Important tested behaviors include USER redaction, biometric metadata-only OPERLOG handling, unknown OPERLOG no-ACK, real HTTP sanitized OPERLOG ACK, ATTLOG observe isolation, and protection against accidental ACK of unsupported/template tables.

## Real-device gates passed

- network connectivity: passed;
- ADMS handshake: passed;
- OPTIONS: passed;
- OPERLOG: passed;
- first ATTLOG: passed;
- retry/deduplication: passed;
- ATTLOG ACK acceptance: passed;
- verification methods: fingerprint, face, palm, password, card — passed;
- punch states: check-in/out, break-out/in, overtime-in/out — passed.

## Next gate

Protocol discovery is no longer the blocker. v0.7 now has a local durable-ingest boundary plus canonical replay while TiDB remains disabled. Work remains restricted to `biometric-service/`; any service-owned database design is a separate next step requiring approval.
