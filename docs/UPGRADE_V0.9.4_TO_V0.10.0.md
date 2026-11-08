# Upgrade v0.9.4 -> v0.10.0

## Scope

This release starts the standalone management foundations while preserving the closed v0.9.4 ingest/canonical baseline.

## Database contract

TiDB is the source of truth. Before running v0.10.0, the following five additional tables must already exist and have been manually verified:

- `biometric_svc_people`
- `biometric_svc_person_device_users`
- `biometric_svc_final_events`
- `biometric_svc_finalization_issues`
- `biometric_svc_audit_log`

Together with the original five tables, startup now validates ten service-owned biometric tables. The service performs no runtime DDL.

## Added backend foundations

- People store with unique `person_code`.
- Device User Mapping store.
- Unmapped Device User query.
- Suggested onboarding: `person_code = device_user_id` when unambiguous.
- Mapping conflict protection.
- Safe administrative audit store.
- Vendor-neutral application service for People + Mapping workflows.

## Deliberately not included yet

- No administrative HTTP API.
- No standalone UI yet.
- No finalization engine yet.
- No Final Events consumer API yet.
- No main-application bridge.
- No `worker_id` in biometric tables.
- Device remains `mode=test`.

## Verification

Run:

```bash
npm install
npm test
npm run check:boundaries
```

Expected automated suite for this release: 110/110 passing.
