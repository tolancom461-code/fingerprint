# توثيق مشروع نظام البصمة — المرجع الرئيسي

**المشروع:** TolanWorkforce / برنامج تحضير اليومية  
**آخر تحديث شامل:** 2026-09-07  
**الخدمة الحالية:** `biometric-service` v0.18.0  
**حالة الجهاز:** `mode=test`  
**مرحلة الجهاز المحلي:** ✅ مكتملة  
**المرحلة التالية:** تجهيز سيرفر الشركة المحلي — لم تبدأ بعد.

## ابدأ من هنا

1. `21_WINDOWS_SERVICE_WINSW_LOCAL_PC_2026-09-07.md` — **الحالة النهائية للتشغيل المحلي: Web Bridge outage + WinSW + Auto-Start + Auto-Restart + Reboot tests.**
2. `01_CURRENT_STATUS.md` — لقطة الحالة الحالية.
3. `12_OPERATIONS_RUNBOOK.md` — التشغيل والإدارة اليومية عبر Windows Service.
4. `04_EXECUTION_CHECKLIST.md` — الاختبارات والبوابات المحدثة.
5. `02_DECISION_LOG.md` — القرارات، ومنها اعتماد WinSW بدل Task Scheduler.
6. `03_ISSUES_AND_FIXES.md` — المشاكل المكتشفة وإصلاحاتها.
7. `../BIOMETRIC_INTEGRATION_STATUS_2026-09-07.md` — ملخص التكامل مع Main App/Railway/TiDB.
8. `../UPGRADE_V0.17.1_TO_V0.18.0.md` — Web Bridge v0.18.0.
9. `19_FINAL_CLOSURE_REPORT_2026-08-31.md` — Baseline التاريخي قبل مراحل v0.10+ والربط.
10. `20_STANDALONE_BIOMETRIC_SYSTEM_EXECUTION_PLAN_2026-08-31.md` — الخطة التاريخية التي قادت إلى Final Events/Web Bridge.

## الحالة المثبتة الآن

```text
Real device / ADMS                     ✅
Durable ingest / canonical punch       ✅
Final Events                           ✅
Person Directory                       ✅
Manual historical reprocessing         ✅
Main App worker linking                 ✅ tested previously
Production outbound Web Bridge          ✅
Railway outage pending + retry           ✅
Production TiDB verification             ✅
Windows background service (WinSW)      ✅
Auto-restart after process crash         ✅
Auto-start after Windows reboot          ✅
Post-reboot biometric delivery           ✅
Old Task Scheduler                       ✅ disabled
Device mode                              test
Company server deployment                ❌ not started
```

## القواعد الملزمة

- TiDB الفعلية هي مصدر الحقيقة، وليس Drizzle schema.
- لا `drizzle push` ولا Migration تلقائي ولا SQL تعديلي بلا موافقة صريحة.
- الجهاز الحالي يبقى `mode=test` حتى موافقة صريحة على تغيير ذلك.
- لا تخزين templates أو صور بصمة/وجه أو passwords أو raw sensitive payloads.
- لا طباعة أو توثيق Token values.
- `.env` يبقى محليًا ولا يذهب إلى GitHub.
- لا expose مباشر للمنافذ 9095/9096/9097 إلى الإنترنت العام.
- production direction = outbound HTTPS Web Bridge.

## التشغيل المحلي النهائي

التشغيل اليومي لم يعد يعتمد على فتح PowerShell. الخدمة المثبتة:

```text
Service name: TolanBiometricService
Display name: Tolan Biometric Service
Deployment:   C:\Tolan\BiometricService
Start:        Automatic / delayed auto start
Recovery:     restart service after failure
```

التفاصيل الكاملة في `21_WINDOWS_SERVICE_WINSW_LOCAL_PC_2026-09-07.md`.

## الوثائق الأقدم

الوثائق المؤرخة قبل 2026-09-07 تبقى تاريخية ولا تُحذف. إذا قالت وثيقة قديمة إن Main App Bridge "لم يبدأ" فهذا وصف صحيح لذلك التاريخ فقط وقد تم تجاوزه لاحقًا.
