# OPERLOG Observation Policy — v0.6

## Purpose

Allow the real ZKTeco terminal to complete ADMS operation-log uploads without persisting biometric templates or credentials.

## Rules

- Parsing exists only inside the ZKTeco adapter.
- Safe `USER` metadata may retain PIN/name/privilege/group/verification metadata if such records are actually observed.
- Passwords, card numbers and credential-like values are redacted.
- `FP`, `FACE`, `PALM`, `VEIN`, `BIODATA`, `BIOPHOTO` and `USERPIC` may retain non-sensitive metadata only; template/image values are discarded.
- No raw hash of a body that may contain biometric template material is stored as evidence.
- Unknown record shapes are not persisted raw and are not acknowledged as successfully processed.
- A fully recognized and sanitized batch is acknowledged with HTTP 200 `OK`.
- ATTLOG ACK remains independent.

## Real-device result

On 2026-08-29 the SpeedFace-V5L sent a 1430-byte OPERLOG batch. v0.6 parsed **36/36** records as `OPLOG` administrator operations, `unrecognizedCount=0`, and marked the sanitized batch safe to acknowledge. After ACK, the terminal progressed to normal `/iclock/getrequest` polling.

Later enrollment/menu actions generated additional small OPLOG records. No biometric template value was persisted by the observer.

## Boundary

OPERLOG observation does not create device-user synchronization automatically and does not write TiDB.
