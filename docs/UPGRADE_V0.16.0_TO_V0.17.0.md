# Upgrade v0.16.0 -> v0.17.0

`v0.17.0` adds controlled manual historical Final Event reprocessing inside the standalone `biometric-service` administration UI.

## Why

A biometric person can already have old Final Events before that person's `personCode` is linked to a worker in the workforce application. Linking the worker must **not** automatically backfill old attendance because that could alter historical attendance and finance without a human decision.

The approved behavior is:

1. New biometric events continue normally after the worker link.
2. Old biometric events remain in `biometric-service` unchanged.
3. If an administrator wants old events reconsidered, they open **People**, choose the person, select a date range, preview the count, explicitly confirm, and run **Historical Reprocessing**.
4. The service creates new immutable Final Event references for the selected original events. The originals are never edited or deleted.
5. The normal Final Events API cursor can then expose the new rows to the workforce application. The workforce application's existing duplicate/attendance rules decide whether each reissued event becomes a new attendance event.

## Safety boundaries

- No automatic historical backfill or background historical scan.
- No database schema change and no migration/SQL is required.
- No `.env` change.
- No main-application files are changed by this biometric-service update.
- The reference device remains `mode=test`.
- Reprocessing requires an active biometric person.
- Both start and end dates are required.
- One operation is limited to 31 calendar days and 1,000 original Final Events.
- Preview is read-only; the write requires the existing loopback local-UI write guard and an explicit confirmation checkbox.
- Prior replay rows (`finalization_version` beginning with `hr-`) are excluded from the candidate set, preventing replay-of-replay expansion.
- Each reissued Final Event receives a new UUID and replay-specific finalization version while preserving the original event facts/time.
- The replay batch writes its new Final Events and one safe audit record in the same database transaction.
- No raw device payload, password, card value, biometric template/image, `worker_id`, or workforce-app identity is stored.

## UI

In **People**, each active person now has **معالجة البصمات القديمة / Reprocess Historical Events**. The dialog shows the selected person, requires a bounded date range, previews the number of original Final Events, warns that new event references will be issued, and requires explicit confirmation before the action is enabled.

## Startup

Start normally:

```powershell
node --env-file=.env src/index.js
```

The startup output retains:

```text
automatic historical finalization backfill: disabled
```

and adds:

```text
manual historical Final Events reprocessing: available from local admin UI
```
