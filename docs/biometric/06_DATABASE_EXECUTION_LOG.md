# سجل تنفيذ وفحص قاعدة بيانات نظام البصمة

هذا الملف يميز بوضوح بين **تنفيذ سابق** و**فحص Read-Only**. لا تُسجل المقترحات هنا كأنها نُفذت.

## 2026-08-10 — إنشاء `biometric_devices`

تم إنشاء جدول `biometric_devices` في مرحلة سابقة. آخر فحص 2026-08-29 أكد أنه موجود وفارغ وبنفس البنية الموثقة في `10_DATABASE_INSPECTION_2026-08-29.md`.

لا يوجد في هذا السجل دليل على إدخال جهاز فعلي إلى الجدول.

## 2026-08-29 — فحص البيئة الفعلية (Read-Only)

تم تنفيذ استعلامات قراءة فقط للتحقق من الحقيقة الفعلية:

```sql
SELECT DATABASE();
SELECT VERSION();
SHOW VARIABLES LIKE 'character_set_database';
SHOW VARIABLES LIKE 'collation_database';
SHOW FULL TABLES;
SHOW CREATE TABLE biometric_devices;
SHOW FULL COLUMNS FROM biometric_devices;
SHOW INDEX FROM biometric_devices;
SHOW TABLE STATUS LIKE 'biometric_devices';
SHOW CREATE TABLE biometric_raw_events;
SHOW CREATE TABLE biometric_worker_mappings;
```

ونفذ أيضًا عدّ صفوف Read-Only للجداول الثلاثة، وفحص `information_schema.KEY_COLUMN_USAGE` للعلاقات.

### النتائج

```text
Database                 test
Version                  8.0.11-TiDB-v8.5.3-serverless
character_set_database   utf8mb4
collation_database       utf8mb4_bin
```

الجداول البيومترية الموجودة:

```text
biometric_devices          0 rows
biometric_raw_events       0 rows
biometric_worker_mappings  0 rows
```

لا توجد Foreign Keys إلى أو من هذه الجداول حسب فحص `KEY_COLUMN_USAGE`.

`biometric_devices`:

```text
Engine        InnoDB
Row_format    Compact
Rows          0
Collation     utf8mb4_bin
Create_time   2026-08-10 13:45:50
```

## ما لم ينفذ

- لا CREATE جديد في 2026-08-29.
- لا ALTER.
- لا DROP.
- لا INSERT/UPDATE/DELETE.
- لم يتم إنشاء `biometric_punches`.
- لم يتم ربط `biometric-service` بـTiDB.
- لم يتم تنفيذ `SELECT JSON_ARRAY(...)` المقترح لأن العمل توقف أولًا لفحص الجداول الموجودة.
- لم يتم بعد فحص مراجع الكود للجداول الثلاثة؛ أوقفنا عند هذه النقطة بطلب صاحب المشروع.

## الحالة الحالية

```text
DB modification authorization = NONE
Next safe DB-related action    = code-reference audit + reconciliation review
```
