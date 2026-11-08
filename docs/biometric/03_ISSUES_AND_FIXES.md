# سجل الأخطاء والمخاطر والإصلاحات

## I-001 — Prototype القديم يكتب للحضور والمالية

**الخطر:** مسار قديم يمكنه تسجيل `attendance_events` وتحديث العامل واستدعاء المالية.  
**المعالجة:** عدم استخدامه للجهاز الحقيقي؛ الخدمة الجديدة مستقلة؛ التنظيف مؤجل للبوابة الإلزامية.

## I-002 — Migration قديم عند Startup

**الخطر:** `runBiometricMigration()` في المسار القديم قد يغير DB أثناء تشغيل البرنامج الحالي.  
**المعالجة:** ممنوع استخدامه كمسار تطوير جديد. الإزالة لاحقًا فقط بعد cleanup approval.

## I-003 — تفسير Status/Verify كان افتراضًا

**المعالجة:** أُغلق هذا الخطر للجهاز الحالي بعد اختبارات حقيقية. المappings موثقة في `09_ATTLOG_FIELD_MAPPING.md`، لكنها تبقى device/firmware-specific.

## I-004 — ACK واحد لكل شيء سبب Loop

في v0.4، observe العالمي جعل OPTIONS يفشل ويعاد تقريبًا كل 15 ثانية.  
**الإصلاح:** فصل control-plane ACK عن ATTLOG في v0.5.

## I-005 — OPERLOG غير معروف منع الجهاز من التقدم

v0.5 رأى OPERLOG لكنه لم يفهمه، فكرره الجهاز.  
**الإصلاح:** v0.6 parser آمن مع redaction/discard؛ 36/36 OPLOG قُبلت وانتقل الجهاز إلى polling.

## I-006 — إعادة ATTLOG عند عدم ACK

الجهاز أعاد نفس punch تقريبًا كل 5 ثوانٍ.  
**الإصلاح:** dedupe محلي + ACK اختياري بعد durable local capture. سلوك ACK ثبت على الجهاز.

## I-007 — Dedupe DB غير محسوم

`event_key` و`wire_hash` لهما أهداف مختلفة، والجدول القديم `biometric_raw_events` يفرض `UNIQUE(payload_hash)`.  
**المعالجة:** لا اعتماد UNIQUE جديد قبل database reconciliation واختبارات DB idempotency.

## I-008 — Overlay patch ترك ملفات قديمة بعد rename

بعد v0.4 بقيت ملفات renamed فأفشلت الاختبارات.  
**الإصلاح:** أي patch مستقبلي يحتوي قائمة حذف صريحة؛ لا يعتمد على overlay فقط.

## I-009 — `biometric_devices` لا يطابق Multi-Vendor identity

DB الحالية تجعل `serial_number` فريدًا وحده ولا تحتوي `vendor`.  
**المعالجة:** لا ALTER حاليًا؛ موثق كقرار مصالحة لاحق.

## I-010 — `biometric_raw_events` يتداخل مع `biometric_punches`

الجدول موجود وفارغ، لكنه:

- لا يحتوي vendor؛
- يحصر normalized type في check_in/check_out/unknown؛
- يربط `attendance_event_id`؛
- يستخدم string للوقت المحلي؛
- يفرض unique payload hash.

**المعالجة:** أوقف إنشاء `biometric_punches` حتى فحص مراجع الكود واتخاذ قرار صريح.

## I-011 — `biometric_worker_mappings` يربط العامل مبكرًا

الجدول موجود وفارغ ويحتوي `worker_id`.  
**المعالجة:** لا تستخدمه الخدمة المستقلة قبل تحديد هل هو Legacy فقط أم مطلوب لاحقًا بعد cleanup/integration.

## I-012 — اختلاف Collation بين جداول البصمة

`biometric_devices` = `utf8mb4_bin`، بينما raw events/mappings = `utf8mb4_unicode_ci`.  
**المعالجة:** يسجل كعنصر مصالحة؛ لا ALTER بدون موافقة.

## I-013 — Duplicate Punch Period على الجهاز

الجهاز يمنع الحركة الثانية خلال دقيقة. محاولة Check-Out المبكرة أعطت `Duplicate Punch`. بعد الانتظار أكثر من دقيقة تم تسجيلها بنجاح.  
**المعالجة:** أي protocol test متتالٍ يجب أن يحترم الفترة أو يغير الإعداد فقط بقرار اختبار صريح.

## I-014 — Punch State غير محدد

عندما لا تكون حالة Punch محددة، ظهر `rawStatus=255`.  
**المعالجة:** لا نحوله إلى check-in/out بالحدس. يحفظ كـunspecified/unknown حتى طبقة policy لاحقة.

## I-015 — QR الحالي للنظام يجب ألا يختلط بميزة QR في الجهاز

الجهاز يعلن دعم QR، لكن الاختبار أُلغي. QR الخاص بالنظام الحالي يبقى خارج الخدمة المستقلة وممنوع لمسه.

---

# مشاكل وإصلاحات 2026-09-07

## I-016 — Web Bridge target unavailable

**الاختبار:** target مؤقت `http://127.0.0.1:1`.

**المشاهدة:**

```text
web bridge error (TypeError): fetch failed
```

**الإثبات:** cursor بقي `120001`، وبعد إعادة target الصحيح أرسل الحدث مرة واحدة وTiDB أظهرت `import_count=1`.

**الحالة:** مغلق / behavior صحيح.

## I-017 — افتراض اسم عمود attendance من خارج TiDB

استعلام تحقق أول استخدم `a.attendance_time` وفشل:

```text
Unknown column 'a.attendance_time' in 'field list'
```

**الإصلاح:** قراءة بنية `attendance_events` من TiDB الفعلية؛ الاسم الصحيح المستخدم في التحقق كان `event_time`.

**القاعدة الناتجة:** TiDB الفعلية هي source of truth؛ لا نفترض من Drizzle.

## I-018 — Task Scheduler لا يعيد Node بعد crash simulation

رغم:

```text
RestartCount    = 999
RestartInterval = PT1M
```

قتل `node.exe` أدى إلى task `Ready` دون restart. سجل Task Scheduler Operational أظهر return code `4294967295` ثم اعتبر action مكتملة.

**الإصلاح:** عدم الاعتماد على Task Scheduler كحل supervision نهائي؛ الانتقال إلى WinSW Windows Service.

## I-019 — Installer v1 فشل على `.Count`

أول تنفيذ installer توقف عند:

```text
The property 'Count' cannot be found on this object.
```

السبب: PowerShell أعاد عنصر port واحد scalar بدل collection.

**الإصلاح في v2:** wrap explicit `@(...)` لنتائج فحص المنافذ، وتحسين rollback وحماية deployment directory.

**أمان الفشل:** WinSW لم يُثبت في ذلك التنفيذ، Task Scheduler القديم تم الحفاظ/الاستعادة عليه، ولا SQL ولا reboot.

## I-020 — فحص الخدمة مباشرة بعد Windows restart أعطى `Stopped`

الفحص المبكر بعد reboot رأى:

```text
Stopped TolanBiometricService
```

لكن WinSW wrapper log أثبت أن delayed auto start بدأ الخدمة تلقائيًا عند `2026-09-07 14:21:14` وشغل PID `4404`.

**المعالجة التشغيلية:** بعد Windows boot، أعط delayed-auto-start وقتًا مناسبًا ثم افحص `Get-Service` والمنافذ قبل اعتبار startup فاشلًا.

## I-021 — منع التشغيل المزدوج

بعد نجاح WinSW تم التحقق أن Windows Service `Running` وأن Task Scheduler القديم `Disabled`.

**الحالة:** مغلق؛ لا يوجد listener مزدوج على 9095/9096/9097.
