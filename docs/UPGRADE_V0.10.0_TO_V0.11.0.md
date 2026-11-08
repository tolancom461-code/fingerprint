# Upgrade v0.10.0 -> v0.11.0

v0.11.0 adds the standalone biometric Finalization Engine foundation.

## What is new

- Deterministic/idempotent finalization from a canonical punch to `biometric_svc_final_events`.
- Identity resolution uses only biometric-service internal tables.
- Unresolvable punches create/update `biometric_svc_finalization_issues` instead of guessing.
- Successful finalization resolves prior open issues for that punch.
- Manual validation CLI: `node --env-file=.env src/cli/finalize-punch.js <punch_id>`.

## Safety decision

Automatic historical backfill is NOT enabled in this release. This prevents existing punches from being finalized in bulk before an explicit backfill policy is approved. The first real validation can target one known punch only.

## Database

No schema change is required. v0.11.0 uses the same 10 biometric-service tables already created and verified in TiDB.

## Main application boundary

No reads/writes to workers, attendance, QR, shifts, finance, or payroll are introduced.
