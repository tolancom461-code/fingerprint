const CONSUMER_TOKEN = /^[A-Za-z0-9_-]{43,128}$/;

export function isConsumerApiToken(token) {
  return typeof token === 'string' && CONSUMER_TOKEN.test(token);
}

export function normalizeConsumerApiConfig(value = null, { ingestToken, basicPassword } = {}) {
  if (value === null) return null;
  try {
    if (typeof value !== 'object' || Array.isArray(value) ||
        Reflect.ownKeys(value).length !== 1 || !Object.hasOwn(value, 'token')) throw invalid();
    const { token } = value;
    if (!isConsumerApiToken(token) || token === ingestToken || token === basicPassword) throw invalid();
    return Object.freeze({ token });
  } catch {
    throw invalid();
  }
}

function invalid() {
  return Object.assign(new Error('Invalid consumer API configuration'), { code: 'CONSUMER_API_CONFIG_INVALID' });
}
