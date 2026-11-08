# Upgrade v0.15.1 -> v0.16.0

`v0.16.0` adds a safe read-only Person Directory endpoint inside `biometric-service` only. It is intended for the separately approved future workforce-app linking UI so an administrator can select a biometric person instead of typing a code manually.

No database migration or SQL mutation is required. No main-application file is changed by this package. The existing `BIOMETRIC_FINAL_EVENTS_API_*` listener/token configuration is reused; the listener remains loopback-only and Bearer-protected.

New endpoint:

```text
GET /api/v1/person-directory?search=&status=active&after_code=&limit=100
```

Returned fields are limited to `personCode`, `displayName`, and `status`. Internal person IDs, device-user IDs, device details, notes, raw data, biometric material, and `worker_id` are not exposed.

After upgrade, start the service normally and verify the startup line for the Person Directory API. Then test the endpoint locally with the existing integration Bearer token before any main-application changes are made.
