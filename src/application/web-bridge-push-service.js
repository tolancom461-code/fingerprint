import fs from 'node:fs/promises';
import path from 'node:path';

const PAGE_LIMIT = 100;
const TAIL_PAGE_LIMIT = 500;

export class WebBridgePushService {
  constructor({
    finalEventsReadService,
    targetUrl,
    token,
    stateFile,
    intervalSeconds = 10,
    requestTimeoutSeconds = 10,
    diagnosticLog = null,
    fetchImpl = globalThis.fetch
  }) {
    this.finalEventsReadService = finalEventsReadService;
    this.targetUrl = targetUrl;
    this.token = token;
    this.stateFile = stateFile;
    this.intervalSeconds = intervalSeconds;
    this.requestTimeoutSeconds = requestTimeoutSeconds;
    this.diagnosticLog = diagnosticLog;
    this.fetchImpl = fetchImpl;
    this.timer = null;
    this.running = false;
    this.stopped = false;
    this.lastErrorKey = '';
    this.lastErrorLoggedAt = 0;
  }

  async runOnce() {
    const state = await readState(this.stateFile);
    if (!state) {
      const tail = await this.#discoverTail();
      await writeState(this.stateFile, { cursor: tail.cursor });
      return { state: 'initialized', cursor: tail.cursor, skippedHistorical: tail.seen, pushed: 0, counts: {} };
    }

    const page = await this.finalEventsReadService.list({ afterId: state.cursor, limit: PAGE_LIMIT });
    if (page.items.length === 0) {
      if (page.page.nextAfterId !== state.cursor) {
        await writeState(this.stateFile, { cursor: page.page.nextAfterId });
      }
      return { state: 'polled', cursor: page.page.nextAfterId, skippedHistorical: 0, pushed: 0, counts: {} };
    }

    const response = await this.#pushBatch(page.items, page.page.nextAfterId);
    await writeState(this.stateFile, { cursor: page.page.nextAfterId });
    return {
      state: 'pushed',
      cursor: page.page.nextAfterId,
      skippedHistorical: 0,
      pushed: page.items.length,
      counts: summarizeResults(response.results)
    };
  }

  start() {
    if (this.timer) return () => this.stop();
    this.stopped = false;
    const intervalMs = this.intervalSeconds * 1000;
    const run = async () => {
      if (this.stopped || this.running) return;
      this.running = true;
      try {
        const result = await this.runOnce();
        this.lastErrorKey = '';
        if (result.state === 'initialized') {
          console.log(`[biometric-service] web bridge cursor initialized at ${result.cursor}; historical events skipped: ${result.skippedHistorical}`);
        } else if (result.state === 'pushed') {
          console.log(`[biometric-service] web bridge pushed ${result.pushed}; cursor=${result.cursor}; results=${JSON.stringify(result.counts)}`);
        }
      } catch (error) {
        await this.#logError(error);
      } finally {
        this.running = false;
      }
    };

    void run();
    this.timer = setInterval(() => void run(), intervalMs);
    this.timer.unref?.();
    return () => this.stop();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async #discoverTail() {
    let cursor = '0';
    let seen = 0;
    while (true) {
      const page = await this.finalEventsReadService.list({ afterId: cursor, limit: TAIL_PAGE_LIMIT });
      seen += page.items.length;
      if (page.page.hasMore && page.page.nextAfterId === cursor) {
        throw new Error('Web bridge Final Events cursor did not advance during initialization');
      }
      cursor = page.page.nextAfterId;
      if (!page.page.hasMore) return { cursor, seen };
    }
  }

  async #pushBatch(events, sourceCursor) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutSeconds * 1000);
    try {
      const response = await this.fetchImpl(this.targetUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ apiVersion: 'v1', sourceCursor, events }),
        redirect: 'error',
        signal: controller.signal
      });

      if (response.status === 401 || response.status === 403) {
        const error = new Error('web bridge authentication failed');
        error.code = 'AUTH_FAILED';
        throw error;
      }
      if (!response.ok) {
        const error = new Error(`web bridge target returned HTTP ${response.status}`);
        error.code = 'UNAVAILABLE';
        throw error;
      }

      let json;
      try {
        json = await response.json();
      } catch {
        const error = new Error('web bridge target returned invalid JSON');
        error.code = 'BAD_RESPONSE';
        throw error;
      }
      assertBridgeResponse(json, events);
      return json;
    } catch (error) {
      if (error?.name === 'AbortError') {
        const timeoutError = new Error('web bridge request timed out');
        timeoutError.code = 'UNAVAILABLE';
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #logError(error) {
    const code = error?.code ?? error?.name ?? 'ERROR';
    const message = error instanceof Error ? error.message : String(error);
    const key = `${code}:${message}`;
    const now = Date.now();
    if (key !== this.lastErrorKey || now - this.lastErrorLoggedAt >= 60_000) {
      console.warn(`[biometric-service] web bridge error (${code}): ${message}`);
      this.lastErrorKey = key;
      this.lastErrorLoggedAt = now;
    }
    await this.diagnosticLog?.write?.({
      type: 'web_bridge_push_error',
      code,
      message,
      occurredAt: new Date().toISOString()
    }).catch(() => {});
  }
}

function assertBridgeResponse(value, sentEvents) {
  if (!value || value.ok !== true || value.apiVersion !== 'v1' || !Array.isArray(value.results)) {
    const error = new Error('web bridge target returned an unexpected response');
    error.code = 'BAD_RESPONSE';
    throw error;
  }
  if (value.received !== sentEvents.length || value.results.length !== sentEvents.length) {
    const error = new Error('web bridge target did not acknowledge the complete batch');
    error.code = 'BAD_RESPONSE';
    throw error;
  }
  const expectedIds = new Set(sentEvents.map((event) => String(event.eventId)));
  for (const result of value.results) {
    if (!result || typeof result.eventId !== 'string' || !expectedIds.has(result.eventId) || typeof result.status !== 'string') {
      const error = new Error('web bridge target returned invalid event acknowledgements');
      error.code = 'BAD_RESPONSE';
      throw error;
    }
    expectedIds.delete(result.eventId);
  }
  if (expectedIds.size !== 0) {
    const error = new Error('web bridge target omitted event acknowledgements');
    error.code = 'BAD_RESPONSE';
    throw error;
  }
}

function summarizeResults(results) {
  const counts = {};
  for (const result of results ?? []) counts[result.status] = (counts[result.status] ?? 0) + 1;
  return counts;
}

async function readState(stateFile) {
  let raw;
  try {
    raw = await fs.readFile(stateFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('web bridge state file is not valid JSON');
  }
  const cursor = String(value?.cursor ?? '').trim();
  if (!/^\d+$/.test(cursor)) throw new Error('web bridge state file has an invalid cursor');
  return { cursor };
}

async function writeState(stateFile, { cursor }) {
  const normalized = String(cursor ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error('web bridge cursor is invalid');
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  const temp = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify({ version: 1, cursor: normalized, updatedAt: new Date().toISOString() }, null, 2) + '\n';
  await fs.writeFile(temp, body, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, stateFile);
}
