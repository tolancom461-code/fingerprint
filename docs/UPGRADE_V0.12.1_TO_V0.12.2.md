# Upgrade v0.12.1 → v0.12.2

Date: 2026-09-02

## Reason

A real standalone-UI test mapped device user `900003` successfully, but the existing `unmapped_device_user` review issue remained open. The review row already showed the mapped person, proving that identity mapping succeeded while the targeted retry did not run.

## Root cause

`StandaloneAdminService` called `finalizationService.finalizePunch(...)` while the real `FinalizationService` public method is `finalizePunchById(...)`. The per-punch retry loop intentionally contains failures so the mapping write itself is not rolled back, which made the mismatch appear as a successful mapping plus a still-open review issue. Unit tests had mocked the same incorrect method name and therefore did not detect the runtime mismatch.

## Fix

- Call `FinalizationService.finalizePunchById(...)` from the post-mapping retry path.
- Update the focused administration-service tests to mock the real public method name, making this mismatch a regression failure.

## Database / UI / integration impact

- No SQL or database migration.
- No schema change.
- No UI theme or layout change.
- No automatic historical backfill.
- Device stays `mode=test`.
- No main-application integration or changes.

## Verification target

After restarting v0.12.2, re-trigger the existing mapping workflow for the already-mapped `900003` state through a safe targeted retry path. The expected result for source punch `60003` is a Final Event and automatic resolution of the open `unmapped_device_user` issue.
