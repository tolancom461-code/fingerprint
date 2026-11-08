# Real Device Test Gate

## Status

The first real-device gate is **passed** for ZKTeco SpeedFace-V5L `AJE1261900133`.

This does not authorize database modification or integration with the existing workforce application.

## Evidence obtained

- same-subnet network reachability;
- ADMS handshake and OPTIONS exchange;
- real device metadata and firmware;
- safe OPERLOG handling;
- real ATTLOG capture;
- retry behavior when ATTLOG is not acknowledged;
- local deduplication of retries;
- successful ATTLOG ACK when explicitly enabled;
- real verification-method mapping;
- real punch-state mapping.

Full results are documented in:

- `biometric/08_REAL_DEVICE_VALIDATION_2026-08-29.md`
- `biometric/09_ATTLOG_FIELD_MAPPING.md`

## Privacy gate

No fingerprint/face/palm template, photo, password, or card number is part of the approved ATTLOG evidence set.

## Future real devices

A second device must be tested independently even if it is the same model. A different manufacturer requires its own vendor adapter and validation record. Numeric Status/Verify mappings must not be assumed across devices or firmware versions.
