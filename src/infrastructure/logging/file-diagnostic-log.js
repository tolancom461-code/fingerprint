import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DiagnosticLog } from '../../ports/diagnostic-log.js';

export class FileDiagnosticLog extends DiagnosticLog {
  constructor(directory, {
    maxBytes = 10 * 1024 * 1024,
    retainFiles = 5,
    timezone = 'Asia/Riyadh',
    sessionId = randomUUID(),
    clock = () => new Date()
  } = {}) {
    super();
    this.directory = directory;
    this.filePath = path.join(directory, 'service.ndjson');
    this.maxBytes = validateInteger(maxBytes, 64 * 1024, 1024 * 1024 * 1024, 'maxBytes');
    this.retainFiles = validateInteger(retainFiles, 1, 20, 'retainFiles');
    this.timezone = validateTimezone(timezone);
    this.sessionId = String(sessionId);
    this.clock = clock;
    this.writeChain = Promise.resolve();
  }

  async startSession(metadata = {}) {
    const operation = this.writeChain.then(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (await fileSize(this.filePath) > 0) await this.#rotate();
      const now = this.clock();
      const safeEntry = sanitize(this.#decorate({
        type: 'diagnostic_session_started',
        ...metadata,
        occurredAt: now.toISOString()
      }));
      await this.#append(`${JSON.stringify(safeEntry)}\n`);
      return safeEntry;
    });
    this.writeChain = operation.catch(() => {});
    return operation;
  }

  async write(entry) {
    const safeEntry = sanitize(this.#decorate(entry));
    const line = `${JSON.stringify(safeEntry)}\n`;
    const operation = this.writeChain.then(() => this.#append(line));
    this.writeChain = operation.catch(() => {});
    return operation;
  }

  #decorate(entry) {
    const rawOccurredAt = entry?.occurredAt || this.clock().toISOString();
    const occurredAtDate = new Date(rawOccurredAt);
    const validDate = Number.isNaN(occurredAtDate.getTime()) ? this.clock() : occurredAtDate;
    return {
      ...entry,
      occurredAt: validDate.toISOString(),
      occurredAtLocal: formatLocalIso(validDate, this.timezone),
      logTimezone: this.timezone,
      sessionId: this.sessionId
    };
  }

  async #append(line) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lineBytes = Buffer.byteLength(line, 'utf8');
    const currentBytes = await fileSize(this.filePath);
    if (currentBytes > 0 && currentBytes + lineBytes > this.maxBytes) await this.#rotate();
    await fs.appendFile(this.filePath, line, { encoding: 'utf8', mode: 0o600 });
  }

  async #rotate() {
    const oldest = `${this.filePath}.${this.retainFiles}`;
    await fs.rm(oldest, { force: true });
    for (let index = this.retainFiles - 1; index >= 1; index -= 1) {
      await renameIfExists(`${this.filePath}.${index}`, `${this.filePath}.${index + 1}`);
    }
    await renameIfExists(this.filePath, `${this.filePath}.1`);
  }
}

function sanitize(entry) {
  return redactObject({ ...entry });
}

function redactObject(value, keyName = '') {
  if (value == null) return value;
  if (isSecretKey(keyName)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redactObject(item));
  if (typeof value === 'object') {
    const output = {};
    for (const [key, nested] of Object.entries(value)) {
      if (['body', 'rawBody', 'template', 'biometricData'].includes(key)) continue;
      output[key] = redactObject(nested, key);
    }
    return output;
  }
  return value;
}

function isSecretKey(key) {
  const raw = String(key || '').trim();
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  if ([
    'password', 'passwd', 'pwd', 'secret', 'token', 'authorization',
    'apikey', 'commkey', 'communicationkey'
  ].includes(normalized)) return true;
  return normalized.endsWith('token') || normalized.endsWith('password') || normalized.endsWith('secret');
}

function validateInteger(value, min, max, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return number;
}

function validateTimezone(value) {
  const timezone = String(value || '').trim();
  if (!timezone) throw new Error('timezone is required');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new Error(`invalid timezone: ${timezone}`);
  }
  return timezone;
}

function formatLocalIso(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hourCycle: 'h23',
    timeZoneName: 'longOffset'
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
  const offset = String(parts.timeZoneName || 'GMT+00:00').replace('GMT', '') || '+00:00';
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${offset}`;
}

async function fileSize(filePath) {
  try { return (await fs.stat(filePath)).size; }
  catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

async function renameIfExists(from, to) {
  try { await fs.rename(from, to); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
