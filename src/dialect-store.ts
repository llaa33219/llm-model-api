// Shared Durable Object storage for Container probe results. The Container
// class extends DurableObject, so no second DO or hand-rolled alarm is needed.

import type {
  DialectRecord,
  DialectSnapshot,
  DialectTarget,
} from "./types";

export const DIALECT_CACHE_SCHEMA_VERSION = 3;
export const DIALECT_TTL_MS = 24 * 60 * 60 * 1000;
export const DIALECT_FAILURE_RETRY_MS = 5 * 60 * 1000;

// v2 stored raw POST endpoints in the public field. Keep its records dormant
// and use a new namespace so the 0.2.0 detector re-probes with SDK base URLs.
const META_KEY = "dialect:meta:v3";
const RECORD_PREFIX = "dialect:record:v3:";

interface Meta {
  schemaVersion: number;
  source: string | null;
  targets: DialectTarget[];
  /** Records written before activity tracking lack this field. */
  activeBase?: string | null;
  lastError: string | null;
  lastBatchAt: number | null;
  lastBatchDurationMs: number | null;
}

function emptyMeta(): Meta {
  return {
    schemaVersion: DIALECT_CACHE_SCHEMA_VERSION,
    source: null,
    targets: [],
    activeBase: null,
    lastError: null,
    lastBatchAt: null,
    lastBatchDurationMs: null,
  };
}

async function readMeta(storage: Pick<DurableObjectStorage, "get">): Promise<Meta> {
  const value = await storage.get<Meta>(META_KEY);
  return value?.schemaVersion === DIALECT_CACHE_SCHEMA_VERSION ? value : emptyMeta();
}

export class DialectStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  private async meta(): Promise<Meta> {
    return await readMeta(this.storage);
  }

  async configure(source: string, targets: DialectTarget[]): Promise<void> {
    // Container startup can probe before the first /sync arrives. Keep the
    // metadata read/modify/write atomic so /results cannot restore empty targets.
    await this.storage.transaction(async (txn) => {
      const meta = await readMeta(txn);
      if (meta.source === source) return;
      meta.source = source;
      meta.targets = targets;
      await txn.put(META_KEY, meta);

      const wanted = new Set(targets.map((target) => target.base));
      const records = await txn.list<DialectRecord>({ prefix: RECORD_PREFIX });
      const removed = [...records.keys()].filter((key) => !wanted.has(key.slice(RECORD_PREFIX.length)));
      if (removed.length > 0) await txn.delete(removed);
    });
  }

  async snapshot(): Promise<DialectSnapshot> {
    const [meta, records] = await Promise.all([
      this.meta(),
      this.storage.list<DialectRecord>({ prefix: RECORD_PREFIX }),
    ]);
    return {
      schemaVersion: DIALECT_CACHE_SCHEMA_VERSION,
      source: meta.source,
      targets: meta.targets,
      records: [...records.values()],
      refreshing: meta.activeBase !== null,
      activeBase: meta.activeBase ?? null,
      lastError: meta.lastError,
      lastBatchAt: meta.lastBatchAt,
      lastBatchDurationMs: meta.lastBatchDurationMs,
    };
  }

  async beginPass(base: string): Promise<void> {
    await this.storage.transaction(async (txn) => {
      const meta = await readMeta(txn);
      meta.activeBase = base;
      await txn.put(META_KEY, meta);
    });
  }

  async save(
    base: string,
    endpoints: DialectRecord["endpoints"],
    durationMs: number,
    error: string | null,
    rawEndpoints?: DialectRecord["rawEndpoints"],
  ): Promise<void> {
    await this.storage.transaction(async (txn) => {
      const now = Date.now();
      const previous = await txn.get<DialectRecord>(RECORD_PREFIX + base);
      const record: DialectRecord = {
        base,
        endpoints: error === null ? endpoints : previous?.endpoints ?? endpoints,
        rawEndpoints: error === null ? rawEndpoints : previous?.rawEndpoints ?? rawEndpoints,
        probedAt: now,
        durationMs,
        nextAttemptAt: now + (error === null ? DIALECT_TTL_MS : DIALECT_FAILURE_RETRY_MS),
        error,
      };
      await txn.put(RECORD_PREFIX + base, record);
    });
  }

  async completeBatch(startedAt: number, error: string | null): Promise<void> {
    await this.storage.transaction(async (txn) => {
      const meta = await readMeta(txn);
      meta.activeBase = null;
      meta.lastError = error;
      meta.lastBatchAt = Date.now();
      meta.lastBatchDurationMs = Date.now() - startedAt;
      await txn.put(META_KEY, meta);
    });
  }
}
