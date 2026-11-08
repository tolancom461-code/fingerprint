# Upgrade v0.13.1 -> v0.14.0

`v0.14.0` hardens automatic Finalization recovery without changing the database schema or enabling historical backfill.

## Problem closed

Before this release, a newly inserted canonical punch was finalized immediately. If that downstream Finalization call failed transiently after the canonical punch had already committed, the ATTLOG correctly remained acknowledged, but the same canonical punch was a duplicate on later durable-ingest replay and therefore was not automatically finalized again. Manual CLI retry could recover it, but automatic transient recovery was incomplete.

## New durable intent

When automatic Finalization is active, a newly inserted canonical punch now persists an `automatic_finalization_pending` issue **inside the same TiDB transaction as the canonical punch**. This uses the existing `biometric_svc_finalization_issues` table; no DDL is required.

- Successful Finalization resolves the pending intent together with other open issues.
- A deterministic unresolved result (for example unmapped identity) creates the specific review issue and resolves only the automatic pending intent.
- A transient Finalization exception leaves the pending intent open.
- A bounded periodic retry sweep reads only these durable pending intents after the configured retry delay and retries Finalization.
- Retry failures store only a sanitized error code in issue details and never raw SQL, credentials, biometric data, or raw payloads.

## No historical automatic backfill

Startup durable-ingest replay still runs **before** automatic Finalization is activated. Existing canonical punches are never scanned merely because they lack a Final Event. The retry sweep processes only `automatic_finalization_pending` intents created for new canonical punches while automatic Finalization is active.

## UI

The existing theme is unchanged. If a pending intent remains open long enough to be visible, Arabic and English review text explain that Finalization is pending and will be retried automatically.

## Configuration

No new environment variables are required. The existing values are reused:

- `BIOMETRIC_DB_RETRY_SWEEP_SECONDS`
- `BIOMETRIC_DB_RETRY_DELAY_SECONDS`
- `BIOMETRIC_AUTO_FINALIZE_NEW_PUNCHES`

## Database

No schema change and no SQL mutation are required.

## Main application

No main-application code, tables, attendance logic, QR, shifts, finance, or payroll integration is touched. The device remains `mode=test`.
