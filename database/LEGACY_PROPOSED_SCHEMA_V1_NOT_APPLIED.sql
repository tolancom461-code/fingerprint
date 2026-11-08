-- biometric-service standalone database design v1
-- STATUS: DESIGN ARTIFACT ONLY. NOT APPLIED TO TiDB.
-- DO NOT EXECUTE without a separate explicit approval.
-- Ownership boundary: these tables belong only to biometric-service.
-- No foreign keys or columns point to workers, attendance_events, finance, shifts, or QR tables.

-- Intended logical database: biometric_service
-- Database creation and connection credentials are deliberately omitted from this file.

CREATE TABLE `devices` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `vendor` varchar(64) NOT NULL,
  `serial_number` varchar(128) NOT NULL,
  `display_name` varchar(255) DEFAULT NULL,
  `manufacturer` varchar(128) DEFAULT NULL,
  `model` varchar(128) DEFAULT NULL,
  `protocol` varchar(64) DEFAULT NULL,
  `adapter_type` varchar(64) DEFAULT NULL,
  `mode` enum('test','production') NOT NULL DEFAULT 'test',
  `status` enum('active','disabled','retired') NOT NULL DEFAULT 'active',
  `timezone` varchar(100) NOT NULL DEFAULT 'Asia/Riyadh',
  `firmware_version` varchar(160) DEFAULT NULL,
  `platform` varchar(128) DEFAULT NULL,
  `oem_vendor` varchar(128) DEFAULT NULL,
  `first_seen_at` datetime(6) DEFAULT NULL,
  `last_seen_at` datetime(6) DEFAULT NULL,
  `last_event_at` datetime(6) DEFAULT NULL,
  `last_ip_address` varchar(45) DEFAULT NULL,
  `safe_capabilities` json DEFAULT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_devices_vendor_serial` (`vendor`,`serial_number`),
  KEY `idx_devices_status` (`status`),
  KEY `idx_devices_last_seen` (`last_seen_at`),
  KEY `idx_devices_last_event` (`last_event_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `ingest_events` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `ingest_key` char(64) NOT NULL,
  `storage_identity_version` varchar(16) NOT NULL,
  `device_id` bigint unsigned DEFAULT NULL,
  `vendor` varchar(64) NOT NULL,
  `serial_number` varchar(128) NOT NULL,
  `event_family` varchar(64) NOT NULL,
  `vendor_event_type` varchar(64) NOT NULL,
  `vendor_event_id` varchar(255) DEFAULT NULL,
  `dedupe_key` varchar(255) NOT NULL,
  `dedupe_strategy` varchar(100) NOT NULL,
  `dedupe_version` varchar(32) NOT NULL,
  `wire_hash` char(64) NOT NULL,
  `parser_version` varchar(128) NOT NULL,
  `parse_valid` tinyint NOT NULL,
  `safe_to_acknowledge` tinyint NOT NULL,
  `unsafe_reason` varchar(255) DEFAULT NULL,
  `source_bytes` int unsigned DEFAULT NULL,
  `source_field_count` smallint unsigned DEFAULT NULL,
  `safe_payload` json DEFAULT NULL,
  `source_ip` varchar(45) DEFAULT NULL,
  `received_at` datetime(6) NOT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ingest_events_ingest_key` (`ingest_key`),
  KEY `idx_ingest_events_device_received` (`vendor`,`serial_number`,`received_at`),
  KEY `idx_ingest_events_wire_hash` (`wire_hash`),
  KEY `idx_ingest_events_ack_safety` (`safe_to_acknowledge`,`received_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `event_processing` (
  `ingest_event_id` bigint unsigned NOT NULL,
  `status` enum('pending','processed','failed','not_applicable') NOT NULL DEFAULT 'pending',
  `attempt_count` int unsigned NOT NULL DEFAULT 0,
  `last_attempt_at` datetime(6) DEFAULT NULL,
  `last_error_code` varchar(100) DEFAULT NULL,
  `last_error_message` varchar(1000) DEFAULT NULL,
  `processed_at` datetime(6) DEFAULT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`ingest_event_id`),
  KEY `idx_event_processing_status` (`status`,`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `punches` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `ingest_event_id` bigint unsigned NOT NULL,
  `event_key` char(64) NOT NULL,
  `event_key_strategy` varchar(100) NOT NULL, -- core-qualified-dedupe
  `event_key_version` varchar(32) NOT NULL,   -- storage identity version
  `device_id` bigint unsigned DEFAULT NULL,
  `vendor` varchar(64) NOT NULL,
  `serial_number` varchar(128) NOT NULL,
  `device_user_id` varchar(128) NOT NULL,
  `device_event_time_raw` varchar(64) NOT NULL,
  `device_event_time_local` datetime(6) DEFAULT NULL,
  `device_timezone` varchar(100) DEFAULT NULL,
  `device_event_time_utc` datetime(6) DEFAULT NULL,
  `raw_status` varchar(32) DEFAULT NULL,
  `punch_state` varchar(64) DEFAULT NULL,
  `raw_verify` varchar(32) DEFAULT NULL,
  `verification_method` varchar(64) DEFAULT NULL,
  `work_code` varchar(100) DEFAULT NULL,
  `delimiter` varchar(16) DEFAULT NULL,
  `extra_fields` json DEFAULT NULL,
  `wire_hash` char(64) NOT NULL,
  `parser_version` varchar(128) NOT NULL,
  `parse_valid` tinyint NOT NULL,
  `received_at` datetime(6) NOT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_punches_ingest_event` (`ingest_event_id`),
  UNIQUE KEY `uq_punches_event_key` (`event_key`),
  KEY `idx_punches_device_time` (`vendor`,`serial_number`,`device_event_time_local`),
  KEY `idx_punches_user_time` (`device_user_id`,`device_event_time_local`),
  KEY `idx_punches_received_at` (`received_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `device_users` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `device_id` bigint unsigned NOT NULL,
  `device_user_id` varchar(128) NOT NULL,
  `display_name` varchar(255) DEFAULT NULL,
  `status` enum('seen','active','disabled') NOT NULL DEFAULT 'seen',
  `safe_metadata` json DEFAULT NULL,
  `first_seen_at` datetime(6) DEFAULT NULL,
  `last_seen_at` datetime(6) DEFAULT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_device_users_device_user` (`device_id`,`device_user_id`),
  KEY `idx_device_users_last_seen` (`last_seen_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
