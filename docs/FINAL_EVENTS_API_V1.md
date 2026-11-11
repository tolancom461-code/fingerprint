# Final Events Read-only API — v1 Contract

Introduced in `biometric-service v0.13.0`.

This API belongs to the standalone biometric service. It does **not** connect to the workforce application and does not read or write any main-application table.

## Safety boundary

- Read-only: only `GET` is supported for Final Events.
- Only rows with `status = 'final'` are returned.
- No biometric templates/images, passwords, raw payloads, vendor metadata, internal `person_id`, source punch IDs, device IDs, device serials, or raw vendor values are exposed.
- The API is disabled by default in both runtimes.
- Event endpoints require an independent Bearer token.
- The token is never logged or returned by the API.

## Configuration

### Standalone local listener

The dedicated listener binds to loopback only.

```text
BIOMETRIC_FINAL_EVENTS_API_ENABLED=false
BIOMETRIC_FINAL_EVENTS_API_HOST=127.0.0.1
BIOMETRIC_FINAL_EVENTS_API_PORT=9097
BIOMETRIC_FINAL_EVENTS_API_TOKEN=
```

When enabled, `BIOMETRIC_FINAL_EVENTS_API_TOKEN` is required and must contain at least 32 characters.

### Cloud ingest listener

The `database-ingest` runtime can serve the same read-only contract on its existing HTTPS domain. Keep the API disabled until a consumer is ready. Enable it with both variables below on the biometric service.

```text
BIOMETRIC_INGEST_CONSUMER_API_ENABLED=true
BIOMETRIC_INGEST_CONSUMER_API_TOKEN=<43–128 base64url characters>
```

Use a randomly generated token distinct from all device credentials. Set `BIOMETRIC_SERVICE_API_URL` on the TolanHR backend to `https://<biometric-service-domain>/api/v1` and `BIOMETRIC_SERVICE_API_TOKEN` to the consumer token. The API returns already-finalized events. Its activation does not change which device movements become final events. Remove both cloud ingest variables and redeploy to disable the API.

## Endpoints

### Health

```text
GET /api/v1/health
```

Does not require the Bearer token and reveals no event/person data.

### Cursor page

```text
GET /api/v1/final-events?after_id=0&limit=100
Authorization: Bearer <independent service token>
```

Rules:

- `after_id` is an opaque monotonic cursor represented as a decimal string.
- Start with `after_id=0`.
- `limit` is between 1 and 500.
- Rows are read in ascending Final Event ID order.
- Resume with `page.nextAfterId`.
- Re-reading an old cursor is safe; consumers deduplicate with `eventId`.

Example response shape:

```json
{
  "apiVersion": "v1",
  "items": [
    {
      "eventId": "067f9067-d835-4865-b4e5-722cb2dc6f95",
      "personCode": "900003",
      "eventType": "check_in",
      "eventTimeUtc": "2026-09-02T10:47:52Z",
      "eventTimeLocal": "2026-09-02T13:47:52",
      "eventTimezone": "Asia/Riyadh",
      "verificationMethod": "fingerprint",
      "finalizationVersion": "v1"
    }
  ],
  "page": {
    "afterId": "0",
    "nextAfterId": "5",
    "limit": 100,
    "hasMore": false
  }
}
```

### Single Final Event

```text
GET /api/v1/final-events/{finalEventUuid}
Authorization: Bearer <independent service token>
```

## Stable v1 event fields

- `eventId`: stable Final Event UUID. Future consumers should use this as their source-event idempotency key.
- `personCode`: stable biometric-system person code; future bridge mapping belongs outside this service.
- `eventType`: vendor-neutral canonical movement such as `check_in` or `check_out`.
- `eventTimeUtc`: RFC3339-style UTC timestamp ending in `Z`.
- `eventTimeLocal`: device-local wall-clock timestamp without an offset.
- `eventTimezone`: IANA timezone that gives `eventTimeLocal` its meaning.
- `verificationMethod`: sanitized canonical method such as `fingerprint`.
- `finalizationVersion`: finalization policy version used to produce the event.

No main-app identifier such as `worker_id` is part of this contract.

## Read-only guarantee

Requests using `POST`, `PUT`, `PATCH`, or `DELETE` on `/api/v1/final-events...` receive HTTP `405` with `READ_ONLY_API`.

## Consumer replay gate

After enabling the API locally, run:

```text
npm run simulate:final-events-consumer
```

The simulator performs a read-only snapshot pass, then replays that snapshot from cursor `0` using an in-memory `eventId` uniqueness set. A successful replay reports:

```text
"idempotentReplay": true
```

The simulator never writes to TiDB or to the workforce application.
