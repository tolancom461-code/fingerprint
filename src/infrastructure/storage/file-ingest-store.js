import fs from 'node:fs/promises';
import path from 'node:path';
import { IngestStore } from '../../ports/ingest-store.js';
import { resolveIngestStorageKey, STORAGE_IDENTITY_VERSION } from '../../domain/storage-identity.js';

export class FileIngestStore extends IngestStore {
  constructor(directory) {
    super();
    this.directory = directory;
    this.filePath = path.join(directory, 'ingest.ndjson');
    this.records = new Map();
    this.ready = false;
    this.queue = Promise.resolve();
  }

  async init() {
    if (this.ready) return;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const historical = JSON.parse(line);
          const storageKey = resolveIngestStorageKey(historical);
          if (!this.records.has(storageKey)) {
            // v0.7 ingest files used dedupeKey as ingestKey. Normalize in memory
            // without rewriting historical evidence on disk.
            const record = {
              ...historical,
              ingestKey: storageKey,
              storageIdentityVersion: historical.storageIdentityVersion ?? STORAGE_IDENTITY_VERSION
            };
            this.records.set(storageKey, record);
          }
        } catch {
          // A malformed historical lab line must not stop new durable captures.
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    this.ready = true;
  }

  async putIfAbsent(event) {
    const task = this.queue.then(() => this.#putIfAbsentSerial(event));
    this.queue = task.catch(() => {});
    return task;
  }

  async #putIfAbsentSerial(event) {
    await this.init();
    const storageKey = resolveIngestStorageKey(event);
    const existing = this.records.get(storageKey);
    if (existing) return { status: 'duplicate', record: existing };

    const normalizedEvent = event.ingestKey === storageKey ? event : { ...event, ingestKey: storageKey };
    const handle = await fs.open(this.filePath, 'a', 0o600);
    try {
      await handle.write(`${JSON.stringify(normalizedEvent)}\n`, null, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    this.records.set(storageKey, normalizedEvent);
    return { status: 'inserted', record: normalizedEvent };
  }

  async list() {
    await this.init();
    return [...this.records.values()];
  }
}
