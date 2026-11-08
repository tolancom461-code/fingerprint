# تصميم قاعدة بيانات نظام البصمة — حالة الاعتماد بعد فحص 2026-08-29

> **تنبيه:** اسم الملف تاريخي. لا يمثل إذنًا حاليًا لتنفيذ DDL. أي تصميم Punch جديد متوقف حتى مصالحة الجداول الموجودة فعليًا في TiDB.

## ما هو موجود فعليًا

```text
biometric_devices          exists, empty
biometric_raw_events       exists, empty
biometric_worker_mappings  exists, empty
```

لا يوجد `biometric_punches` ولا `biometric_device_users` في القاعدة وقت آخر فحص.

## `biometric_devices`

الجدول موجود. بنية `SHOW CREATE TABLE` موثقة حرفيًا في `10_DATABASE_INSPECTION_2026-08-29.md`.

النقاط الإيجابية:

- سجل مستقل للأجهزة؛
- firmware/platform/IP/timezone/status fields؛
- لا FK للحضور.

النقطة غير المحسومة:

- Unique على serial فقط، بينما المعمارية الجديدة تريد vendor+serial.

## `biometric_raw_events`

هذا الجدول يتداخل مباشرة مع الدور الذي كان مقترحًا لـ`biometric_punches`. لذلك لا ننشئ جدولًا رابعًا قبل قرار المصالحة.

## التصميم الورقي المقترح للـPunch — غير منفذ

الحقول التي أثبتتها البيانات الحقيقية وتحتاج أن يمثلها أي تصميم نهائي:

```text
id
vendor
serial_number
device_id (optional logical registry link)
device_user_id
device_event_time
raw_status
normalized punch_state
raw_verify
normalized verification_method
work_code
raw/extra fields as needed
raw ATTLOG evidence
event_key / wire_hash or equivalent idempotency evidence
parser_version
parse_valid
received_at
created_at
```

لا `worker_id` في سجل الحقيقة الخام، ولا `attendance_event_id` في النواة المستقلة.

## قرار مؤجل

يجب أولًا:

1. فحص مراجع الكود للجداول الموجودة.
2. تحديد هل `biometric_raw_events` Legacy أم مستخدم.
3. مقارنة الحقول مع ATTLOG الحقيقي.
4. اعتماد strategy واحد فقط للتخزين.
5. عرض DDL النهائي.
6. موافقة صريحة منفصلة.

حتى ذلك الوقت: **لا تنفيذ**.
