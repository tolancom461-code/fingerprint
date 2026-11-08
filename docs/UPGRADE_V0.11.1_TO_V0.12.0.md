# Upgrade v0.11.1 → v0.12.0

## Scope

This upgrade adds the standalone local administration experience only. It does not change the ten-table TiDB schema and does not integrate with the main workforce application.

## New behavior

- Local admin UI/API on `127.0.0.1:9096` by default.
- Arabic default language with full RTL layout.
- English switch with full LTR layout.
- Language preference persisted in the browser.
- Technical codes, serials, and timestamps remain LTR-isolated for readability in both layouts.
- Dashboard, People, users needing mapping, Review, Final Events, and device status screens.
- Safe same-code person suggestions.
- Mapping a device user retries only that user's open `unmapped_device_user` Finalization issues.
- Administrative writes are captured by the existing safe audit layer.

## Safety boundaries

- No database DDL or migration is executed by the service.
- No biometric templates/images, passwords, or card credential material are exposed or persisted by the UI.
- The admin host is loopback-only in this release; configuration fails closed if a non-loopback host is requested.
- Device ADMS remains on its independent listener/port.
- Historical Finalization backfill remains disabled.
- The real device must remain in `mode=test` until the standalone acceptance gates and later bridge approval are complete.
- No main-app bridge/API is included.

## Configuration

Defaults:

```text
BIOMETRIC_ADMIN_ENABLED=true
BIOMETRIC_ADMIN_HOST=127.0.0.1
BIOMETRIC_ADMIN_PORT=9096
```

After starting the service, open:

```text
http://127.0.0.1:9096
```

No SQL command is required for this upgrade.

## Verification

Automated release gate:

```text
npm test
npm run check:boundaries
```

Expected release result: 145/145 tests passing and 5/5 architecture-boundary tests passing.
