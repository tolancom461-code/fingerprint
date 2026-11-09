const TEST_DATABASE_NAME = /^biometric_portal_test_[a-z0-9_]{1,32}$/;

export function isAllowedTestDatabaseName(database, confirmedName) {
  return typeof database === 'string' &&
    (TEST_DATABASE_NAME.test(database) || (database === 'fingerprint' && confirmedName === 'fingerprint'));
}
