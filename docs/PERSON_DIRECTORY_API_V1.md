# Person Directory Read-only API — v1 Contract

Introduced in `biometric-service v0.16.0` to support the separately approved worker-to-biometric-person linking workflow.

This endpoint remains owned by the standalone biometric service. It does not read or write any workforce-application table and it does not accept a main-application `worker_id`.

## Purpose

The main workforce application can present a simple **Link with biometric system** picker without querying biometric tables directly or asking an administrator to type a biometric person code manually.

The endpoint exposes only the minimum safe directory fields:

- `personCode`
- `displayName`
- `status`

It never exposes internal biometric `person_id`, device-user row IDs, device details, notes, audit data, raw payloads, passwords, biometric templates/images, or a main-application identifier.

## Listener and authentication

The Person Directory uses the same loopback-only listener and independent Bearer credential as the Final Events API:

```text
BIOMETRIC_FINAL_EVENTS_API_ENABLED=true
BIOMETRIC_FINAL_EVENTS_API_HOST=127.0.0.1
BIOMETRIC_FINAL_EVENTS_API_PORT=9097
BIOMETRIC_FINAL_EVENTS_API_TOKEN=<independent strong token>
```

In this release the listener remains loopback-only. Remote/LAN exposure is not enabled by this change.

## Endpoint

```text
GET /api/v1/person-directory?search=&status=active&after_code=&limit=100
Authorization: Bearer <independent service token>
```

Query parameters:

- `search`: optional case/collation-aware database search over `person_code` and `display_name`, maximum 120 characters.
- `status`: `active` (default), `inactive`, or `all`.
- `after_code`: optional stable person-code cursor for the next page.
- `limit`: 1 to 500, default 100.

Example response:

```json
{
  "apiVersion": "v1",
  "items": [
    {
      "personCode": "900003",
      "displayName": "Test Person 900003",
      "status": "active"
    }
  ],
  "page": {
    "afterCode": "",
    "nextAfterCode": "900003",
    "limit": 100,
    "hasMore": false
  }
}
```

## Read-only guarantee

`POST`, `PUT`, `PATCH`, and `DELETE` to `/api/v1/person-directory` are rejected with HTTP `405` and `READ_ONLY_API`.

The eventual worker linkage belongs in the workforce application. `biometric-service` only provides this safe directory and Final Events; it never stores `worker_id`.
