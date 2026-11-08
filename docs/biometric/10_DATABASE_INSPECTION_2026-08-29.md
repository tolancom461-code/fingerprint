# فحص قاعدة البيانات الفعلية — 2026-08-29

## 1. قاعدة المصدر

تم الاعتماد على TiDB الفعلية فقط عبر استعلامات Read-Only.

```text
DATABASE()               test
VERSION()                8.0.11-TiDB-v8.5.3-serverless
character_set_database   utf8mb4
collation_database       utf8mb4_bin
```

## 2. الجداول البيومترية المكتشفة

```text
biometric_devices
biometric_raw_events
biometric_worker_mappings
```

العد:

```text
biometric_devices          0
biometric_raw_events       0
biometric_worker_mappings  0
```

`biometric_punches` غير موجود وقت الفحص.

## 3. `biometric_devices` — SHOW CREATE

```sql
CREATE TABLE `biometric_devices` (
  `id` int NOT NULL AUTO_INCREMENT,
  `serial_number` varchar(100) NOT NULL,
  `name` varchar(255) NOT NULL,
  `manufacturer` varchar(100) NOT NULL,
  `model` varchar(100) DEFAULT NULL,
  `adapter_type` varchar(50) NOT NULL,
  `protocol` varchar(50) NOT NULL,
  `device_mode` enum('test','production') NOT NULL DEFAULT 'test',
  `status` enum('active','disabled','retired') NOT NULL DEFAULT 'active',
  `location_name` varchar(255) DEFAULT NULL,
  `timezone` varchar(100) NOT NULL DEFAULT 'Asia/Riyadh',
  `accept_events_from` datetime DEFAULT NULL,
  `firmware_version` varchar(100) DEFAULT NULL,
  `platform` varchar(100) DEFAULT NULL,
  `first_seen_at` datetime DEFAULT NULL,
  `last_seen_at` datetime DEFAULT NULL,
  `last_event_at` datetime DEFAULT NULL,
  `last_ip_address` varchar(45) DEFAULT NULL,
  `notes` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) /*T![clustered_index] CLUSTERED */,
  UNIQUE KEY `uq_biometric_devices_serial_number` (`serial_number`),
  KEY `idx_biometric_devices_status` (`status`),
  KEY `idx_biometric_devices_mode` (`device_mode`),
  KEY `idx_biometric_devices_last_seen` (`last_seen_at`),
  KEY `idx_biometric_devices_last_event` (`last_event_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
```

Table status observed:

```text
Engine        InnoDB
Row_format    Compact
Rows          0
Collation     utf8mb4_bin
Create_time   2026-08-10 13:45:50
```

## 4. `biometric_raw_events` — SHOW CREATE

```sql
CREATE TABLE `biometric_raw_events` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `device_id` int DEFAULT NULL,
  `device_serial` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `device_user_id` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `event_time_local` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `raw_status` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `normalized_event_type` enum('check_in','check_out','unknown') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'unknown',
  `verify_mode` varchar(30) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `work_code` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `raw_payload` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `payload_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `processing_status` enum('pending','processed','duplicate','unmapped','review','error') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `attendance_event_id` int DEFAULT NULL,
  `error_message` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `source_ip` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `received_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `processed_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`) /*T![clustered_index] CLUSTERED */,
  UNIQUE KEY `uq_biometric_raw_payload_hash` (`payload_hash`),
  KEY `idx_biometric_raw_device_time` (`device_id`,`event_time_local`),
  KEY `idx_biometric_raw_user_time` (`device_user_id`,`event_time_local`),
  KEY `idx_biometric_raw_status` (`processing_status`),
  KEY `idx_biometric_raw_attendance` (`attendance_event_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

## 5. `biometric_worker_mappings` — SHOW CREATE

```sql
CREATE TABLE `biometric_worker_mappings` (
  `id` int NOT NULL AUTO_INCREMENT,
  `device_id` int NOT NULL,
  `worker_id` int NOT NULL,
  `device_user_id` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `is_active` tinyint NOT NULL DEFAULT '1',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) /*T![clustered_index] CLUSTERED */,
  UNIQUE KEY `uq_biometric_mapping_device_user` (`device_id`,`device_user_id`),
  KEY `idx_biometric_mapping_worker` (`worker_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

## 6. العلاقات

فحص `information_schema.KEY_COLUMN_USAGE` أظهر القيود الداخلية Primary/Unique فقط، ولم يظهر `REFERENCED_TABLE_NAME` للجداول البيومترية. أي اعتماد محتمل قد يكون **اعتماد كود** وليس Foreign Key.

## 7. تعارضات يجب حلها قبل DDL

1. `biometric_devices` لا يحتوي `vendor` ويفرض uniqueness على serial وحده.
2. `biometric_raw_events.normalized_event_type` لا يمثل break/overtime states المثبتة.
3. `biometric_raw_events` يحمل `attendance_event_id` رغم أن الخدمة الجديدة مستقلة.
4. `event_time_local` نص بدل نوع datetime.
5. `verify_mode` لا يفصل raw value عن normalized method بوضوح.
6. `biometric_worker_mappings` يربط مباشرة بـworker قبل مرحلة integration الجديدة.
7. اختلاف collation بين `biometric_devices` وبقية جداول البصمة.
8. UNIQUE `payload_hash` يحتاج مراجعة ضد idempotency semantics المثبتة في الخدمة.

## 8. استعلامات Read-Only المتبقية عند الاستئناف

قبل أي تغيير DB، الأولوية ليست SQL جديدًا بل فحص References في الكود الحالي للجداول الثلاثة. بعد ذلك فقط، إن لزم، يمكن إجراء capability checks إضافية مثل JSON/fractional datetime بطريقة Read-Only.
