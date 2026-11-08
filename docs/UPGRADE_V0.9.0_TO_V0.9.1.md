# Upgrade v0.9.0 -> v0.9.1

## Fix

v0.9.0 preserved `raw_status` and `raw_verify` correctly but always wrote the canonical `punch_state` and `verification_method` fields as null.

v0.9.1 moves numeric interpretation into the ZKTeco adapter and persists both the raw code and the proven normalized meaning.

The currently approved profile is deliberately scoped to the exact real terminal tested during development:

- serial: `AJE1261900133`
- punch states: `0..5` -> check-in/check-out/break/overtime mappings proven in the real-device test record
- verification: `1=fingerprint`, `3=password`, `4=card`, `15=face`, `25=palm`

Unknown codes remain null at the normalized layer while the raw code is preserved. Other ZKTeco serial numbers are not assigned these meanings until independently validated.

No database DDL change is required for this bug fix.
