# Upgrade v0.11.0 -> v0.11.1

## Purpose

Enable automatic Finalization v1 for newly inserted canonical punches while keeping historical backfill disabled.

## Database changes

None. v0.11.1 uses the same ten `biometric_svc_*` tables already verified by v0.11.0. The service still never creates, alters, or drops schema objects automatically.

## Runtime behavior

In database mode, `BIOMETRIC_AUTO_FINALIZE_NEW_PUNCHES` defaults to `true`.

After startup schema validation and startup durable-ingest replay complete, the canonical punch store is wrapped with automatic finalization. Therefore:

- a newly inserted canonical punch is finalized immediately;
- a mapped active person creates one idempotent Final Event (`finalization_version = v1`);
- an unresolved identity, state, or time creates/updates a safe Finalization Issue;
- duplicate canonical punches are not automatically re-finalized;
- Finalization failure is logged and does not invalidate the already durable canonical punch or ATTLOG acknowledgement eligibility;
- existing historical `biometric_svc_punches` are never scanned or backfilled automatically;
- startup replay is intentionally completed before automatic finalization is activated.

The runtime durable-ingest retry loop continues after activation. If a new durable ingest event cannot become canonical immediately and later succeeds through the runtime retry loop, the newly inserted canonical punch is then finalized.

## Optional kill switch

To disable automatic Finalization while retaining manual CLI finalization:

```text
BIOMETRIC_AUTO_FINALIZE_NEW_PUNCHES=false
```

The existing `.env` does not need a new line for the approved default behavior; database mode defaults to enabled.

## Manual CLI remains available

```powershell
node --env-file=.env src/cli/finalize-punch.js <punch_id>
```

Use it only for controlled testing or explicit reprocessing. It does not imply a historical sweep.

## Safety boundaries

- Device stays in `mode=test`.
- No worker ID or main-application table is referenced.
- No biometric template, face image, palm data, password, card credential, or unsafe raw payload is stored.
- Main-application bridge remains out of scope.
