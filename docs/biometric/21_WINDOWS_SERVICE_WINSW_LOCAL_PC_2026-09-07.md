# تشغيل `biometric-service` تلقائيًا على Windows باستخدام WinSW — الجهاز المحلي

**التاريخ:** 2026-09-07  
**الخدمة:** `biometric-service` v0.18.0  
**الجهاز المرجعي:** ZKTeco SpeedFace-V5L  
**حالة الجهاز:** `mode=test` — لم تتغير أثناء هذه المرحلة  
**حالة هذه المرحلة:** ✅ مكتملة ومثبتة باختبارات فعلية

## 1. الهدف

تحويل تشغيل `biometric-service` من تشغيل يدوي داخل PowerShell إلى تشغيل Windows مستدام يحقق:

- بدء تلقائي مع Windows.
- تشغيل في الخلفية بدون نافذة PowerShell يومية.
- إعادة تشغيل **الخدمة فقط** إذا تعطل Process الخاص بـNode.
- عدم إعادة تشغيل Windows أو السيرفر كجزء من recovery.
- الحفاظ على `.env` خارج GitHub وعدم كشف أي Token.
- إبقاء جهاز البصمة في `mode=test`.
- إبقاء Web Bridge outbound HTTPS إلى `https://www.tolanhr.com`.

## 2. الحالة قبل التثبيت النهائي

كان التشغيل اليدوي المثبت هو:

```powershell
cd C:\Users\mh\Desktop\01\tolanworkforce\biometric-service
node --env-file=.env src/index.js
```

المسارات المثبتة على الجهاز المحلي:

```text
Node.exe:
C:\Program Files\nodejs\node.exe

Source project:
C:\Users\mh\Desktop\01\tolanworkforce\biometric-service

Stable service deployment:
C:\Tolan\BiometricService
```

Node الذي تم فحصه:

```text
v24.15.0
architecture = x64
```

## 3. اختبار Web Bridge outage قبل إعداد Windows Service

قبل الانتقال إلى التشغيل التلقائي تم تنفيذ اختبار انقطاع الهدف الخارجي للجسر الجديد.

### 3.1 تعطيل الهدف بطريقة آمنة

أثناء توقف `biometric-service` تم تغيير الهدف مؤقتًا فقط إلى:

```text
BIOMETRIC_WEB_BRIDGE_TARGET_URL=http://127.0.0.1:1
```

ثم شُغلت الخدمة، وأكد startup:

```text
web bridge target: http://127.0.0.1:1
```

تم تنفيذ بصمة واحدة. ظهر:

```text
web bridge error (TypeError): fetch failed
```

### 3.2 إثبات أن الحدث لم يضِع

تمت قراءة `var/web-bridge-state.json` فقط، وكانت النتيجة:

```json
{
  "version": 1,
  "cursor": "120001",
  "updatedAt": "2026-09-07T07:11:55.632Z"
}
```

بقاء cursor على `120001` أثبت أن الجسر لم يتقدم بعد فشل الإرسال، أي أن الحدث بقي pending.

### 3.3 إعادة الهدف الصحيح

تم إيقاف الخدمة وإعادة:

```text
BIOMETRIC_WEB_BRIDGE_TARGET_URL=https://www.tolanhr.com
```

بعد تشغيل الخدمة ظهر:

```text
web bridge pushed 1; cursor=150001; results={"processed":1}
```

### 3.4 التحقق من TiDB الإنتاجية — قراءة فقط

التحقق النهائي أثبت للحدث المؤخر:

```text
status                = processed
method                = biometric
attendance_event_id   = 28800001
import_count           = 1
event_time_utc         = 2026-09-07 07:51:47
event_time             = 2026-09-07 10:51:47
```

النتيجة: **الحدث بقي pending أثناء الانقطاع، ثم أُرسل بعد استعادة الهدف، وتم استيراده مرة واحدة فقط.**

## 4. محاولة Task Scheduler ولماذا لم تُعتمد

تم أولًا اختبار Windows Task Scheduler كطريقة بدون برنامج طرف ثالث.

الإعدادات التي تم اختبارها:

- Task name: `Tolan Biometric Service`
- Trigger: `At startup`
- Program:
  `C:\Program Files\nodejs\node.exe`
- Arguments:
  `--env-file=.env src/index.js`
- Start in:
  `C:\Users\mh\Desktop\01\tolanworkforce\biometric-service`
- Run whether user is logged on or not.
- Run with highest privileges.
- no 3-day execution limit.
- no AC-power condition.
- no network-start condition.
- restart every 1 minute, up to 999 attempts.
- do not start a second concurrent instance.

### ما نجح

Task Scheduler شغّل الخدمة في الخلفية وفتحت المنافذ:

```text
9095
9096
9097
```

كما وصلت بصمة فعلية إلى TiDB الإنتاجية وكان:

```text
status       = processed
method       = biometric
import_count = 1
```

### ما فشل

تم قتل `node.exe` عمدًا لاختبار recovery. Task Scheduler لم يعد تشغيل الخدمة تلقائيًا.

Operational log بعد تفعيله أظهر:

```text
Task Scheduler successfully completed ...
return code 4294967295
```

وبعد الإنهاء أصبحت المهمة `Ready` دون إعادة تشغيل Process.

**القرار:** Task Scheduler ليس آلية supervision النهائية لهذه الخدمة، حتى لو كان مناسبًا للتشغيل عند Startup. تم التخلي عنه كحل نهائي وعدم استخدام polling/recurrence workaround.

## 5. القرار النهائي — Windows Service حقيقية عبر WinSW

تم اعتماد WinSW كـservice wrapper حول Node بدل Task Scheduler.

البنية النهائية:

```text
Windows Service Control Manager
    ↓
WinSW
    ↓
C:\Program Files\nodejs\node.exe
    ↓
--env-file=.env src/index.js
    ↓
biometric-service
```

WinSW المستخدم:

```text
Version: 2.12.0
Architecture: x64
Download source: official WinSW GitHub release
```

الـinstaller المستخدم لا يعتمد على `latest` بشكل عشوائي؛ الإصدار pinned مع SHA-256 ثابت.

## 6. سكربت التثبيت

النسخة النهائية المستخدمة:

```text
scripts/Install-TolanBiometricService-v2.ps1
```

السكريبت:

- يفحص Administrator privilege.
- يفحص Node >= 20.
- يفحص مصدر المشروع و`.env` و`node_modules` وملف Web Bridge cursor.
- يتحقق أن Web Bridge enabled وأن الهدف هو `https://www.tolanhr.com`.
- لا يطبع قيمة Token.
- يرفض الكتابة فوق خدمة أو مجلد deployment موجود مسبقًا دون مراجعة.
- ينسخ runtime إلى `C:\Tolan\BiometricService`.
- يحافظ على `var/web-bridge-state.json` ويتحقق من hash بعد النسخ.
- يقيد ACL على مجلد deployment و`.env`.
- ينزّل WinSW الرسمي pinned ويتحقق من SHA-256.
- يثبت `TolanBiometricService` كـWindows Service.
- يشغل الخدمة ويتحقق من المنافذ 9095/9096/9097.
- يعطل Task Scheduler القديم **فقط بعد نجاح الخدمة الجديدة**.
- يحتوي best-effort rollback إذا فشل التثبيت.
- لا يحتوي SQL.
- لا يحتوي reboot/shutdown.
- لا يعدل `.env` الأصلية.

### مشكلة installer v1

النسخة الأولى توقفت قبل تثبيت WinSW بسبب PowerShell collection semantics:

```text
The property 'Count' cannot be found on this object.
```

حدث ذلك عندما أعادت دالة فحص المنافذ عنصرًا واحدًا بدل array.

النتيجة:

- التثبيت توقف بأمان.
- لم تُثبت Windows Service.
- Task Scheduler القديم أُعيد/حُفظ.
- لم يحدث SQL أو reboot.

### إصلاح installer v2

تم تحويل نتائج فحص المنافذ إلى arrays صريحة `@(...)`، مع تحسين rollback وحماية deployment directory قبل نسخ `.env`.

## 7. Windows Service المثبتة

اسم الخدمة:

```text
Service name: TolanBiometricService
Display name: Tolan Biometric Service
```

بعد التثبيت:

```text
State:       Running
Start mode:  Auto
Account:     LocalSystem
```

الإعدادات المهمة:

```text
workingdirectory = C:\Tolan\BiometricService
executable       = C:\Program Files\nodejs\node.exe
arguments        = --env-file=.env src/index.js
start mode       = Automatic + delayed auto start
failure action   = restart service after 10 sec
reboot action    = NONE
```

سجلات wrapper/output:

```text
C:\Tolan\BiometricService\service-logs\
```

تقرير التثبيت:

```text
C:\Tolan\BiometricService\INSTALLATION-REPORT.txt
```

## 8. اختبار Auto-Restart الحقيقي — PASSED

بعد نجاح التثبيت كان Process الخاص بالخدمة:

```text
PID 18468
node.exe
```

تم تنفيذ crash simulation مقصود:

```powershell
Stop-Process -Id 18468 -Force
```

لم يتم تشغيل أي أمر يدوي بعدها.

بعد حوالي 20 ثانية عادت المنافذ الثلاثة بعملية جديدة:

```text
PID 9824
9095 LISTEN
9096 LISTEN
9097 LISTEN
```

**النتيجة:** Windows Service أعادت `biometric-service` تلقائيًا. لم يحدث Restart لـWindows.

## 9. اختبار Restart كامل لـWindows — PASSED

تم تنفيذ Restart يدوي للجهاز لاختبار startup الحقيقي.

عند الفحص المبكر جدًا ظهرت الخدمة `Stopped`، لكن WinSW logs أثبتت أن الخدمة كانت مضبوطة delayed-auto-start ثم بدأت تلقائيًا عند:

```text
2026-09-07 14:21:14
```

وشغلت:

```text
PID 4404
```

الفحص اللاحق أكد:

```text
Status = Running
9095 LISTEN
9096 LISTEN
9097 LISTEN
```

**ملاحظة تشغيلية:** بسبب delayed auto start، لا تعتبر `Stopped` خلال الثواني الأولى بعد login فشلًا قبل إعطاء Windows وقتًا لبدء الخدمة.

## 10. اختبار بصمة بعد Restart — PASSED

### break_in

تم تنفيذ بصمة `break_in` بعد الإقلاع.

وصل Final Event إلى الإنتاج وكانت النتيجة:

```text
event_type          = break_in
status              = unsupported_event
attendance_event_id = NULL
```

هذا هو السلوك المقصود حاليًا لأن `break_in` لا يتحول إلى attendance check-in/check-out.

### check_in

تم تنفيذ بصمة `check_in` بعد الإقلاع.

TiDB الإنتاجية أثبتت:

```text
event_type          = check_in
status              = processed
attendance_event_id = 28860001
method              = biometric
event_time_utc      = 2026-09-07 11:27:23
event_time          = 2026-09-07 14:27:23
work_date           = 2026-09-07
```

النتيجة تثبت المسار الكامل بعد Restart:

```text
ZKTeco device
→ Windows Service / biometric-service
→ outbound HTTPS Web Bridge
→ https://www.tolanhr.com / Railway
→ production main app
→ production TiDB
```

## 11. منع التشغيل المزدوج

بعد نجاح Windows Service النهائية تم التحقق من Task Scheduler القديم:

```text
TaskName: Tolan Biometric Service
State:    Disabled
```

Windows Service وحدها كانت:

```text
TolanBiometricService = Running
```

وبذلك لا يوجد مساران متوازيان يفتحان 9095/9096/9097.

## 12. أوامر التشغيل اليومية المعتمدة

### حالة الخدمة

```powershell
Get-Service -Name TolanBiometricService
```

### بدء الخدمة يدويًا عند الحاجة الإدارية

```powershell
Start-Service -Name TolanBiometricService
```

### إيقاف الخدمة يدويًا عند الحاجة الإدارية

```powershell
Stop-Service -Name TolanBiometricService
```

### إعادة تشغيل الخدمة فقط

```powershell
Restart-Service -Name TolanBiometricService
```

**هذه الأوامر لا تعيد تشغيل Windows.**

### فحص المنافذ

```powershell
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
Where-Object { $_.LocalPort -in 9095,9096,9097 } |
Sort-Object LocalPort |
Select-Object LocalAddress,LocalPort,OwningProcess
```

## 13. قواعد أمنية وتشغيلية

- لا تكشف أو تطبع `BIOMETRIC_WEB_BRIDGE_TOKEN`.
- لا ترفع `.env` إلى GitHub.
- لا تعرض 9095/9096/9097 للإنترنت العام.
- 9096 و9097 loopback-only كما في التصميم الحالي.
- لا تخزن biometric templates أو biometric images أو passwords أو raw sensitive payloads.
- جهاز البصمة يبقى `mode=test` إلى أن يوافق المستخدم صراحة على تغيير ذلك.
- TiDB الفعلية هي DB source of truth؛ Drizzle ليس مرجع الحقيقة.
- لا `drizzle push` ولا migration ولا SQL تعديلي تلقائي.

## 14. نتيجة مرحلة الجهاز المحلي

جميع الاختبارات المطلوبة للجهاز المحلي نجحت:

```text
Web Bridge production delivery                PASS
Web Bridge outbound/Railway outage retry      PASS
Pending cursor preservation                   PASS
Exactly-once import verification              PASS
Windows background operation                  PASS
Service automatic crash recovery              PASS
Windows automatic startup after reboot        PASS
Post-reboot biometric delivery                PASS
Old Task Scheduler disabled                   PASS
Device mode=test preserved                    PASS
```

**انتهت مرحلة الجهاز المحلي. الخطوة التالية هي تجهيز جهاز سيرفر الشركة بنفس النموذج المثبت، مع عدم تغيير `mode=test` أثناء مرحلة التجهيز والاختبار.**
