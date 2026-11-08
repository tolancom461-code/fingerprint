# Documentation Update — 2026-09-07

هذا التحديث يوثق إغلاق مرحلة الجهاز المحلي لنظام البصمة بعد نجاح Web Bridge production reliability وWindows Service التشغيلية.

## ملفات أضيفت

- `BIOMETRIC_INTEGRATION_STATUS_2026-09-07.md`
- `biometric/21_WINDOWS_SERVICE_WINSW_LOCAL_PC_2026-09-07.md`
- `biometric/scripts/Install-TolanBiometricService-v2.ps1`

## ملفات حدثت لتعكس الحالة الحالية

- `README.md`
- `ARCHITECTURE.md`
- `UPGRADE_V0.17.1_TO_V0.18.0.md`
- `biometric/README.md`
- `biometric/01_CURRENT_STATUS.md`
- `biometric/02_DECISION_LOG.md`
- `biometric/03_ISSUES_AND_FIXES.md`
- `biometric/04_EXECUTION_CHECKLIST.md`
- `biometric/12_OPERATIONS_RUNBOOK.md`

## ما تم توثيقه

- controlled Railway/outbound target outage.
- pending cursor preservation.
- retry after target restoration.
- production TiDB read-only verification and exactly-once evidence.
- Task Scheduler trial and why it was rejected as final supervision.
- WinSW selection and Windows Service architecture.
- installer v1 failure and v2 fix.
- service installation under `C:\Tolan\BiometricService`.
- automatic crash recovery.
- automatic startup after Windows restart.
- post-reboot biometric delivery.
- old Task Scheduler disabled.
- device remains `mode=test`.

## ما لم يتغير

- no token values documented.
- no biometric templates/images/passwords/raw sensitive payloads added.
- no SQL mutation added to the runbook.
- no recommendation to run `drizzle push` or automatic migration.
- company server deployment has not been documented as completed; it is the next phase only.
