# Documentation Changelog — 2026-08-29

تمت مراجعة مجلد التوثيق بالكامل بعد انتهاء سلسلة اختبارات الجهاز الحقيقي وفحص TiDB.

## تم تصحيح معلومات قديمة

- استبدال MB2000 كمرجع فعلي بـSpeedFace-V5L الحقيقي.
- تحديث حالة الاتصال من "لم يختبر" إلى "مثبت".
- تحديث OPTIONS/OPERLOG/ATTLOG من planned إلى verified.
- تحديث service baseline إلى v0.6.0 و46/46 tests.
- توثيق نجاح ATTLOG ACK على الجهاز الحقيقي.
- توثيق خرائط `rawVerify` و`rawStatus` المثبتة.
- توثيق Duplicate Punch Period وتأثيره على الاختبارات.
- توثيق قرار عدم اختبار QR رغم إعلان الجهاز دعمه.

## تم تصحيح حالة قاعدة البيانات

الوثائق الأقدم كانت تسجل `biometric_devices` فقط. فحص 2026-08-29 أثبت وجود:

```text
biometric_devices
biometric_raw_events
biometric_worker_mappings
```

وكلها فارغة ولا توجد Foreign Keys مرتبطة بها.

تم إيقاف خطة إنشاء `biometric_punches` لحين reconciliation.

## ملفات جديدة

- `08_REAL_DEVICE_VALIDATION_2026-08-29.md`
- `09_ATTLOG_FIELD_MAPPING.md`
- `10_DATABASE_INSPECTION_2026-08-29.md`
- `11_DATABASE_RECONCILIATION_PENDING.md`
- `12_OPERATIONS_RUNBOOK.md`
- هذا الملف.

## نقطة العمل التالية عند الاستئناف

فحص Read-Only لمراجع الكود الحالية لأسماء الجداول البيومترية الثلاثة، ثم إعداد قرار مصالحة DB. لا SQL تعديل قبل الموافقة.
