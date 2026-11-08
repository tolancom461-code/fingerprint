# Upgrade v0.14.0 -> v0.15.0

`v0.15.0` completes the standalone administration reporting/filtering work **inside `biometric-service` only**. It intentionally avoids duplicating attendance, payroll, shift, cost-center, group, lateness, absence, or overtime reports that belong to the main workforce application.

## Added operational filters

Server-side filters and pagination are available for:

- Final Events: person/code search, period, event type, device, verification method.
- People: name/code search, active/inactive status, mapping status, device.
- Needs Mapping: name/code search and device.
- Review: name/code search, open/resolved status, issue type, device, period.
- Devices: name/model/serial search, status, mode, vendor.

Validated numeric `LIMIT`/`OFFSET` values remain SQL literals for the proven TiDB/mysql2 compatibility path; user filter values remain prepared-statement parameters.

## Final Event export and evidence

The Final Events screen can export the current filtered result set as UTF-8 CSV that opens cleanly in Excel. The export contains only safe operational fields and applies spreadsheet-formula injection protection to user/device text. The export is capped at 10,000 rows per file so operators are encouraged to narrow very large periods.

Each Final Event also has a details dialog containing the stable Final Event UUID, person code/name, event type, local/UTC time, timezone, device name/serial, verification method, finalization version, and Final status. Internal person IDs and source punch IDs are not exposed.

## Biometric-only reports

The new Reports tab contains four operational areas:

1. **System Health** — canonical deduplicated punches received, Final Events produced, completion rate, issues appearing in the period, currently open issues, and current unmapped users.
2. **Devices & Connectivity** — device status/mode, Final Events in the period, currently open issues, current unmapped users, and last-seen time.
3. **Mapping Readiness** — People, active People, Device Users, active mappings, unmapped Device Users, inactive mappings, People without active device mappings, and People mapped to multiple devices.
4. **Issues & Resolution** — issue totals for the selected period plus open/resolved status and recent safe issue history.

These are operational biometric reports. They do not calculate workforce attendance or financial meaning.

## Database

No schema change and no SQL mutation are required. All new functionality reads the existing ten biometric tables.

## Security / privacy

- Admin UI remains loopback-only.
- Final Events integration API remains separate and read-only.
- No biometric templates, images, passwords, raw card credentials, raw payloads, or main-app worker IDs are added.
- CSV exports contain safe Final Event fields only.

## Main application

No `server/`, `client/`, `shared/`, Drizzle, attendance, QR, shifts, finance, payroll, or worker code is changed. Bridge/integration remains a separately approved future phase.

## Device

Keep the physical device at `mode=test`.
