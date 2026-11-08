# Upgrade v0.4 -> v0.5

> **Historical status:** This upgrade has already been applied. Current standalone service baseline is v0.8.0; do not treat this file as the current execution plan.

This upgrade changes only the isolated `biometric-service`. It does not modify the main application or database.

## Why

Real SpeedFace-V5L testing showed the terminal repeatedly posting `table=OPTIONS` when the observer returned HTTP 503. The service now treats `OPTIONS` as ADMS control-plane negotiation and acknowledges it only after the sanitized observation has been written successfully.

`ATTLOG` remains independent and stays in `observe` mode by default.

## Configuration

Preferred variable:

```text
BIOMETRIC_ATTLOG_ACK_MODE=observe
```

The old `BIOMETRIC_ACK_MODE=observe` remains a temporary compatibility alias, so an existing PowerShell session does not suddenly enable ATTLOG ACK.

## Files changed

- `package.json`
- `.env.example`
- `src/config/env.js`
- `src/index.js`
- `src/infrastructure/vendors/zkteco/http-adapter.js`
- `tests/http-server.test.js`
- documentation under `biometric-service/docs/` and `README.md`

No files are deleted in this upgrade. Existing `var/` captures/logs must be preserved.
