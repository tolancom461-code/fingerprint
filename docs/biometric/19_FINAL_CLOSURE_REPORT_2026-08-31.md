# تقرير الإغلاق النهائي لخدمة البصمة المستقلة — 2026-08-31

## 1. القرار النهائي

تم إكمال مرحلة بناء واختبار `biometric-service` المستقلة على الإصدار **v0.9.4**.

حالة الإغلاق:

```text
Standalone biometric service        ✅ مكتملة
Real ZKTeco ADMS connection         ✅ مثبتة
TiDB durable ingest                 ✅ مثبت فعلياً
Canonical punch persistence         ✅ مثبت فعلياً
ACK + duplicate protection          ✅ مثبت فعلياً
Retry/replay recovery               ✅ آلياً + تشغيل runtime
Timezone normalization              ✅ مثبت فعلياً
Device runtime policy               ✅ مثبتة
Privacy boundary                    ✅ مثبتة
Main workforce integration          ❌ لم يبدأ عمداً
```

لا يوجد خلل حرج معروف يمنع إغلاق **مرحلة الخدمة المستقلة**. أي ربط لاحق مع التطبيق الرئيسي يعتبر مرحلة جديدة ويتطلب تصميم وموافقة واختبارات مستقلة.

---

## 2. حدود النطاق التي تم الالتزام بها

طوال هذه المرحلة كان العمل محصوراً في:

```text
biometric-service/
```

الخدمة لا تستورد ولا تستدعي كود التطبيق الرئيسي، ولا تكتب إلى:

- `workers`
- `attendance_events`
- finance / payroll
- shifts
- QR
- أي جدول تشغيلي للتطبيق الرئيسي

فحص الحدود الآلي النهائي: **4/4 ناجح**.

TiDB الفعلية هي مصدر الحقيقة لقاعدة البيانات. لا يوجد Migration أو DDL تلقائي داخل runtime.

---

## 3. الجهاز الحقيقي المرجعي

```text
Vendor          ZKTeco
Model           SpeedFace-V5L
Serial          AJE1261900133
Platform        ZAM230 / ZAM230_TFT
Firmware        ZAM230-NF50VA-1.1.9-OCM-4000-Ver1.0.1
ADMS/PUSH port  9095
SDK port        4370
```

### إعداد الشبكة النهائي

```text
Device IP       192.168.10.199
Subnet Mask     255.255.255.0
Gateway         192.168.10.1
DHCP            OFF
Service PC IP   192.168.10.187
```

تم التحقق من الاتصال بعد تثبيت العنوان باستخدام `ping.exe`: استلام 2/2 وعدم فقد أي packet.

### الوقت على الجهاز

```text
Time Zone            UTC+03:00
Operational timezone Asia/Riyadh
DST                  OFF
24-hour time         ON
NTP                  OFF by operator choice
```

قرار عدم تفعيل NTP لا يؤثر على البصمة أو القوالب الحيوية. يلزم فقط مراقبة دقة ساعة الجهاز تشغيلياً إذا طال الاستخدام بدون مزامنة زمنية.

---

## 4. قاعدة البيانات الفعلية

قاعدة البيانات المستخدمة:

```text
test
```

الجداول المملوكة حصراً للخدمة:

1. `biometric_svc_devices`
2. `biometric_svc_ingest_events`
3. `biometric_svc_event_processing`
4. `biometric_svc_punches`
5. `biometric_svc_device_users`

الجداول البيومترية القديمة الفارغة تم حذفها يدوياً بعد فحوص الاعتماديات. الجداول الخمسة الحالية تم إنشاؤها يدوياً والتحقق من بنيتها قبل تشغيل DB runtime.

الخدمة لا تنفذ `CREATE`, `ALTER`, أو `DROP` تلقائياً. Startup يقوم بفحص Read-Only لعقد قاعدة البيانات والجداول والفهارس والـcollation قبل فتح الخدمة.

---

## 5. مسار الحركة المعتمد

المسار النهائي:

```text
Biometric terminal
  -> vendor adapter
  -> parsing + privacy/safety gate
  -> sanitized durable ingest in TiDB
  -> COMMIT
  -> ACK eligibility
  -> canonical punch processing
  -> device-user observation
```

قواعد الأمان الأساسية:

- لا ACK ناجح قبل durable ingest آمن.
- التكرار لا ينشئ ingest أو punch جديداً.
- فشل canonical processing بعد durable ingest لا يفقد المصدر؛ يبقى قابلاً لإعادة المعالجة.
- `retry sweep` يعمل أثناء تشغيل الخدمة ولا يعتمد فقط على restart.
- startup replay يعالج ما يستحق المعالجة بشكل idempotent.

---

## 6. الخصوصية

ممنوع تخزين المحتوى البيومتري أو بيانات الاعتماد الحساسة.

لا يتم حفظ:

- fingerprint templates
- face templates/images
- palm templates
- BIODATA / biometric blobs
- passwords
- card credential values
- raw unsafe payloads

المسموح فقط هو metadata آمنة ومطهرة مثل نوع الحدث، طريقة التحقق المفسرة، معرف مستخدم الجهاز، أوقات الحركة، وخصائص الجهاز غير الحساسة.

---

## 7. خرائط الجهاز المثبتة فعلياً

هذه الخرائط **Compatibility Profile للجهاز/firmware المرجعي فقط**، وليست قاعدة عامة لكل أجهزة ZKTeco.

### Punch state

```text
rawStatus=0   -> check_in
rawStatus=1   -> check_out
rawStatus=2   -> break_out
rawStatus=3   -> break_in
rawStatus=4   -> overtime_in
rawStatus=5   -> overtime_out
rawStatus=255 -> no explicit state observed
```

### Verification method

```text
rawVerify=1   -> fingerprint
rawVerify=3   -> password
rawVerify=4   -> card
rawVerify=15  -> face
rawVerify=25  -> palm
```

الإصدار v0.9.1 أصلح حفظ `punch_state` و`verification_method`، مع إبقاء الخرائط مرتبطة بالجهاز المختبر وعدم تعميمها على Serial آخر.

---

## 8. إثباتات TiDB والجهاز الحقيقي

### 8.1 أول إثبات DB runtime

تم إثبات أن حركة حقيقية وصلت إلى `biometric_svc_ingest_events` ثم إلى `biometric_svc_punches`.

### 8.2 ACK ومنع التكرار

عندما كان `BIOMETRIC_ATTLOG_ACK_MODE=observe` أعاد الجهاز نفس ATTLOG، والخدمة سجلته كـ duplicate بدون إنشاء سجل جديد.

بعد التحويل إلى:

```text
BIOMETRIC_ATTLOG_ACK_MODE=ack
```

توقف الجهاز عن إعادة الحدث القديم بعد ACK الآمن، ثم أرسل الحركة التالية. هذا أثبت حدود durability قبل ACK ومنع التكرار فعلياً.

### 8.3 حركات موحدة مثبتة

تمت مشاهدة حركات حقيقية جديدة بالتفسير الصحيح، منها:

```text
rawStatus=0 / rawVerify=1 -> check_in / fingerprint
rawStatus=2 / rawVerify=1 -> break_out / fingerprint
rawStatus=4 / rawVerify=1 -> overtime_in / fingerprint
```

السجل القديم الذي أُنشئ قبل إصلاح v0.9.1 بقي بقيم التفسير `NULL` تاريخياً ولم يتم تزويره أو إعادة كتابته.

### 8.4 timezone وUTC

في اختبار فعلي على v0.9.3/v0.9.4:

```text
device_event_time_raw    = 2026-08-31 09:44:05
device_event_time_local  = 2026-08-31 09:44:05
device_timezone          = Asia/Riyadh
device_event_time_utc    = 2026-08-31 06:44:05
raw_status               = 0
punch_state              = check_in
raw_verify               = 1
verification_method      = fingerprint
```

هذا يثبت أن وقت الجهاز يبقى بتوقيت الرياض، بينما النظام يشتق UTC للمقارنات والحسابات العابرة للمناطق الزمنية.

---

## 9. خلل accept_events_from وكيف تم اكتشافه وإصلاحه

أثناء اختبار حقيقي على v0.9.3 تم ضبط `accept_events_from` في المستقبل، لكن الحركة تحولت إلى Punch بالخطأ.

السبب: المقارنة كانت بين وقت الجهاز المحلي `Asia/Riyadh` وقيمة TiDB التي تمثل UTC بدون توحيد المرجع الزمني.

تم إصلاحه في **v0.9.4**:

```text
device local time
  -> convert using device IANA timezone
  -> UTC instant
  -> compare with accept_events_from UTC
```

الاختبار الحقيقي بعد الإصلاح:

```text
قبل الحركة: ingest=6, punches=6
بعد الحركة: ingest=7, punches=6
```

أي أن الحركة وصلت وحُفظت durable، لكنها لم تتحول إلى Punch لأنها كانت قبل cutoff. هذا هو السلوك المقصود.

بعد الاختبار تم إعادة:

```text
accept_events_from = NULL
```

---

## 10. سياسات الجهاز mode/status

### mode

تم ضبط `mode=maintenance` مؤقتاً. سجل الخدمة أظهر فعلياً:

```text
device_policy_rejected
reason=mode:maintenance
```

ثم أعيد `mode=test`.

### status

تم ضبط `status=disabled` مؤقتاً. أثناء ذلك سجلت الخدمة `device_policy_rejected` بسبب `status:disabled` لاتصالات الجهاز.

ملاحظة دقيقة: حركة البصمة التي نفذت أثناء هذا الاختبار تأخر الجهاز في إرسالها حتى بعد إعادة `status=active`، ثم تم قبولها. لذلك لا يوثق هذا التقرير أن **ATTLOG الحقيقي نفسه** تم رفضه أثناء `disabled`. رفض السياسة أثناء التعطيل مثبت من حركة الاتصالات الحقيقية، ومسار ATTLOG fail-closed مغطى بالاختبارات الآلية.

هذه النتيجة موثقة بهذا التفصيل لتجنب المبالغة في الدليل الحقيقي.

---

## 11. Diagnostic logging

من v0.9.3:

- كل تشغيل جديد يبدأ `service.ndjson` لجلسة التشغيل الحالية.
- الجلسة السابقة تدور إلى `.1`, `.2` ... حسب retention.
- كل سجل جديد يحمل `sessionId`.
- `occurredAt` هو UTC.
- `occurredAtLocal` يعرض توقيت `Asia/Riyadh` للقراءة التشغيلية.
- السجل محدود بالحجم ويتم تدويره بدلاً من النمو بلا حد.

المعايير الافتراضية المثبتة في التشغيل:

```text
10 MiB per active log
5 retained files
log timezone = Asia/Riyadh
```

هذا التوقيت التشخيصي لا يستبدل timezone الخاصة بكل جهاز داخل الـPunch.

---

## 12. نتائج الاختبارات الآلية النهائية

الإصدار النهائي:

```text
biometric-service v0.9.4
```

النتيجة المعاد تشغيلها أثناء توثيق الإغلاق:

```text
npm test
97 tests
97 pass
0 fail
```

فحص حدود الاستقلال جزء من المجموعة، كما أن `npm run check:boundaries` يغطي الاختبارات الأربع الخاصة بالحدود المعمارية.

التغطية تشمل:

- isolation عن التطبيق الرئيسي
- multi-device identity
- vendor-neutral core
- privacy redaction
- ACK safety
- durable ingest
- dedupe/idempotency
- retry loop وعدم التداخل
- startup replay
- database schema fail-closed validation
- device policy
- timezone conversion
- `accept_events_from` عبر المناطق الزمنية
- diagnostic session + rotation
- TiDB ingest/punch stores
- ZKTeco tested-device normalization profile

---

## 13. الحالة التشغيلية النهائية للجهاز

آخر حالة تم التحقق منها في TiDB بعد إعادة إعدادات الاختبار:

```text
vendor             = zkteco
serial_number      = AJE1261900133
mode               = test
status             = active
timezone           = Asia/Riyadh
accept_events_from = NULL
```

### قرار مهم: mode=test

الجهاز **يبقى `mode = test` عمداً** في نهاية هذه المرحلة.

لا يتم تغييره إلى `live` لمجرد أن الخدمة المستقلة نجحت. الانتقال إلى `live` يعتبر قرار تشغيل لمرحلة الربط القادمة، ولا يتم إلا بعد اعتماد تصميم الربط مع النظام الرئيسي وموافقته واختباره.

حتى ذلك الحين:

- الخدمة مستقلة.
- لا تكتب إلى العمال.
- لا تكتب إلى `attendance_events`.
- لا تتصل بالرواتب/المالية.
- لا تتدخل في QR أو shifts.

ملاحظة تقنية: standalone runtime يقبل `test` و`live` كقيم مسموحة. إبقاء الجهاز على `test` هنا **قرار تشغيلي/Gate** يمنع إعلان بدء مرحلة الإنتاج/الربط قبل أوانها.

---

## 14. الأعداد الأخيرة المرصودة أثناء الاختبارات

آخر count تم قياسه بعد اختبارات cutoff وstatus:

```text
biometric_svc_ingest_events = 8
biometric_svc_punches       = 7
```

الفرق المقصود يتضمن حدثاً تم حفظه durable ثم منعه من التحول إلى Punch باختبار `accept_events_from`.

هذه الأعداد لقطة اختبار وليست invariant للنظام، وستتغير مع أي أحداث لاحقة.

---

## 15. ما لم يتم تنفيذه عمداً

هذه البنود **خارج مرحلة الإغلاق الحالية**:

- ربط `device_user_id` بعامل في النظام الرئيسي.
- إنشاء Attendance Bridge.
- الكتابة إلى `attendance_events`.
- تشغيل منطق finance/payroll.
- دمج QR.
- تعديل shifts.
- اختبار جهاز فيزيائي ثانٍ.
- اختبار Vendor فيزيائي ثانٍ.
- QR verification على جهاز ZKTeco نفسه.

وجود معمارية Multi-device/Multi-vendor لا يعني أن Vendor ثانياً قد تم اختباره على عتاد حقيقي؛ المختبر الحقيقي الحالي هو ZKTeco فقط.

---

## 16. شروط بدء المرحلة القادمة

لا يبدأ ربط النظام الرئيسي إلا بقرار جديد يشمل على الأقل:

1. تعريف عقد البيانات الذي سيخرج من `biometric-service` إلى التطبيق الرئيسي.
2. تحديد ownership وحدود retry/idempotency بين الخدمتين.
3. تحديد ربط `device_user_id` بالعامل بدون تلويث raw/canonical biometric records.
4. تحديد كيفية تحويل canonical punches إلى attendance business rules.
5. Regression tests كاملة على الحضور وQR والمالية والشفتات قبل تفعيل أي Bridge.
6. موافقة صريحة قبل تغيير الجهاز من `mode=test` إلى `mode=live`.

---

## 17. خلاصة التسليم

**v0.9.4 هي نسخة إغلاق مرحلة الخدمة البيومترية المستقلة.**

تم إثبات أساسها على جهاز حقيقي وTiDB حقيقية، وتم إصلاح العيوب التي كشفتها الاختبارات الفعلية بدلاً من الاكتفاء باختبارات unit فقط. الحالة الحالية مناسبة للتوقف عند Gate واضح قبل أي دمج مع البرنامج الرئيسي.
