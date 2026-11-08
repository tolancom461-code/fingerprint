# الخطة الرئيسية المعتمدة لنظام البصمة

**المشروع:** TolanWorkforce  
**تحديث الخطة:** 2026-08-30  
**النطاق الحالي:** نظام بصمة مستقل فقط  
**الجهاز المرجعي:** ZKTeco SpeedFace-V5L `AJE1261900133`
> **خطة المرحلة التالية المعتمدة:** بعد إغلاق v0.9.4، المرجع التنفيذي لبناء نظام إدارة البصمة المستقل الكامل وFinal Events هو `20_STANDALONE_BIOMETRIC_SYSTEM_EXECUTION_PLAN_2026-08-31.md`. لا يبدأ Main-App Bridge ولا يتحول الجهاز إلى `live` قبل Gates تلك الخطة.

> **تحديث إغلاق 2026-08-31:** اكتملت المراحل المستقلة حتى v0.9.4، وتم تنفيذ جداول `biometric_svc_*` يدوياً والتحقق من TiDB runtime والجهاز الحقيقي. أي بنود أدناه تصف DB كـ pending هي سجل تاريخي للخطة وقت كتابتها. المرجع الحالي هو `19_FINAL_CLOSURE_REPORT_2026-08-31.md`. الجهاز يبقى `mode=test` ولا ينتقل إلى `live` إلا عند اعتماد مرحلة الربط الجديدة.

> هذه الوثيقة أعلى مرجع للتنفيذ. لا يُتجاوز أي Gate بسبب وجود Prototype قديم أو جدول موجود مسبقًا.

## 1. الهدف

بناء خدمة بصمة مستقلة وآمنة ومتعددة الأجهزة وقابلة لتعدد الشركات، تُثبت الاتصال والجهاز والبيانات الخام والتخزين قبل أي ربط بالبرنامج الحالي.

```text
Real biometric terminals
        ↓
Vendor adapters
        ↓
Standalone biometric core
        ↓
Sanitized durable ingest
        ↓
Canonical punch storage + diagnostics
        ↓
Standalone tests / approval
        ↓
STOP
        ↓
Legacy cleanup gate
        ↓
Regression test existing application
        ↓
New explicit approval
        ↓
Future attendance bridge
```

## 2. قواعد غير قابلة للتجاوز

1. لا تعديل قاعدة بيانات بدون موافقة صريحة.
2. لا `CREATE/ALTER/DROP/INSERT/UPDATE/DELETE` ولا Migration تلقائي بدون موافقة.
3. الحقيقة هي TiDB الفعلية، لا Schema المحلي.
4. لا كتابة من الخدمة المستقلة إلى `attendance_events`.
5. لا استدعاء للمالية أو `processAttendanceToFinance()`.
6. لا تعديل `workers` أو QR أو shifts أو finance أثناء المرحلة المستقلة.
7. لا تخزين templates أو صور بيومترية أو كلمات مرور أو أرقام كروت حساسة.
8. الحدث الخام يبقى محفوظًا حتى لو كان `device_user_id` غير معروف.
9. الجهاز يعرف معماريًا بـ `vendor + serialNumber`.
10. Vendor-specific mappings تبقى داخل Adapter.
11. لا دمج قبل نجاح النظام المستقل ثم بوابة تنظيف Prototype ثم اختبار التطبيق الحالي ثم موافقة جديدة.

## 3. الواقع المثبت حتى 2026-08-29

### الجهاز والبروتوكول

- SpeedFace-V5L متصل فعليًا عبر ADMS على المنفذ 9095.
- OPTIONS وOPERLOG وATTLOG تم استقبالها فعليًا.
- الخدمة v0.8.0؛ آخر suite محلي 58/58 passing. اختبارات الجهاز الحقيقي المثبتة سابقًا لم تُعد لأن مسار ADMS الفعلي لم يتغير.
- ACK لـATTLOG قُبل فعليًا عندما فُعل صراحة.

### ATTLOG

ثبت على الجهاز الحالي:

```text
rawStatus: 0..5 = Check-In/Out, Break-Out/In, Overtime-In/Out
rawStatus: 255  = بدون Punch State محدد في العينات المرصودة
rawVerify: 1    = fingerprint
rawVerify: 3    = password
rawVerify: 4    = card
rawVerify: 15   = face
rawVerify: 25   = palm
```

هذه mappings Compatibility Profile للجهاز/firmware الحالي، وليست قاعدة عامة لجميع الأجهزة.

### قاعدة البيانات الفعلية

قاعدة `test` على TiDB Serverless v8.5.3 تحتوي:

```text
biometric_devices          = موجود، 0 صف
biometric_raw_events       = موجود، 0 صف
biometric_worker_mappings  = موجود، 0 صف
biometric_punches          = غير موجود
biometric_device_users     = غير موجود
```

لا توجد Foreign Keys مرتبطة بالجداول الثلاثة المكتشفة. توجد تعارضات تصميمية موثقة في `10_DATABASE_INSPECTION_2026-08-29.md` و`11_DATABASE_RECONCILIATION_PENDING.md`.

## 4. ترتيب التنفيذ من الآن

### المرحلة A — مصالحة قاعدة البيانات الحالية

- [x] فحص أسماء جداول البصمة الفعلية.
- [x] `SHOW CREATE TABLE` للجداول الثلاثة.
- [x] فحص عدد الصفوف: كلها صفر.
- [x] فحص العلاقات: لا Foreign Keys.
- [x] فحص مراجع الكود الحالي لأسماء الجداول الثلاثة — تم Read-Only قبل تثبيت حصر العمل داخل `biometric-service/`.
- [ ] تقرير قرار: إبقاء / إعادة تصميم / استبدال / أرشفة لكل جدول.
- [ ] موافقة صريحة قبل أي SQL تعديل.

### المرحلة B — اعتماد التخزين الدائم للـPunch

بعد مصالحة الجداول فقط:

- تحديد هل `biometric_raw_events` سيُستبدل أو يُعاد تصميمه أو يبقى Legacy.
- تحديد هل نحتاج `biometric_punches` فعلًا.
- اعتماد سياسة idempotency/uniqueness بعد مقارنة `eventKey` و`wireHash` مع بنية DB.
- التأكد أن ACK الإنتاجي لا يحدث إلا بعد durable DB persistence أو confirmed durable duplicate.

### المرحلة C — فهم مستخدمي الجهاز

- فحص طريقة خروج USER metadata الفعلية من الجهاز.
- تصميم `biometric_device_users` فقط بعد دليل حقيقي.
- عدم استخدام `biometric_worker_mappings` القديم قبل فحص مراجع الكود والغرض منه.

### المرحلة D — الاختبارات المستقلة النهائية

- Unknown device.
- Multiple users.
- Invalid/malformed ATTLOG.
- old/future time policy.
- disconnect/reconnect/replay.
- DB persistence + duplicate safety بعد اعتماد DB.
- multi-device physical test عند توفر جهاز ثانٍ.

### المرحلة E — STOP ثم Cleanup Gate

بعد نجاح الخدمة المستقلة بالكامل:

- تنفيذ `07_LEGACY_BIOMETRIC_CLEANUP_GATE.md`.
- اختبار QR والحضور والمالية والتطبيق الحالي.
- موافقة صريحة جديدة.
- فقط بعدها يبدأ مشروع Bridge.

## 5. ما ليس مصرحًا به الآن

- إنشاء `biometric_punches`.
- تعديل `biometric_raw_events`.
- تعديل `biometric_worker_mappings`.
- إضافة الجهاز الحقيقي إلى `biometric_devices`.
- تشغيل أي Migration.
- ربط `900001` بعامل.
- إرسال punches إلى `attendance_events`.


## 8. قرار v0.7 — طبقة الاستقبال الدائم

اعتمدت الخدمة المستقلة التسلسل التالي بدون TiDB:

```text
Vendor adapter
  ↓
Parsing + privacy gate + vendor-specific dedupe identity
  ↓
Sanitized durable ingest (fsync)
  ↓
ACK eligibility
  ↓
Canonical punch processing
```

- لا raw ATTLOG جديد في التخزين الدائم.
- السجل غير المعروف/غير الآمن يُحفظ عنه metadata آمنة فقط ولا يحصل على success ACK.
- فشل إنشاء Canonical Punch بعد الحفظ لا يفقد المصدر؛ startup replay يعيد المحاولة idempotently.
- لا يوجد worker/attendance/finance integration في هذا المسار.
