-- MANUAL REVIEW ONLY. Application startup never applies this migration.
-- Target the independently copied fingerprint schema. Back it up and verify
-- that the legacy unique key on (device_id, device_user_id) exists before use.
-- Stop all writers until all statements and identity-aware readiness checks pass.
-- Apply statement by statement. MySQL and TiDB commit DDL independently.

ALTER TABLE `fingerprint`.`biometric_svc_device_users`
  ADD COLUMN `identity_started_at` DATETIME(6) NULL;

ALTER TABLE `fingerprint`.`biometric_svc_device_users`
  ADD COLUMN `identity_ended_at` DATETIME(6) NULL;

-- Existing enrollment start and end times are unknown. Leave both fields NULL.
ALTER TABLE `fingerprint`.`biometric_svc_device_users`
  ADD COLUMN `current_device_user_id` VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
  GENERATED ALWAYS AS (CASE WHEN `status` = 'absent_from_device' THEN NULL ELSE `device_user_id` END) VIRTUAL;

ALTER TABLE `fingerprint`.`biometric_svc_punches`
  ADD COLUMN `device_user_row_id` BIGINT UNSIGNED NULL;

ALTER TABLE `fingerprint`.`biometric_svc_punches`
  ADD INDEX `idx_biometric_svc_punches_device_user_row_id` (`device_user_row_id`);

-- Backfill only while the legacy device/PIN key guarantees a single identity.
-- Punches without a matching identity retain NULL. No person link is inferred.
UPDATE `fingerprint`.`biometric_svc_punches` p
  JOIN `fingerprint`.`biometric_svc_device_users` u
    ON u.`device_id` = p.`device_id` AND u.`device_user_id` = p.`device_user_id`
  SET p.`device_user_row_id` = u.`id`
  WHERE p.`device_user_row_id` IS NULL
    AND EXISTS (
      SELECT 1 FROM `information_schema`.`STATISTICS`
      WHERE `TABLE_SCHEMA` = 'fingerprint' AND `TABLE_NAME` = 'biometric_svc_device_users'
        AND `INDEX_NAME` = 'uq_biometric_svc_device_user' AND `NON_UNIQUE` = 0
      GROUP BY `INDEX_NAME`
      HAVING COUNT(*) = 2 AND SUM(CASE
        WHEN (`SEQ_IN_INDEX` = 1 AND `COLUMN_NAME` = 'device_id') OR
             (`SEQ_IN_INDEX` = 2 AND `COLUMN_NAME` = 'device_user_id') THEN 1 ELSE 0 END) = 2
    );

-- Review this count before releasing the legacy key. It must be zero.
SELECT COUNT(*) AS matching_legacy_punches_without_identity
  FROM `fingerprint`.`biometric_svc_punches` p
  JOIN `fingerprint`.`biometric_svc_device_users` u
    ON u.`device_id` = p.`device_id` AND u.`device_user_id` = p.`device_user_id`
  WHERE p.`device_user_row_id` IS NULL;

ALTER TABLE `fingerprint`.`biometric_svc_device_users`
  ADD UNIQUE INDEX `uq_biometric_svc_device_user_current` (`device_id`, `current_device_user_id`);

ALTER TABLE `fingerprint`.`biometric_svc_device_users`
  ADD INDEX `idx_biometric_svc_device_users_device_pin` (`device_id`, `device_user_id`);

-- Apply last. Start only runtime code that understands enrollment identities.
ALTER TABLE `fingerprint`.`biometric_svc_device_users`
  DROP INDEX `uq_biometric_svc_device_user`;
