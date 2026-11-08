# Upgrade v0.12.2 -> v0.13.0

`v0.13.0` adds the standalone **read-only Final Events API v1** required before any future main-application bridge.

There is **no database migration** and no main-application change.

The existing administration UI/theme, device listener, Finalization v1 behavior, automatic-new-punch-only rule, and `mode=test` policy remain unchanged.

## New files / behavior

- Dedicated Final Events read store and application service.
- Dedicated integration listener, default `127.0.0.1:9097`.
- API disabled by default.
- Bearer authentication required for event data when enabled.
- Cursor pagination by ascending Final Event row id.
- Stable vendor-neutral v1 response schema.
- Explicit read-only HTTP behavior.
- Consumer replay simulator for idempotency validation.

See `docs/FINAL_EVENTS_API_V1.md`.

## New environment variables

```text
BIOMETRIC_FINAL_EVENTS_API_ENABLED=false
BIOMETRIC_FINAL_EVENTS_API_HOST=127.0.0.1
BIOMETRIC_FINAL_EVENTS_API_PORT=9097
BIOMETRIC_FINAL_EVENTS_API_TOKEN=
```

When enabled, the token must contain at least 32 characters. Do not reuse another service credential and do not share the token in screenshots or chat.

This release deliberately refuses non-loopback API hosts. Remote/LAN exposure requires a later explicit TLS/auth/network design and approval.
