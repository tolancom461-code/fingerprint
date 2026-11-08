import fs from 'node:fs/promises';
import path from 'node:path';
import { PunchStore } from '../../ports/punch-store.js';
import { createLegacyScopedPunchKey } from '../../domain/storage-identity.js';

export class FilePunchStore extends PunchStore {
  constructor(directory) {
    super();
    // Keep the existing filename so previously proven real-device captures
    // remain available without migration or rewriting.
    this.directory = directory;
    this.filePath = path.join(directory, 'attlog.ndjson');
    this.seen = new Set();
    this.legacySeen = new Set();
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
          const record = JSON.parse(line);
          if (record.eventKey) {
            this.seen.add(record.eventKey);
            const legacyKey = safeLegacyKey(record.vendor, record.serialNumber, record.eventKey);
            if (legacyKey) this.legacySeen.add(legacyKey);
          }
          if (record.legacyEventKey) {
            const legacyKey = safeLegacyKey(record.vendor, record.serialNumber, record.legacyEventKey);
            if (legacyKey) this.legacySeen.add(legacyKey);
          }
        } catch {
          // A malformed historical lab line must not stop new captures.
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    this.ready = true;
  }

  async putIfAbsent(punch) {
    const task = this.queue.then(() => this.#putIfAbsentSerial(punch));
    this.queue = task.catch(() => {});
    return task;
  }

  async #putIfAbsentSerial(punch) {
    await this.init();
    if (this.seen.has(punch.eventKey)) return { status: 'duplicate' };

    // v0.7 canonical files used the vendor dedupe key directly as eventKey.
    // This scoped compatibility check prevents an upgrade replay from appending
    // the same physical event under the new globally-qualified key.
    const legacyKey = punch.legacyEventKey
      ? safeLegacyKey(punch.vendor, punch.serialNumber, punch.legacyEventKey)
      : null;
    if (legacyKey && this.legacySeen.has(legacyKey)) return { status: 'duplicate' };

    const handle = await fs.open(this.filePath, 'a', 0o600);
    try {
      await handle.write(`${JSON.stringify(punch)}\n`, null, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    this.seen.add(punch.eventKey);
    if (legacyKey) this.legacySeen.add(legacyKey);
    return { status: 'inserted' };
  }
}

function safeLegacyKey(vendor, serialNumber, eventKey) {
  try {
    return createLegacyScopedPunchKey({ vendor, serialNumber, eventKey });
  } catch {
    return null;
  }
}
