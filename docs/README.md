# Biometric Documentation — TolanWorkforce

**Last verified:** 2026-09-07  
**Current biometric-service:** `v0.18.0`  
**Real terminal:** ZKTeco SpeedFace-V5L / ZAM230  
**Database source of truth:** actual TiDB  
**Device safety state:** `mode=test`  
**Local-PC phase:** ✅ complete  
**Next phase:** company local server preparation — not started yet.

## ابدأ من هنا — الحالة الحالية

1. `biometric/21_WINDOWS_SERVICE_WINSW_LOCAL_PC_2026-09-07.md` — **التشغيل التلقائي النهائي على Windows + WinSW + اختبارات outage/crash/reboot.**
2. `BIOMETRIC_INTEGRATION_STATUS_2026-09-07.md` — ملخص تكامل Main App / Railway / TiDB الحالي.
3. `biometric/01_CURRENT_STATUS.md` — الحالة التشغيلية المحدثة.
4. `UPGRADE_V0.17.1_TO_V0.18.0.md` — تعريف Web Bridge في v0.18.0.
5. `FINAL_EVENTS_API_V1.md` و`PERSON_DIRECTORY_API_V1.md` — عقود API المحلية.
6. `biometric/12_OPERATIONS_RUNBOOK.md` — دليل التشغيل اليومي الحالي.
7. `biometric/04_EXECUTION_CHECKLIST.md` — بوابات التنفيذ والاختبارات.
8. `biometric/02_DECISION_LOG.md` و`biometric/03_ISSUES_AND_FIXES.md` — القرارات والمشاكل.

## الحقيقة الحالية المثبتة

```text
Local ZKTeco
→ local Windows Service (WinSW)
→ biometric-service v0.18.0
→ outbound HTTPS
→ https://www.tolanhr.com / Railway
→ attendance_events / import tracking in production TiDB
```

تم إثبات:

- Web Bridge push إلى الإنتاج.
- الاحتفاظ بالحدث pending عند تعطل الهدف وعدم تقدم cursor.
- retry تلقائي بعد استعادة الهدف.
- استيراد الحدث مرة واحدة فقط (`import_count=1` في اختبار الانقطاع).
- تشغيل `biometric-service` في الخلفية كـWindows Service حقيقية.
- automatic service recovery بعد قتل `node.exe` عمدًا.
- automatic startup بعد Windows restart.
- بصمة فعلية بعد restart وصلت إلى TiDB الإنتاجية.
- Task Scheduler القديم معطّل بعد نجاح Windows Service.

## القواعد الملزمة

- Actual TiDB is the database source of truth. Do not treat Drizzle schema as authoritative.
- No `drizzle push`, automatic migrations, or schema mutations without explicit approval.
- Read-only SQL is allowed for verification.
- Device remains `mode=test` until explicit approval changes it.
- Do not store/expose biometric templates, biometric images, passwords, or raw sensitive payloads.
- `.env` and bridge tokens must not be committed or printed in documentation.
- Do not expose the ZKTeco terminal or local ports 9095/9096/9097 directly to the public internet.
- Production direction is outbound HTTPS from local `biometric-service` to the Main App.

## وثائق تاريخية

ملفات v0.4 إلى v0.17.1 وتقارير 2026-08-29/30/31 تبقى كأدلة تاريخية للحالة وقت كتابتها. عبارات مثل "main integration not started" داخل تلك الملفات لا تمثل الحالة الحالية بعد 2026-09-07.

المرجع عند التعارض:

1. actual TiDB for database facts.
2. `biometric/21_WINDOWS_SERVICE_WINSW_LOCAL_PC_2026-09-07.md` for local Windows operation.
3. `BIOMETRIC_INTEGRATION_STATUS_2026-09-07.md` for current Main App integration status.
4. `biometric/01_CURRENT_STATUS.md` for concise current state.
5. dated historical documents for historical evidence only.
