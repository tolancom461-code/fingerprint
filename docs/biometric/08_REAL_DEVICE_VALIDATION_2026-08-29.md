# سجل التحقق من الجهاز الحقيقي — 2026-08-29

## 1. الجهاز

```text
Vendor          ZKTeco
Model           SpeedFace-V5L
Platform label  ZAM230
Platform ADMS   ZAM230_TFT
Serial          AJE1261900133
MAC             00:17:61:11:4c:ad
Firmware        ZAM230-NF50VA-1.1.9-OCM-4000-Ver1.0.1
User-Agent      iClock Proxy/1.09
```

## 2. الشبكة

```text
Terminal IP     192.168.10.199
PC/service IP   192.168.10.187
Subnet          255.255.255.0
Gateway         192.168.10.1
ADMS port       9095
TCP SDK port    4370
```

Ping: 4/4 successful, <1ms in lab.

Device configuration:

```text
Server Mode      ADMS
IPv4             yes
Domain           off
Server Address   192.168.10.187
Port             9095
Proxy            off
Protocol         PUSH Protocol
Device Type      T&A PUSH
Device ID        1
HTTPS            off for validated test
```

## 3. ADMS negotiation

Observed GET:

```text
/iclock/cdata?SN=AJE1261900133&options=all&language=69&pushver=2.4.1&DeviceType=att&PushOptionsFlag=1
```

Observed POST:

```text
/iclock/cdata?SN=AJE1261900133&table=options
```

OPTIONS body size observed: 897 bytes.

Selected capability evidence:

```text
DeviceName       SpeedFace-V5L
MaxAttLogCount   20
MaxUserCount     100
FingerFunOn      1
FPVersion        13
FaceFunOn        1
FaceVersion      36
PvFunOn          1
PvVersion        20
IsSupportQRcode  1
PushVersion      Ver 3.1.6S-20251028
```

## 4. Test user

```text
ID        900001
Name      TEST
Role      Normal User
```

The user was enrolled/used for fingerprint, face, palm, password and card testing. Sensitive credential values are intentionally excluded from documentation.

## 5. OPERLOG

v0.5 initially treated OPERLOG as unsupported and the terminal retried it.

v0.6 observed a 1430-byte batch:

```text
recordCount       36
recognizedCount   36
unrecognizedCount 0
tagCounts          OPLOG:36
safeToAcknowledge true
```

All 36 records were classified as administrator operation records. After safe ACK, the terminal moved to `/iclock/getrequest` polling.

## 6. First ATTLOG

First real captured line:

```text
900001\t2026-08-29 15:30:00\t255\t1\t0\t0\t0\t255\t0\t0
```

Parsed:

```text
deviceUserId    900001
deviceEventTime 2026-08-29 15:30:00
rawStatus       255
rawVerify       1
workCode        0
extraFields     [0,0,255,0,0]
receivedAt UTC  2026-08-29T12:29:59.834Z
```

The ~+03:00 difference between device local time and UTC receive time matched the lab timezone expectation.

## 7. Retry / dedupe

With ATTLOG success ACK disabled, the same 48-byte punch was repeatedly resent approximately every 5 seconds. The service recorded:

```text
acceptedCount  0
duplicateCount 1
```

for retries, proving device retry and local dedupe behavior on real traffic.

## 8. ATTLOG ACK validation

Service started with:

```text
BIOMETRIC_ATTLOG_ACK_MODE=ack
```

The old duplicate was acknowledged and stopped repeating. This proves the service's current ATTLOG ACK is accepted by this terminal.

## 9. Verification methods validated

| Method | rawVerify |
|---|---:|
| Fingerprint | 1 |
| Password | 3 |
| Card | 4 |
| Face | 15 |
| Palm | 25 |

Face was independently confirmed with a deliberate second face attendance event, not inferred only from enrollment.

## 10. Punch states validated

Terminal shortcut mappings observed:

```text
F1 Check-In
F2 Check-Out
F3 Break-Out
F4 Break-In
F5 Overtime-In
F6 Overtime-Out
```

Controlled fingerprint tests produced:

| Punch state | rawStatus | rawVerify |
|---|---:|---:|
| Check-In | 0 | 1 |
| Check-Out | 1 | 1 |
| Break-Out | 2 | 1 |
| Break-In | 3 | 1 |
| Overtime-In | 4 | 1 |
| Overtime-Out | 5 | 1 |

A punch without a selected state had `rawStatus=255`.

## 11. Duplicate Punch terminal rule

Device setting observed: duplicate punch period = **1 minute**.

A Check-Out attempted too soon after Check-In was rejected by the terminal as `Duplicate Punch`. After waiting more than one minute, Check-Out was accepted and produced `rawStatus=1`.

## 12. QR

OPTIONS advertises QR support, but QR attendance was deliberately not validated in this sequence. Do not include a QR `rawVerify` mapping in the compatibility profile.

## 13. Final device-test conclusion

The current SpeedFace-V5L is proven to provide both dimensions needed for future attendance processing:

```text
rawStatus → selected punch state
rawVerify → verification method
```

The service must preserve the raw numeric values and keep the mapping in the ZKTeco compatibility layer.
