# Historical source README

Archived from finger/biometric-service/README.md on 2026-11-08. This describes the original in-repository service and historical phases; use ../README.md for the standalone extraction status. Some historical relative paths refer to the original location.

# biometric-service

Independent **multi-device, multi-vendor** biometric service.

It remains fully isolated from the existing workforce application: it does not import the main `server/`, `client/`, `shared/`, or Drizzle ORM code, and it never writes to `workers`, `attendance_events`, finance/payroll, shifts, or QR tables.


## v0.18.0 standalone administration + controlled historical replay + outbound web bridge

The service now includes a deliberately simple **local standalone administration UI** on a separate loopback-only listener. Arabic is the default language and English is available from a persistent language switch. Changing language changes both text and page direction (`RTL`/`LTR`), while technical codes and timestamps remain isolated left-to-right for readability.

The UI focuses on operational tasks instead of internal IDs: dashboard, users needing identity mapping, review items, Final Events, People, device status, and biometric-only operational reports. `v0.15.0` adds server-side filters and pagination to the operational lists, Excel-compatible filtered Final Event export, a safe Final Event evidence dialog, and four report areas: system health, device activity, mapping readiness, and issue/resolution history. These reports deliberately do **not** calculate attendance hours, absence, lateness, overtime entitlement, payroll, groups, cost centers, or shifts; those remain the responsibility of the main workforce application after a separately approved integration phase. Safe same-code mappings are suggested, and mapping an unresolved device user immediately retries only that user's open `unmapped_device_user` events. Internal `person_id`, source punch IDs, raw payload details, and biometric material are not presented to ordinary UI users.

The administration listener defaults to `127.0.0.1:9096` and this release refuses non-loopback admin hosts. Device ADMS remains independently reachable on port `9095`. This local restriction is a safety boundary, not remote-user authentication; remote administration is intentionally deferred to a later approved design.

Automatic Finalization v1 now persists a durable pending intent atomically with each newly inserted canonical punch. If downstream Finalization fails transiently, a bounded retry sweep re-attempts only that durable pending intent. Deterministic unresolved cases become safe review issues, and historical automatic backfill remains disabled. The service remains standalone; the workforce application integrates only through the approved loopback read-only APIs. The reference device remains in `mode=test`.

## Current version

`0.18.0`

The production/default database contract now uses these ten service-owned tables inside the existing `test` database:

- `biometric_svc_devices`
- `biometric_svc_ingest_events`
- `biometric_svc_event_processing`
- `biometric_svc_punches`
- `biometric_svc_device_users`
- `biometric_svc_people`
- `biometric_svc_person_device_users`
- `biometric_svc_final_events`
- `biometric_svc_finalization_issues`
- `biometric_svc_audit_log`

The service **never creates, alters, or drops database objects automatically**. Startup performs read-only validation of the selected database, required columns, `utf8mb4_bin` collation, and critical unique indexes. Any schema change must be executed manually by the operator first.

`v0.18.0` adds an optional outbound-only web bridge for Final Events. When explicitly enabled, the local service pushes only the existing safe Final Event contract to the main web application over HTTPS. It keeps a durable local delivery cursor, retries without advancing the cursor when the target is unavailable, and initializes at the current tail on first enable so historical data is not backfilled automatically. The local admin UI and read-only API remain loopback-only.

## Core flow

```text
Terminal
  -> vendor adapter
  -> privacy/safety gate
  -> durable sanitized ingest in TiDB
  -> COMMIT
  -> ATTLOG ACK eligibility
  -> canonical punch processing
  -> device-user observation
  -> durable automatic-finalization intent (same canonical transaction)
  -> automatic Finalization v1 for newly inserted canonical punches
     -> Final Event OR safe Finalization Issue
     -> transient failure stays pending for bounded automatic retry
```

If durable ingest fails, ACK is not eligible. If canonical processing fails after the ingest commit, the durable source remains and the processing row is marked for retry. If Finalization fails after a new canonical punch commits, its durable pending intent remains open and a separate non-overlapping sweep retries Finalization after the configured delay. Neither retry path performs historical Final Event backfill.

## Identity and deduplication

Device identity is always:

```text
vendor + serialNumber
```

Durable event identity is qualified by vendor, serial number, vendor dedupe strategy, version, and vendor event key. The database also enforces the critical unique constraints needed for idempotency.

## Privacy boundary

The service never stores biometric templates or credential material. Fingerprint, face, palm, vein, BIODATA, image/template content, passwords, and card credentials are discarded/redacted before persistence.

`safe_payload`, `safe_capabilities`, and `safe_metadata` contain sanitized values only.

## Device runtime policy

Database devices are accepted only when `status=active` and `mode` is either `test` or `live`. Unknown modes fail closed before ATTLOG bodies are processed.

`accept_events_from` is an optional UTC cutoff stored as TiDB `DATETIME(6)`. Device-local ATTLOG timestamps are converted through the device IANA timezone before comparison. A safe event older than the cutoff is still sanitized and durably recorded so it can be acknowledged and drained from the terminal, but it is marked `not_applicable` and is not converted into a canonical punch.

The device `timezone` is copied into canonical punches. When the local device timestamp and IANA timezone can be converted safely, `device_event_time_utc` is also populated. Invalid zones or nonexistent DST local times are never guessed.

## Database configuration

The service intentionally does not reuse the main application's environment file. Configure it independently.

```bash
BIOMETRIC_STORAGE_MODE=database
BIOMETRIC_DB_HOST=...
BIOMETRIC_DB_PORT=4000
BIOMETRIC_DB_USER=...
BIOMETRIC_DB_PASSWORD=...
BIOMETRIC_DB_NAME=test
BIOMETRIC_DB_SSL_MODE=required
BIOMETRIC_DB_RETRY_DELAY_SECONDS=30
BIOMETRIC_DB_RETRY_SWEEP_SECONDS=10
BIOMETRIC_AUTO_FINALIZE_NEW_PUNCHES=true
BIOMETRIC_ADMIN_ENABLED=true
BIOMETRIC_ADMIN_HOST=127.0.0.1
BIOMETRIC_ADMIN_PORT=9096
BIOMETRIC_FINAL_EVENTS_API_ENABLED=false
BIOMETRIC_FINAL_EVENTS_API_HOST=127.0.0.1
BIOMETRIC_FINAL_EVENTS_API_PORT=9097
BIOMETRIC_FINAL_EVENTS_API_TOKEN=
```

Install dependencies after extracting/upgrading:

```bash
npm install
```

`mysql2` is pinned to `3.24.2`. The release archive does not contain a fabricated lockfile: this build environment had no registry/cache access. The first real `npm install` generates the authoritative `package-lock.json`; keep that generated file with the deployed copy.

Then start:

```bash
BIOMETRIC_ALLOWED_DEVICES=zkteco:AJE1261900133 npm start
```

When database mode is running with the default local administration settings, open:

```text
http://127.0.0.1:9096
```

The UI starts in Arabic. Use the `English` / `العربية` button to switch language; the preference is kept in the browser.

For the first database-backed real-device verification, keep:

```text
BIOMETRIC_ATTLOG_ACK_MODE=observe
```

Only switch to `ack` after database persistence has been verified with the real terminal.

## File mode

The earlier file-backed implementation remains available only as an explicit lab/backward-compatibility mode:

```text
BIOMETRIC_STORAGE_MODE=file
```

Database mode is the default. There is no automatic fallback from database failure to file storage.

Historical files under `var/captures/` are preserved and are not automatically imported into TiDB.

## Diagnostic log rotation

`var/logs/service.ndjson` is bounded by rotation instead of growing forever. Defaults:

```text
BIOMETRIC_LOG_MAX_BYTES=10485760
BIOMETRIC_LOG_RETAIN_FILES=5
BIOMETRIC_LOG_TIMEZONE=Asia/Riyadh
```

Each service start begins a new diagnostic session. If `service.ndjson` already contains a prior session, it is rotated to `service.ndjson.1` before the new session starts, so the active file contains only the current run. Older files continue as `.2`, `.3`, and so on within the configured retention limit.

Every new diagnostic record includes a unique `sessionId`, canonical UTC `occurredAt`, local `occurredAtLocal`, and `logTimezone`. The default local diagnostic timezone is `Asia/Riyadh`; this affects diagnostic readability only and does not replace the per-device timezone used for punch normalization.

Writes are serialized so concurrent requests cannot race either startup or size rotation.

## Multi-vendor rule

Vendor-specific parsing and protocol behavior stays under:

```text
src/infrastructure/vendors/<vendor>/
```

The application/domain core remains vendor-neutral.

## Tests

v0.14.0 retains the focused contract, authentication, cursor-pagination, privacy-boundary, and replay tests for the read-only Final Events API and adds durable automatic-Finalization intent/retry coverage. Run `npm test` for the full suite or the focused API tests during upgrade validation.

```bash
npm test
```

The test suite covers application isolation, multi-device identity, privacy redaction, ACK safety, durable ingest, runtime retry recovery, replay/idempotency, device policy, timezone conversion, bounded/session-scoped diagnostic logging, the ten-table database schema contract, TiDB storage behavior, People creation, person-code suggestion, Device User mapping conflict protection, safe administrative audit, local admin API boundaries, Arabic/English switching, RTL/LTR alignment rules, and vendor-neutral architecture.

Real-device database verification completed on the tested SpeedFace-V5L: TiDB durable ingest, canonical punch creation, deduplication, ACK stop-retry behavior, device/user registry updates, and normalized `check_in`, `break_out`, and `overtime_in` fingerprint punches were observed successfully.

See `docs/ARCHITECTURE.md`, `docs/OPERLOG_POLICY.md`, and `docs/biometric/15_DATABASE_RUNTIME_INTEGRATION_2026-08-30.md`.


## Stage closure

The standalone biometric-service stage was formally closed on 2026-08-31 after real-device and real-TiDB validation. The tested terminal remains intentionally at `mode=test`; do not switch it to `live` until a separately approved main-application integration phase begins. See `docs/biometric/19_FINAL_CLOSURE_REPORT_2026-08-31.md`.


## v0.11.x Finalization

`v0.11.0` introduced explicit one-punch Finalization v1. `v0.11.1` adds automatic Finalization for newly inserted canonical punches in database mode while preserving the no-historical-backfill gate. The manual CLI remains available for controlled reprocessing and issue-resolution tests.


## v0.12.x Administration

`v0.12.0` added the standalone local UI and its read/write application layer without adding database tables or running migrations. `v0.12.1` is a compatibility hotfix for TiDB/mysql2 prepared pagination: validated numeric LIMIT/OFFSET values are emitted as safe SQL literals instead of prepared-statement placeholders. The UI and database schema are unchanged. The UI remains intentionally separated from the device-facing ADMS listener and local-only.


## v0.12.2 mapping re-finalization hotfix

`v0.12.2` fixes the local administration workflow after a device user is mapped. The admin service now calls the real FinalizationService public method (`finalizePunchById`) when retrying that user's open `unmapped_device_user` punches. This allows the existing Final Event/idempotency path to run and resolve the open issue. No database migration, UI theme change, historical automatic backfill, or main-application integration is introduced.


## v0.13.0 read-only Final Events API

`v0.13.0` adds a versioned integration contract **inside biometric-service only**. It is disabled by default, loopback-only in this release, and requires an independent Bearer token when enabled. It reads only rows already finalized by the standalone Finalization engine and exposes no internal person IDs, source punch IDs, device/vendor details, raw payloads, or biometric material. No main application code is changed or connected.

Endpoints: `GET /api/v1/health`, `GET /api/v1/final-events?after_id=...&limit=...`, `GET /api/v1/final-events/{finalEventUuid}`, and from v0.16.0 `GET /api/v1/person-directory?search=...&status=active&after_code=...&limit=...`. All protected integration mutation methods are rejected. Cursor replay is designed to be safe with consumer deduplication by `eventId`. See `docs/FINAL_EVENTS_API_V1.md`.


## v0.13.1 consumer simulator hotfix

`v0.13.1` fixes the packaged `npm run simulate:final-events-consumer` command so it loads the standalone service `.env` file before starting the read-only replay simulator. This is an operational CLI-only hotfix: no database schema, device listener, admin UI/theme, Final Events API contract, finalization behavior, or main-application integration changes are introduced.


## v0.14.0 durable automatic Finalization retry

`v0.14.0` closes the transient-failure gap after canonical punch durability. New canonical punches created while automatic Finalization is active carry a durable `automatic_finalization_pending` intent in the existing Finalization Issues table. A bounded retry sweep retries only those intents; existing historical canonical punches are not scanned or backfilled. No database schema change, UI theme change, or main-application integration is introduced. See `docs/UPGRADE_V0.13.1_TO_V0.14.0.md`.





## v0.17.1 historical reprocessing success feedback

`v0.17.1` is a UI-only patch for the manual historical Final Event reprocessing dialog. After a successful reprocess, the dialog now stays open and shows the success result inside the same dialog (for example, that one historical event was reissued), while the existing global notice remains as a secondary confirmation. This release does not change historical replay logic, Final Event contents, database schema, `.env`, device mode, automatic-backfill policy, or main-application integration behavior.

## v0.17.0 controlled historical reprocessing

`v0.17.0` adds explicit **manual** historical Final Event reprocessing from the standalone People screen. This is for the case where a biometric person is linked to a worker in the workforce application after older biometric events already existed. Nothing is backfilled automatically when a worker is linked. The administrator selects the biometric person and a bounded date range, previews the count, confirms the action, and only then reissues those historical Final Events with new immutable event references. The original Final Events are never edited or deleted.

The reissued rows keep the original person code, event type, device event time, timezone, verification method, source punch and device reference. They use a replay-specific finalization version beginning with `hr-`, and safe metadata records the replay batch/original Final Event reference. Because the rows are new Final Events with newer database IDs, an already-running cursor consumer can receive them normally. Consumer-side attendance deduplication remains the consumer's responsibility. Each operation is limited to 31 calendar days and 1,000 original events, requires an active biometric person, and writes one safe audit record. No database schema change, SQL migration, `.env` change, main-application file change, or automatic historical scan is introduced. See `docs/UPGRADE_V0.16.0_TO_V0.17.0.md`.

## v0.16.0 safe Person Directory integration surface

`v0.16.0` extends the existing loopback-only, Bearer-protected read-only integration listener with `GET /api/v1/person-directory`. The endpoint supports the approved worker-linking UI and exposes exactly `personCode`, `displayName`, and `status`, with search and person-code cursor pagination. It does not expose internal biometric IDs, device-user identities, device details, notes, raw payloads, biometric material, or `worker_id`. The endpoint is read-only and no database schema change or SQL mutation is required. No main-application files are changed in this release. See `docs/PERSON_DIRECTORY_API_V1.md` and `docs/UPGRADE_V0.15.1_TO_V0.16.0.md`.

## v0.15.1 reporting semantics correction

`v0.15.1` keeps the v0.15.0 reporting UI and theme but corrects two user-facing semantics discovered against real TiDB test data. The System Health report no longer calculates a completion percentage from all historical canonical punches, because historical automatic Finalization backfill is intentionally disabled and older test punches can legitimately lack Final Events. Also, resolved `automatic_finalization_pending` rows are treated as internal durability lifecycle records rather than operational problems; open pending rows remain visible. No database schema change, SQL mutation, or main-application change is required.

## v0.15.0 biometric operational reports and filters

`v0.15.0` extends only the standalone `biometric-service` administration surface. It adds server-side filtering and pagination for Final Events, People, Needs Mapping, Review, and Devices; a filtered Excel-compatible CSV export for Final Events; safe per-event evidence details using the Final Event UUID as the reference; and four biometric-only operational reports: system health, devices/connectivity, mapping readiness, and issue/resolution history. The existing visual theme is retained, Arabic remains the default RTL language, English remains LTR, and technical codes/timestamps stay isolated for readability. No main-application files are changed, no database schema change is required, and no SQL mutation is required.
