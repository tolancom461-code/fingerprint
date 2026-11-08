import test from 'node:test';
import assert from 'node:assert/strict';
import { localDateTimeToUtcSql } from '../src/domain/timezone.js';

test('converts Riyadh device-local time to UTC without assuming host timezone', () => {
  assert.equal(
    localDateTimeToUtcSql('2026-08-30 16:06:54', 'Asia/Riyadh'),
    '2026-08-30 13:06:54.000000'
  );
});

test('converts another IANA timezone for multi-device support', () => {
  assert.equal(
    localDateTimeToUtcSql('2026-07-01 12:00:00.123456', 'America/New_York'),
    '2026-07-01 16:00:00.123456'
  );
});

test('does not invent UTC for invalid timezone or nonexistent DST local time', () => {
  assert.equal(localDateTimeToUtcSql('2026-08-30 16:00:00', 'Invalid/Zone'), null);
  assert.equal(localDateTimeToUtcSql('2026-03-08 02:30:00', 'America/New_York'), null);
});
