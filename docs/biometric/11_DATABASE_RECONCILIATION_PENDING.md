# Database Reconciliation — Pending Approval

## لماذا هذه الوثيقة موجودة؟

كان الاتجاه قبل فحص TiDB هو إنشاء `biometric_punches`. بعد الفحص اتضح أن `biometric_raw_events` موجود أصلًا وفارغ وله دور متداخل جدًا. إنشاء جدول رابع الآن قد يخلق ازدواجية معمارية.

لذلك: **التصميم الورقي محفوظ، التنفيذ متوقف.**

## 1. المقارنة

| الحاجة المثبتة | `biometric_raw_events` الحالي | التصميم الجديد المطلوب |
|---|---|---|
| vendor | غير موجود | مطلوب للـMulti-Vendor |
| serial | `device_serial` | مطلوب |
| device user | موجود varchar(50) | موجود، وربما يحتاج طولًا أوسع |
| event time | varchar(32) | يفضل datetime مناسب + raw evidence |
| raw status | موجود | مطلوب |
| all six states | enum لا يدعمها | يجب دعم 0..5 + unspecified/unknown |
| raw verify | لا يوجد فصل صريح | مطلوب |
| normalized method | `verify_mode` غامض | واضح `verification_method` |
| work code | موجود | مطلوب raw |
| exact raw line/payload | موجود text | مطلوب |
| idempotency hash | unique payload_hash | يحتاج إعادة تقييم |
| parser version | غير موجود | مفيد للتدقيق |
| parse validity | غير موجود | مفيد |
| received ms precision | timestamp | قد نحتاج ms precision |
| attendance link | موجود | غير مرغوب في النواة المستقلة |
| worker link | ليس داخل raw events | صحيح |

## 2. التصميم الورقي الذي وافق عليه صاحب المشروع كمفهوم

المفهوم: سجل Punch خام immutable يحفظ حقيقة الجهاز وتفسير Adapter معًا، ولا يحمل `worker_id` ولا يكتب attendance.

الحقول المقترحة مبدئيًا:

```text
id BIGINT
device_id nullable
vendor
serial_number
device_user_id
device_event_time
raw_status
punch_state
raw_verify
verification_method
work_code
delimiter
extra_fields/raw fields as needed
raw_line
event_key
wire_hash
parser_version
parse_valid
received_at
created_at
```

هذا **ليس DDL نهائيًا** بعد اكتشاف الجداول الحالية.

## 3. قرارات لا تزال مطلوبة

- هل نعيد تصميم `biometric_raw_events` ونستخدمه بدل `biometric_punches`؟
- هل نحافظ عليه Legacy وننشئ `biometric_punches` بعد cleanup؟
- هل نحتاج raw_fields JSON أم يكفي raw_line + parsed columns؟
- ما الـunique/idempotency constraint الصحيح في DB؟
- هل `device_id` nullable أم نلزم registry قبل persistence؟
- هل نخزن vendor+serial snapshot حتى مع `device_id`؟
- كيف نعالج timezone تاريخيًا؟
- هل نحتاج `DATETIME(3)` وJSON بعد capability validation؟

## 4. الخطوة الإلزامية التالية قبل القرار

فحص Read-Only للكود الحالي بحثًا عن:

```text
biometric_devices
biometric_raw_events
biometric_worker_mappings
```

الهدف تحديد أي runtime dependency أو migration/reference قد يستخدمها. هذا الفحص لم ينفذ بعد لأن العمل توقف بطلب صاحب المشروع.

## 5. ممنوع حاليًا

- `CREATE TABLE biometric_punches`.
- `ALTER` لأي جدول بصمة.
- `DROP` لأي جدول بصمة.
- إدخال الجهاز الحقيقي في DB.
- ربط 900001 بعامل.
- تفعيل DB writes في الخدمة.
