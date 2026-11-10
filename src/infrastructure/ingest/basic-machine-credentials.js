const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const PASSWORD = /^[A-Za-z0-9_-]{32,128}$/;

// These credentials belong to the machine channel, never to a portal account.
// Do not coerce, trim or retain extra configuration properties.
export function normalizeBasicMachineCredentials(value = null) {
  if (value === null) return null;
  try {
    if (typeof value !== 'object' || Array.isArray(value) ||
        !Object.hasOwn(value, 'username') || !Object.hasOwn(value, 'password')) throw invalid();
    const { username, password } = value;
    if (typeof username !== 'string' || !USERNAME.test(username) ||
        typeof password !== 'string' || !PASSWORD.test(password)) throw invalid();
    return Object.freeze({ username, password });
  } catch {
    // Configuration getters and proxies must not leak supplied values/errors.
    throw invalid();
  }
}

function invalid() {
  return Object.assign(new Error('Invalid machine ingest authentication configuration'), {
    code: 'INGEST_AUTH_CONFIG_INVALID'
  });
}
