# دليل تشغيل `biometric-service` — Windows Service / WinSW

**آخر تحديث:** 2026-09-07  
**الحالة:** التشغيل المحلي النهائي مثبت كـWindows Service حقيقية.  
**Device mode:** `test`

## 1. التشغيل اليومي الحالي

لا يحتاج المشغل إلى فتح PowerShell لتشغيل الخدمة يوميًا.

Windows Service:

```text
Service name: TolanBiometricService
Display name: Tolan Biometric Service
Deployment:   C:\Tolan\BiometricService
```

تبدأ تلقائيًا مع Windows باستخدام delayed auto start.

## 2. فحص الحالة

```powershell
Get-Service -Name TolanBiometricService
```

المتوقع بعد اكتمال startup:

```text
Status = Running
```

## 3. فحص listeners

```powershell
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
Where-Object { $_.LocalPort -in 9095,9096,9097 } |
Sort-Object LocalPort |
Select-Object LocalAddress,LocalPort,OwningProcess
```

المتوقع:

```text
0.0.0.0:9095
127.0.0.1:9096
127.0.0.1:9097
```

## 4. إدارة الخدمة عند الحاجة

### Start

```powershell
Start-Service -Name TolanBiometricService
```

### Stop

```powershell
Stop-Service -Name TolanBiometricService
```

### Restart الخدمة فقط

```powershell
Restart-Service -Name TolanBiometricService
```

هذه الأوامر لا تعيد تشغيل Windows.

## 5. Auto-Restart

WinSW/SCM مسؤولان عن recovery.

تم إثبات crash recovery فعليًا بقتل Process Node ثم رجوع Process جديد تلقائيًا.

لا تستخدم Task Scheduler recurrence كـwatchdog.

## 6. Windows reboot behavior

الخدمة Automatic مع delayed auto start.

بعد reboot:

1. لا تشغّل `biometric-service` يدويًا.
2. انتظر حتى يكمل Windows delayed startup.
3. افحص `Get-Service`.
4. افحص 9095/9096/9097.

فحص `Stopped` خلال الثواني الأولى لا يكفي وحده للحكم على failure.

## 7. السجلات

WinSW logs:

```text
C:\Tolan\BiometricService\service-logs\TolanBiometricService.wrapper.log
C:\Tolan\BiometricService\service-logs\TolanBiometricService.out.log
C:\Tolan\BiometricService\service-logs\TolanBiometricService.err.log
```

قراءة آخر السجلات:

```powershell
Get-Content "C:\Tolan\BiometricService\service-logs\TolanBiometricService.wrapper.log" -Tail 100
Get-Content "C:\Tolan\BiometricService\service-logs\TolanBiometricService.out.log" -Tail 100
```

لا تنسخ Token أو بيانات حساسة إلى tickets/docs.

## 8. Web Bridge state

ملف cursor داخل deployment:

```text
C:\Tolan\BiometricService\var\web-bridge-state.json
```

فحصه قراءة فقط عند troubleshooting مسموح.

قاعدة مهمة: لا تعدّل cursor يدويًا في التشغيل العادي.

## 9. Production Web Bridge

الهدف الحالي:

```text
https://www.tolanhr.com
```

المسار:

```text
biometric-service -> outbound HTTPS -> Railway/Main App
```

لا expose inbound من الإنترنت إلى 9095/9096/9097.

## 10. اختبار outage المعتمد

الاختبار الكامل موثق في:

`21_WINDOWS_SERVICE_WINSW_LOCAL_PC_2026-09-07.md`

لا تكرر outage test في الإنتاج بلا سبب تشغيلي وموافقة مناسبة.

## 11. Task Scheduler القديم

المهمة القديمة:

```text
Tolan Biometric Service
```

يجب أن تبقى:

```text
Disabled
```

فحص:

```powershell
Get-ScheduledTask -TaskName "Tolan Biometric Service" |
Select-Object TaskName,State
```

إذا أصبحت Enabled بدون قرار، توقف وراجع قبل تشغيلها لتجنب duplicate listeners.

## 12. Installer / إعادة بناء الخدمة

Installer الموثق:

```text
scripts/Install-TolanBiometricService-v2.ps1
```

لا تشغله فوق خدمة قائمة بشكل عشوائي. هو مصمم أن يرفض وجود deployment/service قائمة حتى تتم المراجعة أولًا.

## 13. قواعد الجهاز

- device remains `mode=test`.
- استخدم test users في الاختبارات المقصودة.
- لا تحفظ biometric templates/images/password/card credential material في التوثيق.
- احترم duplicate punch behavior عند الاختبارات المتتابعة.
- لا تغيّر firewall/DHCP/network settings بلا حاجة موثقة.

## 14. خريطة event types المرجعية

```text
0 check_in
1 check_out
2 break_out
3 break_in
4 overtime_in
5 overtime_out
```

```text
1  fingerprint
3  password
4  card
15 face
25 palm
```

## 15. Main App behavior

- `check_in` / `check_out` يمكن أن ينتجا `attendance_events`.
- `break_in/break_out/overtime_*` لا تتحول حاليًا إلى attendance check-in/check-out، وقد تسجل `unsupported_event` في import tracking.
- `method=biometric` للبصمة المقبولة.
- first valid event wins داخل duplicate window.

## 16. قاعدة DB

- actual TiDB = source of truth.
- لا Migration أو `drizzle push` من هذا Runbook.
- read-only SQL verification فقط عند الحاجة.
- أي SQL mutation يحتاج شرحًا وموافقة صريحة منفصلة.

## 17. التشغيل اليدوي القديم — طوارئ فقط

المصدر الأصلي ما زال:

```text
C:\Users\mh\Desktop\01\tolanworkforce\biometric-service
```

أمر التشغيل اليدوي المعروف:

```powershell
node --env-file=.env src/index.js
```

**لا تستخدمه بينما Windows Service تعمل**، لأن ذلك قد يسبب تعارض منافذ وتشغيلًا مزدوجًا.

إذا احتجت تشغيل المصدر يدويًا لأعمال صيانة، أوقف Windows Service أولًا وبقرار واعٍ.
