# الحالة الحالية — 2026-09-07

## 1. الملخص التنفيذي

`biometric-service` الحالية هي **v0.18.0**، ومسار الإنتاج المثبت حاليًا هو:

```text
ZKTeco device
    ↓ local network
biometric-service on Windows
    ↓ outbound HTTPS Web Bridge
https://www.tolanhr.com / Railway
    ↓
production main app
    ↓
production TiDB
```

الجهاز المرجعي ما زال `mode=test`.

مرحلة الجهاز المحلي اكتملت باختبارات فعلية شملت outage، background service، process crash recovery، Windows restart، وبصمة فعلية بعد restart.

## 2. الجهاز المرجعي

```text
Vendor             zkteco
Model              SpeedFace-V5L
Serial             AJE1261900133
Device IP          192.168.10.199
ADMS port          9095
SDK port           4370
Timezone           Asia/Riyadh / UTC+03:00
Mode               test
```

لا يتم تغيير `mode` إلى `live` إلا بموافقة صريحة مستقلة.

## 3. خرائط الجهاز المثبتة

```text
rawStatus 0 -> check_in
rawStatus 1 -> check_out
rawStatus 2 -> break_out
rawStatus 3 -> break_in
rawStatus 4 -> overtime_in
rawStatus 5 -> overtime_out

rawVerify 1  -> fingerprint
rawVerify 3  -> password
rawVerify 4  -> card
rawVerify 15 -> face
rawVerify 25 -> palm
```

هذه mapping للجهاز/firmware المختبر ولا تعمم تلقائيًا على جهاز آخر.

## 4. قاعدة بيانات `biometric-service`

Schema المستخدمة: `test`.

الجداول البيومترية العشرة المثبتة:

```text
biometric_svc_devices
biometric_svc_ingest_events
biometric_svc_event_processing
biometric_svc_punches
biometric_svc_device_users
biometric_svc_people
biometric_svc_person_device_users
biometric_svc_final_events
biometric_svc_finalization_issues
biometric_svc_audit_log
```

TiDB الفعلية هي مصدر الحقيقة. لا يتم اعتماد Drizzle schema كمرجع DB نهائي.

## 5. الخدمات المحلية الحالية

```text
Admin UI:          http://127.0.0.1:9096
Final Events API:  http://127.0.0.1:9097/api/v1
Person Directory:  GET /api/v1/person-directory
ADMS listener:     0.0.0.0:9095
```

9096 و9097 loopback-only. لا يتم expose مباشر للمنافذ المحلية إلى الإنترنت العام.

## 6. Finalization / historical behavior

- automatic finalization: enabled for new canonical punches only.
- retry sweep: every 10 seconds; retry delay 30 seconds.
- automatic historical finalization backfill: disabled.
- manual historical Final Events reprocessing: available from local Admin UI.
- historical reprocessing remains explicit/human-controlled.

## 7. Main App integration

### attendance truth

`attendance_events` هو سجل الحضور الأساسي.

```text
attendance_events
    ↓
processAttendanceToFinance(...)
    ↓
worker_daily_finance
```

### source method

```text
QR camera / manual worker code -> method=qr
biometric                     -> method=biometric
```

### duplicate policy

First valid event wins داخل نافذة 3 دقائق لنفس العامل + نفس event type.

### biometric import tracking

Main App يستخدم `biometric_final_event_imports` لتتبع:

```text
processed
duplicate
unmapped
unsupported_event
```

ويضمن idempotency بواسطة Final Event UUID.

## 8. Web Bridge v0.18.0

Production endpoint:

```text
https://www.tolanhr.com
```

الاتجاه الحالي:

```text
local biometric-service
    ↓ outbound HTTPS
Railway main app
```

الـpull importer القديم ليس اتجاه الإنتاج الحالي.

### outage test — PASSED

تم تحويل target مؤقتًا إلى `http://127.0.0.1:1`، تنفيذ بصمة واحدة، وإثبات:

- `fetch failed` أثناء الانقطاع.
- Web Bridge cursor بقي `120001` ولم يتقدم.
- بعد إعادة target الصحيح، ظهر:
  `web bridge pushed 1; cursor=150001; results={"processed":1}`.
- TiDB الإنتاجية أثبتت `status=processed`, `method=biometric`, `import_count=1`.

تفاصيل الاختبار: `21_WINDOWS_SERVICE_WINSW_LOCAL_PC_2026-09-07.md`.

## 9. Windows background service — PASSED

الحل النهائي المحلي هو Windows Service حقيقية بواسطة WinSW، وليس Task Scheduler.

```text
Service name: TolanBiometricService
Display name: Tolan Biometric Service
Deployment:   C:\Tolan\BiometricService
Account:      LocalSystem
Start mode:   Automatic + delayed auto start
```

### اختبارات مثبتة

```text
Background execution without daily PowerShell        PASS
Process crash -> automatic service restart            PASS
Windows restart -> automatic service startup          PASS
Post-reboot break_in delivery                         PASS (unsupported_event as designed)
Post-reboot check_in delivery                         PASS (processed / biometric)
Old Task Scheduler                                    Disabled
```

عملية crash test رجعت من PID `18468` إلى PID `9824` تلقائيًا.

بعد Windows restart بدأ WinSW تلقائيًا وشغّل PID `4404`; بعد startup كان 9095/9096/9097 listening.

آخر post-reboot check-in الموثق:

```text
status              = processed
attendance_event_id = 28860001
method              = biometric
event_time_utc      = 2026-09-07 11:27:23
event_time          = 2026-09-07 14:27:23
work_date           = 2026-09-07
```

## 10. الأمن والخصوصية

- لا Token values داخل التوثيق.
- `.env` لا يذهب إلى GitHub.
- لا biometric templates/images/passwords/raw sensitive payloads في Main App.
- outbound HTTPS هو اتجاه الإنتاج.
- لا expose مباشر لـZKTeco أو 9095/9096/9097 إلى الإنترنت العام.
- الجهاز يبقى `mode=test`.

## 11. DB / migration safety

- لا `drizzle push`.
- لا startup automatic migrations.
- لا schema mutation دون موافقة صريحة.
- read-only SQL مسموح للتحقق.
- خلال outage/Windows-service phase بتاريخ 2026-09-07 كانت عمليات TiDB المستخدمة للتحقق قراءة فقط.

## 12. نقطة الانتقال الحالية

```text
Local PC phase       = COMPLETE
Company server phase = NOT STARTED
Device mode          = test
```

**انتهت مرحلة الجهاز المحلي، الآن ننتقل إلى جهاز سيرفر الشركة ونجهزه لتشغيل برنامج البصمة تلقائيًا.**

لا تبدأ خطوات سيرفر الشركة إلا عند بدء تلك المرحلة صراحة.

## 13. ملاحظة تاريخية

تقارير v0.9.4 و2026-08-31 تبقى Baseline تاريخيًا مهمًا، لكن عبارات مثل "Main application integration not started" فيها تصف الحالة وقتها فقط وقد تم تجاوزها لاحقًا حتى v0.18.0.
