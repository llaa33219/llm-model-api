// Shared Durable Object storage for Container probe results. The Container
// class extends DurableObject, so no second DO or hand-rolled alarm is needed.

import type {
  DialectRecord,
  DialectSnapshot,
  DialectTarget,
} from "./types";

export const DIALECT_CACHE_SCHEMA_VERSION = 2;
export const DIALECT_TTL_MS = 24 * 60 * 60 * 1000;
export const DIALECT_FAILURE_RETRY_MS = 5 * 60 * 1000;

const META_KEY = "dialect:meta:v2";
const RECORD_PREFIX = "dialect:record:v2:";

interface Meta {
  schemaVersion: number;
  source: string | null;
  targets: DialectTarget[];
  /** v2 records did not have this field; null is the compatible default. */
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

export class DialectStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  private async meta(): Promise<Meta> {
    const value = await this.storage.get<Meta>(META_KEY);
    return value?.schemaVersion === DIALECT_CACHE_SCHEMA_VERSION ? value : emptyMeta();
  }

  async configure(source: string, targets: DialectTarget[]): Promise<void> {
    const meta = await this.meta();
    if (meta.source === source) return;
    meta.source = source;
    meta.targets = targets;
    await this.storage.put(META_KEY, meta);

    const wanted = new Set(targets.map((target) => target.base));
    const records = await this.storage.list<DialectRecord>({ prefix: RECORD_PREFIX });
    const removed = [...records.keys()].filter((key) => !wanted.has(key.slice(RECORD_PREFIX.length)));
    if (removed.length > 0) await this.storage.delete(removed);
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
    const meta = await this.meta();
    meta.activeBase = base;
    await this.storage.put(META_KEY, meta);
  }

  async save(
    base: string,
    endpoints: DialectRecord["endpoints"],
    durationMs: number,
    error: string | null,
  ): Promise<void> {
    const now = Date.now();
    const previous = await this.storage.get<DialectRecord>(RECORD_PREFIX + base);
    const record: DialectRecord = {
      base,
      endpoints: error === null ? endpoints : previous?.endpoints ?? endpoints,
      probedAt: now,
      durationMs,
      nextAttemptAt: now + (error === null ? DIALECT_TTL_MS : DIALECT_FAILURE_RETRY_MS),
      error,
    };
    await this.storage.put(RECORD_PREFIX + base, record);
  }

  async completeBatch(startedAt: number, error: string | null): Promise<void> {
    const meta = await this.meta();
    meta.activeBase = null;
    meta.lastError = error;
    meta.lastBatchAt = Date.now();
    meta.lastBatchDurationMs = Date.now() - startedAt;
    await this.storage.put(META_KEY, meta);
  }
}
