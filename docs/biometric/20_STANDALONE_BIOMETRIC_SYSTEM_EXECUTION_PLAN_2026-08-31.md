# خطة التنفيذ المرجعية — نظام البصمة المستقل الكامل وواجهة النتائج النهائية

**المشروع:** TolanWorkforce / Biometric System  
**تاريخ الاعتماد:** 2026-08-31  
**النسخة الأساسية المجمدة:** `biometric-service v0.9.4`  
**حالة الجهاز المرجعي عند بدء الخطة:** `mode=test`, `status=active`, `timezone=Asia/Riyadh`, `accept_events_from=NULL`  
**نطاق هذه الخطة:** بناء نظام بصمة مستقل كامل له جداول وشاشات وإدارة وتشغيل ونتائج نهائية، ثم لاحقًا السماح للبرنامج الرئيسي بقراءة **النتائج النهائية فقط**.

> هذه الوثيقة هي مرجع التنفيذ للمرحلة التالية. لا يبدأ الربط مع البرنامج الرئيسي ولا يتحول الجهاز إلى `mode=live` قبل اجتياز جميع Gates المحددة هنا وموافقة صريحة جديدة.

---

## 1. القرار المعماري المعتمد

القرار المعتمد هو **عدم ربط جهاز البصمة أو طبقات الاستقبال والمعالجة الداخلية مباشرة بالبرنامج الرئيسي**.

المعمارية المستهدفة:

```text
Biometric devices
      ↓
Vendor adapters
      ↓
biometric-service ingest
      ↓
Canonical punches
      ↓
Standalone biometric management
      ↓
Identity resolution + validation
      ↓
FINAL BIOMETRIC EVENTS
      ↓
Read-only integration contract
      ↓
Main application attendance importer
```

ويترتب على ذلك:

1. نظام البصمة يملك دورة حياة البيانات البيومترية التشغيلية بالكامل.
2. البرنامج الرئيسي لا يعرف بروتوكول ZKTeco ولا `ATTLOG` ولا `raw_status` ولا `raw_verify`.
3. البرنامج الرئيسي لا يقرأ الجداول الداخلية مثل `biometric_svc_ingest_events` أو `biometric_svc_punches`.
4. البرنامج الرئيسي لا يكتب في أي جدول `biometric_svc_*`.
5. نقطة التكامل الوحيدة المستقبلية هي **Final Events Contract**، ويفضل أن تكون API قراءة فقط.
6. أي تكرار في القراءة من البرنامج الرئيسي يجب أن يكون آمنًا بفضل `final_event_id` ثابت وفريد.
7. توقف البرنامج الرئيسي لا يوقف استقبال البصمات؛ نظام البصمة يستمر بالحفظ والمعالجة مستقلًا.
8. تغيير Vendor أو إضافة أجهزة جديدة لا يجب أن يجبر البرنامج الرئيسي على أي تعديل طالما عقد Final Events ثابت.

---

## 2. ما تم إنجازه ويعتبر Baseline مجمدًا

`v0.9.4` ليست نقطة تطوير تجريبية؛ هي **Baseline معتمد** للخدمة المستقلة الحالية.

المثبت عمليًا حتى الآن:

- استقبال ADMS من ZKTeco SpeedFace-V5L الحقيقي.
- دعم identity = `vendor + serialNumber`.
- OPTIONS / OPERLOG / ATTLOG.
- Sanitized durable ingest إلى TiDB.
- Canonical punches.
- ACK بعد durable persistence.
- Deduplication/idempotency.
- Startup replay + periodic retry sweep.
- Timezone normalization من `Asia/Riyadh` إلى UTC.
- Device policy: `mode`, `status`, `accept_events_from`.
- Diagnostic sessions + log rotation.
- Privacy gate وعدم تخزين biometric templates أو صور أو Password/Card credentials.
- 97/97 automated tests.
- 4/4 architecture-boundary tests.
- اختبارات فعلية على الجهاز الحقيقي وTiDB الحقيقية.

الجداول الداخلية الحالية:

```text
biometric_svc_devices
biometric_svc_ingest_events
biometric_svc_event_processing
biometric_svc_punches
biometric_svc_device_users
```

هذه الجداول تظل **داخلية** لنظام البصمة ولا تصبح API للبرنامج الرئيسي.

---

## 3. الهدف النهائي للمرحلة الجديدة

إكمال نظام بصمة يمكن تشغيله وإدارته كمنتج مستقل قبل أي Bridge مع التطبيق الرئيسي.

عند نهاية المرحلة يجب أن يستطيع المشغل من داخل نظام البصمة وحده:

- معرفة الأجهزة المتصلة وحالتها وآخر اتصال.
- إدارة الأجهزة المسموح بها وحالتها التشغيلية.
- رؤية مستخدمي كل جهاز بصورة آمنة.
- ربط هوية مستخدم الجهاز بهوية أعمال مستقلة داخل نظام البصمة.
- مراجعة الحركات الخام المنقحة والـ canonical punches.
- رؤية الحركات المرفوضة أو غير المحسومة وأسبابها.
- إصدار Final Events موحدة وثابتة.
- البحث والتصفية والتدقيق في Final Events.
- مراقبة retry/errors/diagnostics.
- تشغيل النظام بدون الحاجة إلى البرنامج الرئيسي.

ثم يصبح البرنامج الرئيسي مجرد **Consumer** للـ Final Events.

---

## 4. حدود المسؤوليات

### 4.1 مسؤولية نظام البصمة

نظام البصمة مسؤول عن:

- الاتصال بالأجهزة.
- Vendor adapters.
- Parsing والتحقق من سلامة البيانات.
- Privacy filtering.
- Durable ingest.
- Deduplication.
- Canonicalization.
- Device registry.
- Device-user registry.
- Identity resolution داخل نطاق البصمة.
- Validation قبل finalization.
- Final Events.
- Audit/diagnostics.
- واجهات الإدارة الخاصة بالبصمة.

### 4.2 مسؤولية البرنامج الرئيسي

البرنامج الرئيسي، في مرحلة الربط المستقبلية فقط، مسؤول عن:

- قراءة Final Events.
- ربط `external_person_reference` بسجل العامل الحقيقي حسب عقد التكامل المتفق عليه.
- تطبيق سياسات الورديات والحضور والتأخير والإضافي.
- QR attendance.
- Finance/payroll.
- أي قواعد أعمال لا تخص جهاز البصمة نفسه.

### 4.3 ممنوع على نظام البصمة

حتى بعد اكتمال النظام المستقل:

- لا يكتب مباشرة إلى `workers`.
- لا يكتب مباشرة إلى `attendance_events`.
- لا يشغل finance/payroll.
- لا يعدل shifts.
- لا يدمج QR.
- لا يخزن biometric templates.

---

## 5. نموذج البيانات المستقبلي — تصميم مبدئي فقط

> الأسماء التالية **مقترحة للتصميم** وليست أوامر SQL معتمدة. أي جدول جديد يمر بمرحلة تصميم، ثم مراجعة، ثم SQL واحد في كل مرة ينفذه المشغل يدويًا.

### 5.1 `biometric_svc_people` أو اسم معتمد لاحقًا

يمثل هوية الشخص داخل نظام البصمة، وليس worker row من البرنامج الرئيسي.

حقول مبدئية:

```text
id
public_id / person_key
display_name
external_person_reference   nullable
status
notes
created_at
updated_at
```

`external_person_reference` يكون معرفًا خارجيًا آمنًا يمكن للبرنامج الرئيسي فهمه لاحقًا، ولا يعني وجود Foreign Key على جدول workers.

### 5.2 `biometric_svc_person_device_users`

يربط person داخليًا بمستخدم جهاز أو أكثر.

```text
person_id
device_user_id row reference
active_from
active_to
status
created_at
updated_at
```

الهدف:

- نفس الشخص يمكن أن يكون له user ID على أكثر من جهاز.
- لا يتم تعديل canonical punch الأصلي لإخفاء هوية الجهاز الأصلية.
- الربط قابل للتدقيق والتاريخ.

### 5.3 `biometric_svc_final_events`

هذا هو **حد النظام الخارجي** المستقبلي.

حقول مبدئية:

```text
id                        monotonic internal cursor
final_event_uuid          globally unique immutable ID
person_id
external_person_reference
event_type                check_in/check_out/break_out/break_in/overtime_in/overtime_out/...
event_time_local
event_timezone
event_time_utc
source_punch_id
device_id
device_reference
verification_method
finalization_version
finalized_at
status                    final / superseded / voided only if correction model is approved
supersedes_final_event_id nullable
safe_metadata             JSON, tightly controlled
created_at
```

قواعد أساسية:

- Final Event لا يحتوي raw payload.
- لا يحتوي template أو secret.
- `final_event_uuid` لا يتغير.
- لا يعاد استخدام نفس ID لحدث آخر.
- نفس `source_punch_id` لا ينتج Final Event مكرر لنفس finalization version.
- التعديلات المستقبلية لا تمسح التاريخ؛ تستخدم correction/supersede model إذا اعتمد لاحقًا.

### 5.4 جداول إضافية محتملة

قد نحتاج لاحقًا، فقط إذا أثبتت الحاجة:

- `biometric_svc_finalization_issues`
- `biometric_svc_audit_log`
- `biometric_svc_admin_users` إذا قررنا Authentication مستقلًا داخل النظام
- `biometric_svc_device_commands` إذا بدأنا إرسال أوامر للأجهزة مستقبلًا

لا تُنشأ هذه الجداول لمجرد أنها ممكنة؛ كل جدول يحتاج Use Case وGate.

---

## 6. تعريف Final Event

Final Event هو **نتيجة نظيفة نهائية من نظام البصمة**، وليس حكم حضور/غياب كامل.

مثال:

```json
{
  "finalEventId": "...",
  "externalPersonReference": "EMP-00123",
  "eventType": "check_in",
  "eventTimeLocal": "2026-08-31T09:44:05",
  "timezone": "Asia/Riyadh",
  "eventTimeUtc": "2026-08-31T06:44:05Z",
  "deviceReference": "zkteco:AJE1261900133",
  "verificationMethod": "fingerprint",
  "finalizedAt": "..."
}
```

هذا الحدث يقول فقط:

> الشخص المرجعي X قام بحركة `check_in` موثوقة في الوقت Y من الجهاز Z.

ولا يقول:

- هل الموظف متأخر؟
- كم ساعة عمل؟
- هل يستحق overtime مالي؟
- أي shift ينطبق؟
- ما أثره على payroll؟

هذه أسئلة البرنامج الرئيسي.

---

## 7. Finalization pipeline

المسار المستهدف:

```text
biometric_svc_ingest_events
      ↓
biometric_svc_punches
      ↓
identity resolution
      ↓
validation rules
      ↓
finalization decision
      ↓
biometric_svc_final_events
```

### 7.1 شروط أساسية لإنشاء Final Event

مبدئيًا:

- canonical punch موجود وصالح.
- device policy تسمح بالحركة.
- event type معروف أو معتمد.
- device user مرتبط بشخص واحد فقط.
- الشخص active.
- الوقت قابل للتفسير وله timezone صحيحة.
- لا يوجد Final Event سابق لنفس source/version.

### 7.2 إذا لم تكتمل الشروط

لا نفقد الحركة ولا نخمن.

تذهب إلى حالة مثل:

```text
unresolved_identity
unknown_event_type
invalid_time
conflicting_mapping
manual_review_required
```

وتظهر في شاشة Exceptions/Review.

---

## 8. الشاشات المطلوبة في النظام المستقل

### شاشة 1 — Dashboard

تعرض على الأقل:

- عدد الأجهزة active/disabled/offline.
- آخر اتصال لكل جهاز.
- عدد punches اليوم.
- عدد Final Events اليوم.
- unresolved events.
- retry/failed processing.
- آخر أخطاء مهمة.

لا تعرض بيانات حساسة بيومترية.

### شاشة 2 — Devices

وظائف:

- قائمة الأجهزة.
- vendor / serial / model / firmware / platform.
- IP الأخير.
- last_seen / last_event.
- timezone.
- mode / status.
- capabilities الآمنة.
- صفحة تفاصيل جهاز.

أي تغيير تشغيلي حساس مثل `status` أو `mode` يحتاج Confirmation + Audit.

### شاشة 3 — Device Users

- المستخدمون الذين ظهروا على كل جهاز.
- `device_user_id`.
- display name الآمن إن توفر.
- أول/آخر ظهور.
- حالة الربط بشخص.
- تصفية: mapped / unmapped / conflict.

### شاشة 4 — People / Identity Mapping

- الأشخاص داخل نظام البصمة.
- external reference.
- ربط مستخدم أو أكثر من أجهزة مختلفة بالشخص.
- منع mapping متعارض.
- سجل تاريخ التغييرات.

### شاشة 5 — Punches

- canonical punches.
- الوقت المحلي + UTC.
- الجهاز.
- user id.
- raw status/verify كبيانات تشخيصية آمنة.
- normalized state/method.
- حالة finalization.

### شاشة 6 — Final Events

- النتائج النهائية فقط.
- final event ID.
- الشخص / external reference.
- event type.
- times.
- device.
- verification method.
- finalized_at.
- حالة correction إن اعتمدت لاحقًا.

هذه الشاشة تمثل نفس البيانات التي ستتاح لاحقًا للبرنامج الرئيسي.

### شاشة 7 — Exceptions / Review Queue

- punch غير مربوط بشخص.
- mapping conflict.
- unknown status/verify.
- time problem.
- finalization error.
- retry exhaustion.

يجب أن يكون سبب المنع واضحًا وقابلاً للتدقيق.

### شاشة 8 — Diagnostics / Operations

- session ID.
- service version.
- DB health.
- retry status.
- recent safe diagnostic events.
- device connectivity.
- log rotation state.

لا تعرض raw secrets أو templates.

### شاشة 9 — Settings / Policies

فقط إعدادات النظام البيومتري:

- timezone defaults.
- finalization policy versions.
- device state/mode controls.
- retention policy لاحقًا.

لا تحتوي attendance/payroll business rules.

---

## 9. واجهة التكامل المستقبلية مع البرنامج الرئيسي

### 9.1 المبدأ

البرنامج الرئيسي يقرأ Final Events فقط.

الواجهة المفضلة:

```text
Read-only HTTPS API
```

بديل أقل تفضيلاً عند وجود سبب تشغيلي واضح:

```text
Read-only DB view / replica contract
```

لكن لا يسمح بالقراءة المباشرة من internal tables.

### 9.2 API مبدئية

مثلاً:

```text
GET /api/v1/final-events?after_id=12345&limit=500
GET /api/v1/final-events/{finalEventUuid}
GET /api/v1/health
```

لا توجد في عقد البرنامج الرئيسي:

```text
POST /final-events
PUT /final-events
DELETE /final-events
```

### 9.3 Cursor/idempotency

البرنامج الرئيسي يحتفظ على جانبه بآخر cursor أو source ID تمت معالجته.

ويجب أن يكون لديه Unique Constraint منطقي على:

```text
source_system = biometric
source_event_id = finalEventUuid
```

وبذلك إذا أعاد قراءة نفس Final Event عشر مرات لا تتكرر حركة الحضور.

### 9.4 Authentication

قبل الربط الحقيقي تعتمد آلية مثل:

- service credential مخصص read-only.
- TLS.
- token rotation.
- network allowlisting إن أمكن.

ولا يعاد استخدام Secrets من خدمات أخرى.

---

## 10. خطة التنفيذ المرحلية

## Phase 0 — Freeze baseline

**الهدف:** حماية `v0.9.4` كنقطة مرجعية.

المهام:

- [x] إغلاق وتوثيق v0.9.4.
- [x] إبقاء الجهاز `mode=test`.
- [x] عدم ربط البرنامج الرئيسي.
- [ ] إنشاء branch/version واضح لتطوير المرحلة الجديدة.

**Gate:** لا تعديل على baseline عند بدء التطوير بدون إصدار جديد.

---

## Phase 1 — Architecture & DB design for standalone management

**الهدف:** اعتماد نموذج people/mapping/final events قبل كتابة الواجهة.

المهام:

- تصميم lifecycle للهوية.
- تصميم جداول الأشخاص والربط والـ Final Events.
- تصميم correction model أو تأجيله صراحة.
- تصميم indexes/idempotency.
- مراجعة privacy/data minimization.
- مراجعة multi-device/multi-vendor implications.

**DB Rule:** لا SQL تلقائي. يعرض SQL للمشغل **أمرًا واحدًا في كل مرة** بعد الموافقة.

**Gate:** SHOW CREATE لكل جدول جديد يطابق التصميم المعتمد.

---

## Phase 2 — Standalone management backend

**الهدف:** إضافة Application/API داخلي يخدم شاشات نظام البصمة فقط.

المهام:

- Device queries.
- Device-user queries.
- People CRUD داخل نطاق البصمة.
- Mapping operations مع conflict protection.
- Punch queries.
- Exception queries.
- Audit trail للعمليات الإدارية.

**ممنوع:** أي import من main app أو write إليه.

**Gate:** unit/integration tests + boundary tests.

---

## Phase 3 — Standalone UI shell + Operations screens

**الهدف:** تشغيل النظام وإدارته بدون SQL يدوي للحياة اليومية.

الترتيب المقترح:

1. Dashboard.
2. Devices.
3. Device Users.
4. Punches.
5. Diagnostics.

**Gate:** كل شاشة تعمل على بيانات حقيقية من الخدمة المستقلة ولا تحتاج main app.

---

## Phase 4 — People & Identity Mapping UI

**الهدف:** تحويل device-user identity إلى person identity مدارة وآمنة.

المهام:

- إنشاء الشخص.
- external reference اختياري/مطلوب حسب القرار النهائي.
- mapping user ↔ person.
- multi-device mapping.
- conflict detection.
- unmapped queue.
- audit.

**Gate:** لا Final Event لشخص غير محسوم الهوية.

---

## Phase 5 — Finalization engine

**الهدف:** إنتاج Final Events بشكل deterministic/idempotent.

المهام:

- finalization rules.
- finalization version.
- idempotency.
- retry.
- unresolved reasons.
- event source traceability.
- historical backfill policy إن لزم، بعد موافقة مستقلة.

**Gate:** نفس punch لا ينتج Final Event مكرر.

---

## Phase 6 — Final Events UI + review workflow

**الهدف:** يستطيع المشغل رؤية ما سيصل مستقبلًا للبرنامج الرئيسي قبل وجود أي Bridge.

المهام:

- Final Events list/detail.
- unresolved queue.
- filters/export آمن إن اعتمد.
- correction workflow فقط إذا تم اعتماد النموذج.

**Gate:** المشغل يستطيع تفسير كل Final Event إلى مصدره، والعكس.

---

## Phase 7 — Read-only Final Events API

**الهدف:** بناء عقد التكامل بدون توصيل البرنامج الرئيسي بعد.

المهام:

- versioned API.
- cursor pagination.
- stable schema.
- auth.
- rate limits حسب الحاجة.
- contract tests.
- backward compatibility policy.

**Gate:** consumer simulator يقرأ الأحداث ويعيد القراءة بدون duplication.

---

## Phase 8 — Standalone end-to-end acceptance

**الهدف:** إثبات النظام المستقل كاملًا.

اختبارات فعلية مطلوبة:

- device online/offline/reconnect.
- check-in/out.
- break states.
- overtime states.
- duplicate retransmission.
- service restart/replay.
- DB temporary failure/retry.
- unmapped device user.
- mapping ثم finalization.
- multi-user.
- device disabled/maintenance.
- old event cutoff.
- timezone.
- Final Events cursor replay.
- UI review/audit.

عند توفر جهاز ثانٍ:

- multi-device physical validation.

وعند توفر Vendor ثانٍ:

- physical multi-vendor validation.

**Gate:** تقرير إغلاق مستقل جديد للـ Standalone Management System.

---

## Phase 9 — Integration design only

**الهدف:** تصميم Consumer داخل البرنامج الرئيسي، بدون تفعيله إنتاجيًا.

المخرجات:

- Final Events API contract frozen.
- mapping from final event to attendance import DTO.
- consumer idempotency design.
- retry/cursor ownership.
- monitoring.
- failure handling.
- regression plan للـ attendance/QR/shifts/finance/payroll.

**Gate:** موافقة صريحة جديدة قبل لمس main app.

---

## Phase 10 — Main application bridge (Future / separate approval)

لا تبدأ هذه المرحلة تلقائيًا.

عند الموافقة فقط:

```text
Main app
  ↓ GET only
Final Events API
  ↓
Attendance import boundary
  ↓
Existing attendance business rules
```

ثم بعد نجاح integration/regression tests فقط يتم تقييم تغيير الجهاز من:

```text
mode=test
```

إلى:

```text
mode=live
```

**التحويل إلى `live` Gate تشغيل مستقل، وليس خطوة تطوير تلقائية.**

---

## 11. قواعد UI/UX

- الشاشات البيومترية تبقى منفصلة عن شاشات البرنامج الرئيسي.
- لا تظهر templates أو صور حيوية.
- تعرض device/user identifiers بقدر الحاجة التشغيلية فقط.
- كل حالة خطأ لها نص مفهوم للمشغل.
- التوقيت المحلي يعرض باسم المنطقة `Asia/Riyadh`، مع UTC عند الحاجة التشخيصية.
- العمليات المؤثرة على device `mode/status` تحتاج confirmation.
- أي تعديل mapping أو person يحتاج audit.
- النظام لا يخفي البيانات غير المحسومة؛ يظهرها في queue واضحة.

---

## 12. الأمن والخصوصية

قواعد ملزمة:

1. لا biometric template storage.
2. لا face/palm/fingerprint images.
3. لا password credential storage.
4. لا card credential storage إذا كان حساسًا؛ verification method فقط عند الحاجة.
5. Safe diagnostics فقط.
6. Secrets في environment/secret store، لا logs.
7. Final Events أقل قدر من البيانات اللازمة للتكامل.
8. Role/access model للشاشات الإدارية قبل الإنتاج.
9. Audit للعمليات الإدارية الحساسة.
10. Retention policy تعتمد لاحقًا لكل فئة بيانات بدل الاحتفاظ المفتوح بلا قرار.

---

## 13. Multi-device / Multi-vendor requirements

لا يُسمح للتطوير القادم أن يحول النظام إلى حل ZKTeco-only.

قواعد:

- Core لا يعرف معاني vendor raw codes.
- Adapter يملك mapping/normalization profile.
- identity للجهاز = vendor + serial.
- person mapping لا يعتمد على Vendor واحد.
- Final Events vendor-neutral.
- UI تعرض vendor metadata لكن لا تبني منطق الأعمال عليها.
- إضافة Vendor جديد لا تتطلب تغيير Final Events contract إلا إذا كان هناك capability جديدة معتمدة ومبررة.

---

## 14. Strategy للنسخ والإصدارات

مقترح:

- `v0.9.4` = closed ingest/canonical baseline.
- `v0.10.x` = standalone management foundations.
- `v0.11.x` = people/mapping/finalization.
- `v0.12.x` = standalone UI + final events API stabilization.
- `v1.0.0` = standalone biometric system accepted and frozen before main-app bridge.

هذه أرقام إرشادية ويمكن تعديلها، لكن يجب ألا نخلط تغييرات كبيرة في إصدار واحد بدون Gate.

---

## 15. اختبارات الجودة الإلزامية لكل إصدار

قبل تسليم أي نسخة:

- unit tests.
- DB adapter tests.
- boundary/isolation tests.
- privacy tests.
- idempotency tests.
- timezone tests إذا مس الوقت.
- UI/API tests للأجزاء الجديدة.
- syntax/lint/type checks المتاحة.
- لا migrations runtime.
- package/version/documentation update.

وعند تغييرات البروتوكول أو ACK أو vendor adapter:

- real-device test مطلوب بسبب ارتفاع المخاطر.

---

## 16. سياسة تغييرات قاعدة البيانات

مصدر الحقيقة هو TiDB الفعلية.

أي DB change:

1. تصميم مكتوب.
2. مراجعة سبب التغيير.
3. عرض SQL واحد فقط.
4. المشغل ينفذه يدويًا.
5. يرسل النتيجة.
6. التحقق بـ `SHOW CREATE TABLE` أو query مناسب.
7. بعدها فقط تحديث schema المحلي/الوثائق.

ممنوع على الخدمة إنشاء/تعديل/حذف الجداول runtime.

---

## 17. سياسة التصحيح والتاريخ

Final Events يجب أن تكون قابلة للتدقيق.

مبدئيًا نرفض:

- تعديل Final Event في مكانه بدون أثر.
- حذف حدث نهائي لإخفاء التاريخ.
- إعادة استخدام UUID.

إذا احتجنا تصحيحًا، نعتمد لاحقًا نموذجًا مثل:

```text
original final event
      ↓
superseding correction event
```

لكن لا ننفذ correction model قبل تحديد احتياج الأعمال بدقة.

---

## 18. معايير إغلاق المرحلة الجديدة

لا نعتبر نظام البصمة المستقل الكامل منتهيًا إلا إذا:

- الأجهزة تُدار من UI.
- device users مرئيون ومدارون.
- people/mapping يعملان.
- unresolved queue موجودة.
- Final Events تصدر idempotently.
- Final Events UI تعمل.
- read-only API مستقرة ومختبرة.
- restart/retry/replay مثبت.
- privacy tests ناجحة.
- no main-app writes مثبتة.
- backup/restore أو recovery procedure موثقة للبيانات الحرجة.
- operations runbook محدث.
- تقرير إغلاق جديد مكتمل.
- الجهاز يبقى `mode=test` حتى موافقة الربط.

---

## 19. Definition of Done للربط المستقبلي

حتى بعد اكتمال نظام البصمة، لا يعتبر الربط ناجحًا إلا إذا:

- البرنامج الرئيسي يقرأ Final Events فقط.
- إعادة القراءة لا تنشئ attendance duplicate.
- انقطاع أي طرف recoverable.
- لا writes عكسية إلى biometric DB.
- لا اعتماد على raw vendor values.
- attendance/QR/shifts/finance/payroll regression tests ناجحة.
- monitoring/cursor lag واضح.
- rollback plan موجود.

---

## 20. الحالة الحالية بعد اعتماد هذه الخطة

```text
Standalone ingest/canonical service   COMPLETE (v0.9.4)
Standalone management system          NOT STARTED
People/mapping                        NOT STARTED
Finalization engine                   NOT STARTED
Final Events                          NOT STARTED
Final Events read-only API            NOT STARTED
Main-app bridge                       NOT STARTED
Device mode                           test
```

### القرار التشغيلي الملزم

الجهاز المرجعي يبقى:

```text
mode   = test
status = active
```

ولا يتم تحويله إلى `live` إلا بعد:

1. اكتمال النظام المستقل الجديد.
2. إغلاقه بتقرير قبول.
3. اعتماد عقد Final Events.
4. تصميم واختبار Bridge منفصل.
5. Regression tests للتطبيق الرئيسي.
6. موافقة صريحة على التشغيل `live`.

---

## 21. أول خطوة تنفيذ بعد هذه الوثيقة

**لا نبدأ بالكود مباشرة.**

أول نشاط تنفيذي هو:

> تصميم واعتماد نموذج البيانات الجديد الخاص بـ **People / Device User Mapping / Final Events** مع مراجعة TiDB الحالية قراءة فقط.

بعد اعتماد التصميم فقط نبدأ SQL يدويًا، أمرًا واحدًا في كل مرة.

---

## 22. مرجعية الوثائق

عند أي تعارض في المرحلة القادمة يكون ترتيب المرجعية:

1. `20_STANDALONE_BIOMETRIC_SYSTEM_EXECUTION_PLAN_2026-08-31.md` — خطة المرحلة الجديدة.
2. `19_FINAL_CLOSURE_REPORT_2026-08-31.md` — Baseline v0.9.4 المثبت.
3. `01_CURRENT_STATUS.md` — الحالة التشغيلية المختصرة.
4. `00_BIOMETRIC_MASTER_PLAN.md` — المبادئ والحدود الأصلية.
5. TiDB الفعلية — الحقيقة بالنسبة للبنية والبيانات.
6. الكود والاختبارات في الإصدار الجاري.

**هذه الخطة لا تعطي أي موافقة ضمنية على لمس البرنامج الرئيسي أو تحويل الجهاز إلى live.**

---

## 23. Execution progress — 2026-08-31 / v0.10.0 foundations

تم تنفيذ الجزء الأول من الخطة بعد اعتماد التصميم:

- [x] إنشاء `biometric_svc_people` يدويًا والتحقق بـ SHOW CREATE TABLE.
- [x] إنشاء `biometric_svc_person_device_users` يدويًا والتحقق.
- [x] إنشاء `biometric_svc_final_events` يدويًا والتحقق.
- [x] إنشاء `biometric_svc_finalization_issues` يدويًا والتحقق.
- [x] إنشاء `biometric_svc_audit_log` يدويًا والتحقق.
- [x] تثبيت `person_code` كمعرف الشخص الموحد داخل نظام البصمة.
- [x] إضافة People store foundation.
- [x] إضافة Device User Mapping store foundation.
- [x] إضافة safe administrative audit store foundation.
- [x] إضافة application service للاقتراح والإنشاء والربط مع conflict protection.
- [ ] فتح Admin API للشاشات — الدفعة التالية بعد قبول v0.10.0 foundations.
- [ ] Finalization engine — لم يبدأ بعد.
- [ ] Main-app bridge — ممنوع في هذه المرحلة.

يبقى `v0.9.4` Baseline الإغلاق لخدمة ingest/canonical، و`v0.10.0` هو أول إصدار تطويري لStandalone Management Foundations.
