# Main App ↔ Biometric Integration Status — 2026-09-07

هذا الملف ملخص تكامل فقط. التفاصيل التشغيلية الخاصة بـWindows/WinSW موجودة في:

`biometric/21_WINDOWS_SERVICE_WINSW_LOCAL_PC_2026-09-07.md`

## الحالة الحالية

- `biometric-service` الحالي: v0.18.0.
- الإنتاج العام: `https://www.tolanhr.com` على Railway.
- اتجاه التكامل الإنتاجي: outbound HTTPS push من `biometric-service` المحلي إلى Main App Web Bridge.
- TiDB الفعلية هي مصدر الحقيقة.
- جهاز البصمة المرجعي ما زال `mode=test`.
- Web Bridge outage/retry تم اختباره فعليًا ونجح.
- Windows background service على الجهاز المحلي تم اختباره فعليًا ونجح.
- Auto-restart بعد crash تم اختباره ونجح.
- Auto-start بعد Windows restart تم اختباره ونجح.
- بصمة `check_in` بعد Windows restart وصلت إلى production TiDB كـ`method=biometric`.

## حدود التكامل الحالية

- `attendance_events` هو سجل الحضور الأساسي.
- `check_in` و`check_out` البيومتريان يمكن أن ينتجا attendance events.
- `break_in/break_out/overtime_*` لا تتحول حاليًا إلى attendance check-in/check-out؛ يتم تتبعها وفق نتيجة الاستيراد مثل `unsupported_event`.
- لا يتم كشف الجهاز أو المنافذ المحلية 9095/9096/9097 للإنترنت العام.
- لا يتم إرسال templates/images/passwords/raw sensitive payloads إلى Main App.
- لا يتم تنفيذ migrations تلقائية أو `drizzle push`.

## المرحلة التالية

المرحلة المحلية انتهت. التجهيز التالي يكون على **سيرفر الشركة المحلي** فقط بعد بدء تلك المرحلة صراحة، مع إعادة نفس نموذج Windows Service المثبت محليًا.
