# Multi-Device / Multi-Vendor Policy

## Permanent rule

The standalone biometric service must support many devices and remain extensible to multiple manufacturers.

## Current proof level

- Multi-device behavior: architecture + automated tests proven; only one physical terminal has been tested so far.
- Multi-vendor behavior: architecture proven; only the ZKTeco adapter exists and has real-hardware validation.

## Identity

```text
vendor + serialNumber
```

Example: `zkteco:AJE1261900133`.

The live service table `biometric_svc_devices` enforces unique `(vendor, serial_number)`, matching the permanent identity rule. The legacy serial-only biometric table was manually removed after verification.

## Adapter rule

A future manufacturer receives a dedicated adapter. Its Status/Verify semantics must be learned from real hardware/protocol evidence, not copied from ZKTeco.

## Failure isolation

One terminal failing/offline must not stop other terminals. Device-scoped identity, logging and dedupe must remain preserved.

## Current ZKTeco compatibility data

SpeedFace-V5L mappings are documented in `biometric/09_ATTLOG_FIELD_MAPPING.md`. They are not universal multi-vendor semantics.
