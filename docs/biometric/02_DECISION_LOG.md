# سجل القرارات المعمارية

> القرارات هنا تراكمية. أي قرار جديد يصحح فرضية قديمة يعتبر المرجع الأحدث.

## D-001 — الجهاز المرجعي القديم كان افتراضًا فقط

الـMB2000 كان مرجعًا مبكرًا للـPrototype وليس الجهاز الحقيقي النهائي. المرجع الفعلي المثبت منذ 2026-08-29 هو **ZKTeco SpeedFace-V5L / ZAM230 / AJE1261900133**.

## D-002 — لا نخزن قوالب أو صور بيومترية

لا FP/Face/Palm templates ولا BIODATA/BIOPHOTO/USERPIC raw content.

## D-003 — الخدمة مستقلة عن النظام الحالي

لا كتابة للحضور أو العمال أو المالية أو QR أو shifts في المرحلة الحالية.

## D-004 — Vendor Adapter Architecture

القلب محايد؛ ZKTeco Adapter أول فقط.

## D-005 — هوية الجهاز

الهوية المعمارية = `vendor + serialNumber`، مثال `zkteco:AJE1261900133`.

## D-006 — قاعدة TiDB الفعلية هي المرجع

لا يعتمد `drizzle/schema.ts` كحقيقة بنيوية.

## D-007 — لا تعديل DB تلقائي

كل DDL/DML يحتاج موافقة صريحة مستقلة.

## D-008 — Punch الخام لا يعتمد على Mapping عامل

`device_user_id` حقيقة من الجهاز؛ `worker_id` ارتباط خارجي لاحق.

## D-009 — ACK التفاوض منفصل عن ACK الحضور

OPTIONS/OPERLOG control-plane ACK لا يعني قبول ATTLOG.

## D-010 — OPERLOG الآمن فقط يُعتمد

القيم الحساسة تُحذف/تُحجب، والـunknown unsafe shape لا يحصل على success ACK.

## D-011 — لا نفسر Status/Verify قبل الدليل الحقيقي

تم الالتزام بذلك حتى اكتمال الاختبارات الفعلية.

## D-012 — `rawVerify` mapping هو Compatibility Profile خاص بالجهاز

على SpeedFace-V5L/firmware الحالي ثبت:

```text
1  fingerprint
3  password
4  card
15 face
25 palm
```

لا يعمم على أجهزة أو Vendors أخرى بدون اختبار.

## D-013 — `rawStatus` mapping هو Compatibility Profile خاص بالجهاز

ثبت:

```text
0 check_in
1 check_out
2 break_out
3 break_in
4 overtime_in
5 overtime_out
255 unspecified/no selected punch state in observed samples
```

## D-014 — Raw + normalized معًا

التخزين الدائم المستقبلي يجب أن يحافظ على `raw_status/raw_verify` وعلى تفسير Adapter منفصل، حتى لا نخسر الحقيقة الأصلية إذا تغير التفسير لاحقًا.

## D-015 — لا نضع worker_id داخل سجل الحقيقة الخام

الربط بالعامل يبقى جدول/طبقة مستقلة.

## D-016 — ACK إنتاجي بعد durable persistence فقط

نجاح ACK المحلي على الجهاز لا يبرر ACK قبل حفظ DB في الإنتاج.

## D-017 — dedupe الحالي مثبت على إعادة إرسال حقيقية

الجهاز أعاد نفس ATTLOG كل ~5 ثوانٍ في observe mode، والخدمة اكتشفته duplicate عبر إعادة التشغيل.

## D-018 — لا اعتماد UNIQUE DB جديد قبل مصالحة idempotency

كان هناك نقاش حول `event_key` و`wire_hash`. بعد اكتشاف `biometric_raw_events` مع `UNIQUE(payload_hash)`, لا يعتمد أي constraint جديد قبل قرار المصالحة.

## D-019 — الجداول البيومترية الموجودة لا تُستخدم تلقائيًا

وجود جدول فارغ لا يعني أنه مناسب للنظام الجديد. يلزم فحص تصميم ومراجع الكود قبل الاستخدام أو التعديل أو الحذف.

## D-020 — اكتشاف DB في 2026-08-29 يوقف إنشاء `biometric_punches`

تم إيقاف DDL المقترح بعد اكتشاف `biometric_raw_events` و`biometric_worker_mappings` في TiDB.

## D-021 — لا Foreign Keys لا تعني عدم وجود اعتماد برمجي

رغم عدم وجود FK، يجب فحص مراجع الكود قبل اتخاذ قرار في الجداول.

## D-022 — QR الجهاز غير داخل Compatibility Profile الحالي

OPTIONS أعلن `IsSupportQRcode=1`، لكن اختبار QR أُلغي باختيار صاحب المشروع. لا نسجل له mapping أو دعمًا مثبتًا.

## D-023 — Punch State من الجهاز أفضل من تخمين alternation

عندما يرسل الجهاز حالة صريحة نستخدمها. لا نعتمد قاعدة "الأول دخول والثاني خروج" كأساس عام، لأنها لا تتحمل التكرار والاستراحات وتعدد الشفتات.

## D-024 — تعدد الأجهزة قاعدة أساسية

جهاز واحد فاشل لا يجب أن يعطل بقية الأجهزة.

## D-025 — Vendor + Serial هو مفتاح الهوية المنطقي

يبقى القرار قائمًا حتى لو كان الجدول الحالي لا يطبقه بعد.

## D-026 — شركات جديدة عبر Adapters مستقلة

لا شروط vendor-specific داخل النواة.

## D-027 — الجهاز الحقيقي يسبق أي تصميم افتراضي

الحقول والمعاني تُبنى على traffic حقيقي.

## D-028 — Handshake query version وOPTIONS PushVersion حقائق منفصلة

`pushver=2.4.1` في query لا يستبدل `PushVersion=Ver 3.1.6S-20251028` في OPTIONS.

## D-029 — ACK separation مثبت عمليًا

v0.5 فصل OPTIONS عن ATTLOG؛ v0.6 أثبت OPERLOG ثم ATTLOG ACK الحقيقي.

## D-030 — نسخة الخدمة السابقة v0.6.0

آخر suite موثق: 46/46 passing.


## D-031 — v0.7 يفصل الحفظ الدائم عن الحركة الموحدة

الـACK الخاص بـATTLOG يعتمد على نجاح حفظ سجل استقبال آمن دائم أولًا، وليس على نجاح كل مراحل المعالجة اللاحقة.

## D-032 — منع التكرار يملكه Vendor Adapter

النواة لا تفترض صيغة عالمية لهوية الحدث. ZKTeco الحالي يستخدم استراتيجية `zkteco-attlog-v1`، ويمكن لأي Vendor مستقبلي استخدام رقم حركة أصلي أو استراتيجية مختلفة.

## D-033 — لا raw ATTLOG جديد في v0.7

السجلات الجديدة تحفظ wire hash والحقول المعروفة الآمنة فقط. السطر غير المعروف لا يُحفظ نصه، ولا يحصل على success ACK.

## D-034 — Canonical replay بعد الحفظ الدائم

إذا فشلت طبقة الحركة الموحدة بعد حفظ المصدر، يبقى المصدر قابلًا للاسترجاع، وتعيد الخدمة معالجة سجلات الاستقبال عند startup بصورة idempotent.

## D-035 — نسخة الخدمة السابقة v0.7.0

آخر suite محلي بعد التغيير: 52/52 passing. لم تُعد اختبارات الجهاز الحقيقي المثبتة في v0.6.


## D-036 — هوية التخزين الدائم يملكها القلب

`dedupeKey` يظل من مسؤولية Vendor Adapter، لكن مفتاح التخزين العالمي `ingestKey` يشتق من `vendor + serialNumber + dedupeStrategy + dedupeVersion + dedupeKey`. بذلك لا يُطلب من Vendor Adapter أن يضمن uniqueness عالميًا بين كل الأجهزة والشركات.

## D-037 — جداول TiDB القديمة لا تعتمدها الخدمة المستقلة

فحص 2026-08-30 أكد أن الجداول الثلاثة القديمة ما زالت موجودة وفارغة. يتم تمثيلها في نسخة schema المحدثة كحقيقة عن القاعدة الحالية فقط، بينما التصميم المستقبلي للخدمة يبقى في قاعدة منطقية مستقلة ولا يحتوي worker/attendance/finance links.

## D-038 — مخطط قاعدة الخدمة تصميم غير منفذ

`database/PROPOSED_SCHEMA_V1_NOT_APPLIED.sql` هو artifact مراجعة فقط. لا SQL dependency ولا اتصال TiDB ولا migration تلقائي في v0.8.

## D-039 — نسخة الخدمة الحالية v0.8.0

آخر suite محلي: 58/58 passing. لم تُعد اختبارات الجهاز الحقيقي لأن مسار ADMS wire protocol لم يتغير.

---

# قرارات 2026-09-07 — Web Bridge + Windows Service

## D-040 — TiDB الفعلية تبقى مصدر الحقيقة أثناء التكامل

لا يتم افتراض أسماء أعمدة أو بنية DB من Drizzle. عند اختلاف اسم عمود `attendance_events` تم الرجوع إلى TiDB الفعلية بقراءة `SHOW COLUMNS` وتصحيح الاستعلام بناءً عليها.

## D-041 — اتجاه الإنتاج هو outbound Web Bridge

Railway لا يعتمد على الوصول إلى loopback المحلي. الاتجاه المعتمد:

```text
biometric-service local -> outbound HTTPS -> https://www.tolanhr.com
```

## D-042 — Web Bridge cursor لا يتقدم عند failure

اختبار target غير متاح أثبت أن cursor بقي `120001` أثناء `fetch failed`، ثم تقدم إلى `150001` فقط بعد acknowledgement ناجح.

## D-043 — لا نعتمد Task Scheduler كـservice supervisor نهائي

Task Scheduler نجح في background/startup وتشغيل البصمات، لكنه لم يعد Process تلقائيًا بعد kill رغم إعداد restart policy. تم رفض workaround دوري مستمر لأنه لا يمثل service supervision المطلوبة.

## D-044 — WinSW هو wrapper Windows المعتمد محليًا

يتم تشغيل Node كـWindows Service حقيقية عبر WinSW:

```text
SCM -> WinSW -> node.exe -> biometric-service
```

## D-045 — مسار deployment ثابت للخدمة

Runtime المعتمد للخدمة:

```text
C:\Tolan\BiometricService
```

ولا يعتمد Windows Service النهائي على Desktop كمسار تشغيل.

## D-046 — Recovery يعيد الخدمة فقط ولا يعيد Windows

failure action المعتمد هو service restart. لا يوجد reboot/shutdown action في إعداد الخدمة أو installer.

## D-047 — Task Scheduler القديم يعطّل فقط بعد نجاح WinSW

لتجنب downtime أو duplicate listeners، installer يعطل المهمة القديمة فقط بعد:

- تثبيت الخدمة.
- بدء الخدمة.
- نجاح health check للمنافذ 9095/9096/9097.

## D-048 — Windows Service تبدأ تلقائيًا مع delayed auto start

تم اعتماد Automatic + delayed auto start. لذلك الفحص المبكر جدًا بعد login قد يرى `Stopped` مؤقتًا قبل أن يبدأ SCM الخدمة.

## D-049 — الجهاز يبقى `mode=test` بعد إغلاق مرحلة الجهاز المحلي

نجاح الإنتاج/Windows Service لا يعني go-live mode. تغيير mode يحتاج موافقة صريحة مستقلة.
