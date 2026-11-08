# Biometric Service Architecture

## Status — 2026-09-07

`biometric-service/` remains an isolated application inside the repository, but it is now intentionally integrated with the Main App through a narrow **Final Events / Web Bridge boundary**.

Current service version: **v0.18.0**.

The real ZKTeco SpeedFace-V5L is proven with ADMS traffic, durable ingest, canonical punches, Final Events, outbound Web Bridge delivery, and Windows background-service operation.

The device remains `mode=test`.

## Current end-to-end path

```text
ZKTeco terminal
   ↓ local ADMS / 9095
biometric-service
   ↓ durable sanitized ingest
canonical punch
   ↓ finalization
Final Event
   ↓ outbound HTTPS Web Bridge
https://www.tolanhr.com / Railway
   ↓
Main App biometric ingest boundary
   ↓
biometric_final_event_imports
   ↓
attendance_events (for supported check_in/check_out)
   ↓
worker_daily_finance via existing attendance finance path
```

## Ownership boundaries

### biometric-service owns

```text
biometric_svc_ingest_events
biometric_svc_event_processing
biometric_svc_punches
biometric_svc_devices
biometric_svc_device_users
biometric_svc_people
biometric_svc_person_device_users
biometric_svc_final_events
biometric_svc_finalization_issues
biometric_svc_audit_log
```

### Main App owns

Workers, attendance, finance, application settings, audit, and biometric import tracking belong to the Main App/TiDB side.

`biometric-service` does **not** write directly into Main App DB tables. Integration happens through the versioned event boundary / Web Bridge.

## Database truth rule

Actual TiDB is the source of truth for database structure and data. Drizzle schema is not authoritative when verifying production DB facts.

No automatic DDL/migration is allowed as part of runtime startup.

## Multi-device / multi-vendor core

The common core remains vendor-neutral. Hardware-specific behavior lives in adapters.

```text
Terminal(s)
   ↓
Vendor adapter (parse + privacy gate + vendor dedupe identity)
   ↓
Sanitized observation
   ↓
Durable ingest store
   ↓
ACK eligibility boundary
   ↓
Canonical punch processing
   ↓
Finalization
   ↓
Final Event
```

Current adapter:

```text
src/infrastructure/vendors/zkteco/
```

Future vendors receive separate adapters; vendor-specific numeric meanings must not leak into the common core.

## Canonical device identity

```text
vendor + serialNumber
```

Reference device:

```text
zkteco:AJE1261900133
```

## ZKTeco protocol path

The SpeedFace-V5L uses:

- ADMS / PUSH protocol.
- local HTTP endpoint on 9095.
- OPTIONS negotiation/capability profile.
- polling through `/iclock/getrequest`.
- OPERLOG handling with privacy filtering.
- ATTLOG attendance transactions.

Port 4370 remains the traditional SDK port and is not the ADMS listener used by this service path.

## ATTLOG semantic model

Proven status mapping for the tested compatibility profile:

```text
0 check_in
1 check_out
2 break_out
3 break_in
4 overtime_in
5 overtime_out
```

Proven verification mapping:

```text
1  fingerprint
3  password
4  card
15 face
25 palm
```

These are adapter/device-profile facts, not universal assumptions for every ZKTeco terminal.

## Privacy boundary

The service may retain sanitized attendance transaction evidence but must not persist/expose:

- biometric templates.
- biometric images.
- passwords.
- card credential material.
- unsafe raw biometric payloads.

The Web Bridge sends only the sanitized Final Event contract required by the Main App.

## Local administration boundary

```text
ADMS listener:     0.0.0.0:9095
Admin UI:          127.0.0.1:9096
Final Events API:  127.0.0.1:9097/api/v1
Person Directory:  same 9097 loopback/auth boundary
```

9096/9097 are loopback-only in the current local setup. None of 9095/9096/9097 is exposed directly to the public internet.

## Final Events boundary

Final Events are the stable integration-ready contract. They exclude internal/raw/biometric-sensitive details.

Historical Final Event backfill is **not automatic**. Manual historical reprocessing remains explicit and bounded from the local Admin UI.

## Main App Web Bridge boundary — v0.18.0

Railway cannot reach the local loopback API, so the production direction is outbound push:

```text
local biometric-service -> outbound HTTPS -> Main App / Railway
```

Current target:

```text
https://www.tolanhr.com
```

A dedicated server-side bridge token is used; its value must never be logged or documented.

The bridge keeps a durable cursor in:

```text
var/web-bridge-state.json
```

The cursor advances only after successful acknowledgement of the complete batch.

This behavior was proven by a controlled target outage on 2026-09-07.

## Main App attendance semantics

`attendance_events` is the attendance source of truth.

Supported biometric attendance conversion currently covers `check_in` and `check_out`.

Other canonical event types such as `break_in` can still arrive and be tracked but currently do not become attendance check-in/check-out; for example, the verified post-reboot `break_in` produced `unsupported_event`.

Duplicate behavior is first-valid-event-wins inside the configured 3-minute duplicate window for the same worker + same event type.

## Windows runtime architecture

The final local Windows runtime is:

```text
Windows Service Control Manager
   ↓
WinSW 2.12.0
   ↓
node.exe
   ↓
biometric-service
```

Deployment path:

```text
C:\Tolan\BiometricService
```

Service:

```text
TolanBiometricService
```

Properties:

- Automatic / delayed auto start.
- background operation.
- service-only recovery after process failure.
- no configured Windows reboot action.
- old Task Scheduler task disabled after successful transition.

Detailed proof: `biometric/21_WINDOWS_SERVICE_WINSW_LOCAL_PC_2026-09-07.md`.

## Current gate

```text
Local PC phase       COMPLETE
Company server phase NOT STARTED
Device mode          test
```

The next architectural deployment step is reproducing the proven Windows Service pattern on the company local server, after verifying its Node/runtime/network/firewall prerequisites and connectivity to the ZKTeco device.
