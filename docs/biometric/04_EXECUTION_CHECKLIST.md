# خطة التنفيذ وبوابات الموافقة — الحالة النهائية للخدمة المستقلة

**آخر تحديث:** 2026-08-31

## المرحلة 0 — العزل

- [x] خدمة مستقلة داخل `biometric-service/`.
- [x] منع imports/runtime dependency على التطبيق الحالي.
- [x] Multi-device architecture.
- [x] Multi-vendor architecture with vendor-neutral core.
- [x] Boundary suite: 4/4 passing.

## المرحلة 1 — الجهاز والاتصال

- [x] ZKTeco SpeedFace-V5L حقيقي.
- [x] ADMS على 9095.
- [x] عنوان الجهاز النهائي `192.168.10.199`.
- [x] DHCP OFF.
- [x] Ping ناجح 2/2.
- [x] Timezone = UTC+03:00 / Asia/Riyadh.
- [x] DST OFF.
- [x] NTP بقي OFF باختيار المشغل.

## المرحلة 2 — البروتوكول والخصوصية

- [x] OPTIONS.
- [x] OPERLOG sanitized.
- [x] ATTLOG real capture.
- [x] منع تخزين templates والصور والـcredentials.
- [x] unknown/unsafe payload fails safe.

## المرحلة 3 — خرائط الجهاز المرجعي

- [x] Fingerprint = rawVerify 1.
- [x] Password = 3.
- [x] Card = 4.
- [x] Face = 15.
- [x] Palm = 25.
- [x] Check-In = rawStatus 0.
- [x] Check-Out = 1.
- [x] Break-Out = 2.
- [x] Break-In = 3.
- [x] Overtime-In = 4.
- [x] Overtime-Out = 5.
- [x] عدم تعميم mappings على Serial آخر بدون اختبار.

## المرحلة 4 — TiDB ownership

- [x] فحص TiDB الفعلية قبل التغيير.
- [x] التحقق أن الجداول القديمة فارغة وغير مرتبطة.
- [x] حذف الجداول القديمة يدوياً بعد الموافقة والفحص.
- [x] إنشاء الجداول الخمسة `biometric_svc_*` يدوياً.
- [x] SHOW CREATE/contract verification.
- [x] runtime لا ينفذ DDL.

## المرحلة 5 — DB runtime

- [x] Durable sanitized ingest.
- [x] Processing state.
- [x] Canonical punch.
- [x] Device registry.
- [x] Device-user observation.
- [x] DB schema validation on startup.
- [x] No automatic fallback to file mode.

## المرحلة 6 — ACK / dedupe / recovery

- [x] no-ACK retry observed on real terminal.
- [x] durable duplicate detection.
- [x] ACK after durable persistence.
- [x] ACK stopped terminal retry on real device.
- [x] startup replay.
- [x] runtime retry sweep without restart.
- [x] non-overlapping retry sweeps.

## المرحلة 7 — timezone والسياسات

- [x] device timezone flows to Punch.
- [x] device local time converts to UTC.
- [x] real Riyadh -> UTC verification.
- [x] `accept_events_from` implemented.
- [x] real v0.9.3 UTC/local comparison defect discovered.
- [x] fixed in v0.9.4.
- [x] real post-fix cutoff test: ingest increased while punch count stayed unchanged.
- [x] `mode=maintenance` produced real `device_policy_rejected`.
- [x] `status=disabled` produced real policy rejections; delayed ATTLOG arrived only after restoring active.
- [x] automated fail-closed coverage for database device policy.

## المرحلة 8 — diagnostics

- [x] bounded log rotation.
- [x] clean active log per service session.
- [x] sessionId per log record.
- [x] UTC + local Riyadh diagnostic timestamps.

## المرحلة 9 — الاختبارات النهائية

- [x] `npm test`: 97/97 pass on v0.9.4.
- [x] architecture boundaries: 4/4 pass.
- [x] real-device DB persistence.
- [x] real-device normalized punch.
- [x] real-device ACK/dedupe.
- [x] real-device timezone/UTC.
- [x] real-device cutoff policy.
- [ ] second physical device — not available; architecture/tests cover multi-device.
- [ ] second physical vendor — not selected; architecture only.
- [ ] terminal QR verification — intentionally not required in this phase.

## المرحلة 10 — إغلاق الخدمة المستقلة

- [x] Final closure report written.
- [x] Device returned to `status=active`.
- [x] Device returned to `mode=test`.
- [x] `accept_events_from=NULL` restored.
- [x] Main application integration remains untouched.

## Gate للمرحلة القادمة

```text
STOP here.
Device mode remains test.
Do not switch to live yet.
Do not connect to workers/attendance/finance/payroll/shifts/QR yet.
```

المرحلة التالية، إذا اعتمدت، هي تصميم Main Application Bridge بموافقة جديدة واختبارات regression مستقلة.

---

# تحديث التنفيذ — 2026-09-07

## المرحلة 11 — Main App / Web Bridge production path

- [x] Main App public target = `https://www.tolanhr.com`.
- [x] outbound HTTPS bridge from local `biometric-service`.
- [x] production bridge health/auth tested previously.
- [x] real biometric Final Event pushed to Railway.
- [x] production TiDB `attendance_events` verified.
- [x] device remains `mode=test`.

## المرحلة 12 — Web Bridge outage / reliability

- [x] service stopped before changing target.
- [x] temporary unavailable target = `http://127.0.0.1:1`.
- [x] one biometric event generated.
- [x] `fetch failed` observed.
- [x] Web Bridge cursor remained `120001` while target unavailable.
- [x] correct target restored to `https://www.tolanhr.com`.
- [x] pending event retried automatically.
- [x] push success: cursor advanced to `150001`.
- [x] production TiDB verified `status=processed`.
- [x] production TiDB verified `method=biometric`.
- [x] production TiDB verified `import_count=1`.
- [x] original timestamp preserved.

## المرحلة 13 — Local Windows background operation

### Task Scheduler trial

- [x] background task created and tested.
- [x] started biometric-service without daily PowerShell.
- [x] real biometric event reached production TiDB.
- [x] crash recovery test performed.
- [x] Task Scheduler auto-restart behavior rejected as insufficient.

### WinSW Windows Service

- [x] WinSW 2.12.0 x64 selected/pinned.
- [x] installer review mode passed.
- [x] installer v1 safe failure documented.
- [x] installer v2 passed.
- [x] deployment created at `C:\Tolan\BiometricService`.
- [x] `.env` preserved and protected; token not printed.
- [x] Web Bridge cursor state copied/preserved.
- [x] service installed: `TolanBiometricService`.
- [x] service account = LocalSystem.
- [x] start mode = Automatic / delayed auto start.
- [x] 9095/9096/9097 listening.
- [x] failure action does not reboot Windows.

## المرحلة 14 — Recovery / reboot proof

- [x] killed Node PID `18468` intentionally.
- [x] service recovered automatically as PID `9824`.
- [x] no manual biometric-service start used for recovery.
- [x] Windows reboot performed manually for test.
- [x] service started automatically after boot as PID `4404`.
- [x] post-reboot ports 9095/9096/9097 listening.
- [x] post-reboot `break_in` arrived as `unsupported_event` (expected).
- [x] post-reboot `check_in` arrived as `processed` / `method=biometric`.
- [x] post-reboot attendance_event_id `28860001` verified.
- [x] old Task Scheduler task = Disabled.

## المرحلة 15 — Local PC closure gate

- [x] Web Bridge outage test passed.
- [x] pending event durability/retry passed.
- [x] exactly-once import verification passed.
- [x] background service passed.
- [x] automatic crash recovery passed.
- [x] automatic startup after Windows reboot passed.
- [x] real post-reboot biometric delivery passed.
- [x] `mode=test` preserved.
- [x] no migration / drizzle push used in this phase.
- [x] local PC phase complete.

## Gate التالية

```text
LOCAL PC PHASE = COMPLETE
NEXT = COMPANY LOCAL SERVER PREPARATION
DEVICE MODE = test
```

لا يتم الانتقال إلى تغيير `mode` أو go-live قبل موافقة صريحة.
