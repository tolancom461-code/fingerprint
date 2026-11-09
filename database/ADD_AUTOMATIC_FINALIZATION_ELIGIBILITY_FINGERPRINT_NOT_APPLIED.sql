-- MANUAL REVIEW ONLY. This file is never executed by application startup.
-- Deployment history: applied to fingerprint through the guarded preparation
-- script on 2026-11-09 after a fresh backup; check state before any future use.
-- Target: the independently copied fingerprint database only. Never run on test.
-- Existing captures remain ineligible (0); duplicates must never upgrade them.
-- Take and verify the target backup, confirm the column is absent, then apply
-- this statement only through the approved target migration procedure.
ALTER TABLE `fingerprint`.`biometric_svc_event_processing`
  ADD COLUMN `automatic_finalization_eligible` TINYINT UNSIGNED NOT NULL DEFAULT 0;
