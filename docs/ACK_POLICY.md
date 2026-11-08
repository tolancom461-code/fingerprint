# ACK Policy

## Purpose

Separate protocol/control acknowledgements from acceptance of attendance data.

## Current behavior

| Message | Safe action | ACK behavior |
|---|---|---|
| GET `cdata?options=all` | return handshake profile | HTTP 200 |
| POST `table=OPTIONS` | sanitize and observe | HTTP 200 after safe observation |
| POST `table=OPERLOG` known/safe | parse, redact/discard sensitive values | HTTP 200 after safe observation |
| POST `table=OPERLOG` unknown shape | observe metadata only | no success ACK |
| POST `table=ATTLOG` | sanitize + durable ingest / dedupe, then canonical processing | controlled by `BIOMETRIC_ATTLOG_ACK_MODE` and safety gate |
| template-like unsupported cdata | discard sensitive body | no success ACK in discovery policy |
| unauthorized device | reject before body processing | 403 |

## Configuration

Preferred variable:

```text
BIOMETRIC_ATTLOG_ACK_MODE=observe|ack
```

The older `BIOMETRIC_ACK_MODE` exists only as a compatibility alias and should be removed from the environment during controlled tests to avoid ambiguity.

## Real-device evidence

With `ATTLOG` in observe/no-success mode, the SpeedFace-V5L retried the same 48-byte punch roughly every five seconds. The isolated store detected it as a duplicate.

After starting v0.6.0 with:

```text
BIOMETRIC_ATTLOG_ACK_MODE=ack
```

the already-captured duplicate was acknowledged and the terminal stopped retrying it. Therefore the current ZKTeco ATTLOG ACK format is proven to be accepted by this real device.

## Production rule

A production ATTLOG ACK must only be returned **after the sanitized source event is durably persisted or the service has durably confirmed that the same safe event is already persisted**. Never ACK first and persist later.

Starting in v0.7, this durability boundary is the isolated `ingest.ndjson` store. Canonical punch processing occurs after durable capture and may be retried from the durable inbox. If canonical processing fails, the source event remains recoverable. Unknown/unsafe ATTLOG shapes are not success-acknowledged.

This remains isolated local persistence only. It does not authorize TiDB/database integration.

## Safety boundary

ACK policy must never trigger writes to current attendance, workers, finance or QR systems. OPTIONS/OPERLOG ACK behavior must remain independent from ATTLOG acceptance.
