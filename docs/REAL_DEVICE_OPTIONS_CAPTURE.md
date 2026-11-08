# Real Device OPTIONS Capture — Verified 2026-08-29

## Hardware

- Vendor: ZKTeco
- Model: SpeedFace-V5L
- Platform: ZAM230 / `ZAM230_TFT`
- Serial: `AJE1261900133`
- MAC: `00:17:61:11:4c:ad`
- Firmware: `ZAM230-NF50VA-1.1.9-OCM-4000-Ver1.0.1`
- OPTIONS PushVersion: `Ver 3.1.6S-20251028`
- Handshake query `pushver`: `2.4.1`
- User-Agent: `iClock Proxy/1.09`

The handshake query version and the OPTIONS-reported firmware PushVersion are separate protocol observations and must not be treated as a contradiction.

## Lab network

Terminal:

```text
IP       192.168.10.199
Subnet   255.255.255.0
Gateway  192.168.10.1
DHCP     ON
```

PC / isolated service:

```text
IP       192.168.10.187
Subnet   255.255.255.0
Gateway  192.168.10.1
Port     9095
```

Ping PC → terminal passed 4/4 with sub-millisecond response in the lab.

## Device communication settings used

```text
Server Mode       ADMS
IP mode           IPv4
Domain            OFF
Server Address    192.168.10.187
Server Port       9095
Proxy             OFF
Protocol          PUSH Protocol
Device Type       T&A PUSH
Device ID         1
TCP COMM.Port     4370
HTTPS             OFF (changed, then terminal rebooted)
```

## Selected real OPTIONS fields

```text
DeviceName        SpeedFace-V5L
IPAddress         192.168.10.199
Platform          ZAM230_TFT
OEMVendor         ZKTECO CO.
MaxAttLogCount    20
MaxUserCount      100
FingerFunOn       1
FPVersion         13
MaxFingerCount    100
FaceFunOn         1
FaceVersion       36
MaxFaceCount      10000
PvFunOn           1
PvVersion         20
MaxPvCount        3000
IsSupportQRcode   1
```

Initial observation had `UserCount=0` and `FPCount=0`. After creating test user `900001` / `TEST` with one fingerprint, OPTIONS reported `UserCount=1` and `FPCount=1`.

QR support is advertised by OPTIONS, but QR verification was explicitly not pursued in the current test sequence and must not be marked validated.

## Privacy note

The OPTIONS body was parsed and sanitized. Sensitive/template-like values were not persisted raw.
