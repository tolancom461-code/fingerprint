# إعادة فحص TiDB — 2026-08-30

## النطاق

فحص قراءة فقط للقاعدة الفعلية قبل أي تصميم أو تنفيذ جديد داخل `biometric-service`.

## النتيجة المثبتة

قاعدة التطبيق الحالية ما زالت تحتوي الجداول البيومترية القديمة التالية:

```text
biometric_devices
biometric_raw_events
biometric_worker_mappings
```

وتم التأكد من عدد الصفوف:

```text
biometric_devices          = 0
biometric_raw_events       = 0
biometric_worker_mappings  = 0
```

كما أُعيدت قراءة `SHOW CREATE TABLE` للجداول الثلاثة ولم يظهر تغيير بنيوي عن فحص 2026-08-29.

## التصنيف

- `biometric_devices`: Legacy/main-database table. ما زال unique على `serial_number` وحده ولا يحتوي `vendor`.
- `biometric_raw_events`: Legacy integration shape؛ يحتوي `attendance_event_id` وnormalized enum محدودًا بالدخول/الخروج/unknown.
- `biometric_worker_mappings`: Legacy integration shape؛ يحتوي `worker_id` مباشرة.

هذه الجداول **لا تعتمدها الخدمة المستقلة الجديدة** ولا يتم تعديلها في هذه المرحلة.

## أثر ذلك على schema.ts

نسخة `schema.ts` المرفوعة في 2026-08-30 لم تكن تحتوي تعريفات الجداول الثلاثة رغم وجودها فعليًا في TiDB. تم تجهيز نسخة schema محدثة تعكس الأعمدة والقيود والفهارس الفعلية لهذه الجداول كمرآة للواقع الحالي فقط. هذا لا يحولها إلى تصميم `biometric-service` المستقبلي.

## تصميم الخدمة المستقلة

التصميم المستقبلي المملوك حصريًا لـ`biometric-service` محفوظ في:

```text
database/PROPOSED_SCHEMA_V1_NOT_APPLIED.sql
```

وهو غير منفذ وغير موصول بالـruntime. أي DDL أو اتصال TiDB يحتاج موافقة منفصلة.
