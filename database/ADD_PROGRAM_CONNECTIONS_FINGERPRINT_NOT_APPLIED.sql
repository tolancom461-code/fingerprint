-- MANUAL REVIEW ONLY. Application startup never executes this file.
-- Back up the independent fingerprint schema and verify the intended server first.
-- Run statements separately. Stop if the table already exists; do not hide a mismatch.
SELECT DATABASE() AS selected_database, VERSION() AS server_version;

CREATE TABLE `fingerprint`.`biometric_svc_program_connections` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `program_name` VARCHAR(100) NOT NULL,
  `token_hash` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `token_prefix` VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `status` VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `created_by` VARCHAR(128) NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `revoked_at` DATETIME(6) NULL DEFAULT NULL,
  `revoked_by` VARCHAR(128) NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_biometric_svc_program_token_hash` (`token_hash`),
  KEY `idx_biometric_svc_program_status_created` (`status`, `created_at`, `id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

-- The store always supplies UTC_TIMESTAMP(6), independent of the SQL session zone.
-- CURRENT_TIMESTAMP is a portable fallback only; a direct writer must use UTC explicitly.
-- Only SHA-256 of a random 32-byte key and its 12-character display prefix are stored.
-- No attendance/device/person/financial table is modified by this migration.

-- Review the account identity before manually applying this narrow table-level grant.
GRANT SELECT, INSERT, UPDATE ON `fingerprint`.`biometric_svc_program_connections`
  TO '24yVnB8NmZGjEKv.fp_ing_bffaba49'@'%';

SHOW CREATE TABLE `fingerprint`.`biometric_svc_program_connections`;
SHOW INDEX FROM `fingerprint`.`biometric_svc_program_connections`;
