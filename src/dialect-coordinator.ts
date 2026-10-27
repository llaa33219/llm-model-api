// Persistence and scheduling for the singleton dialect detector Durable Object.
// Kept independent of the Containers API so the batching and recovery behavior
// can be tested with an in-memory storage adapter.

import type {
  DialectRecord,
  DialectSnapshot,
  DialectTarget,
} from "./types";

export const DIALECT_CACHE_SCHEMA_VERSION = 2;
export const DIALECT_TTL_MS = 24 * 60 * 60 * 1000;
export const DIALECT_FAILURE_RETRY_MS = 5 * 60 * 1000;
export const PROVIDERS_PER_ALARM_BATCH = 3;

const META_KEY = "meta:v2";
const RECORD_PREFIX = "record:v2:";
const SUCCESS_RETRY_MS = DIALECT_TTL_MS;

interface Meta {
  schemaVersion: number;
  source: string | null;
  targets: DialectTarget[];
  cursor: number;
  refreshing: boolean;
  lastError: string | null;
  lastBatchAt: number | null;
  lastBatchDurationMs: number | null;
}

export interface ProbeOutcome {
  endpoints: DialectRecord["endpoints"];
  durationMs: number;
}

export type ProbeFunction = (base: string) => Promise<ProbeOutcome>;

function emptyMeta(): Meta {
  return {
    schemaVersion: DIALECT_CACHE_SCHEMA_VERSION,
    source: null,
    targets: [],
    cursor: 0,
    refreshing: false,
    lastError: null,
    lastBatchAt: null,
    lastBatchDurationMs: null,
  };
}

function recordKey(base: string): string {
  return RECORD_PREFIX + base;
}

export class DialectCoordinator {
  private activeBatch = false;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly probe: ProbeFunction,
  ) {}

  private async meta(): Promise<Meta> {
    const meta = await this.storage.get<Meta>(META_KEY);
    if (!meta || meta.schemaVersion !== DIALECT_CACHE_SCHEMA_VERSION) {
      return emptyMeta();
    }
    return meta;
  }

  /** Update the desired provider set and ensure a due alarm exists. */
  async sync(source: string, targets: DialectTarget[]): Promise<DialectSnapshot> {
    const meta = await this.meta();
    if (meta.source !== source) {
      meta.source = source;
      meta.targets = targets;
      meta.cursor = targets.length === 0 ? 0 : meta.cursor % targets.length;
      await this.storage.put(META_KEY, meta);

      // Do not let removed base URLs accumulate forever. Existing results for
      // unchanged URLs remain valid and are reused across models.dev updates.
      const wanted = new Set(targets.map((target) => recordKey(target.base)));
      const oldRecords = await this.storage.list({ prefix: RECORD_PREFIX });
      const removed = [...oldRecords.keys()].filter((key) => !wanted.has(key));
      if (removed.length > 0) await this.storage.delete(removed);
    }
    await this.ensureAlarm();
    return this.snapshot();
  }

  async snapshot(): Promise<DialectSnapshot> {
    const [meta, records] = await Promise.all([this.meta(), this.storage.list<DialectRecord>({
      prefix: RECORD_PREFIX,
    })]);
    return {
      schemaVersion: DIALECT_CACHE_SCHEMA_VERSION,
      source: meta.source,
      targets: meta.targets,
      records: [...records.values()],
      refreshing: this.activeBatch || meta.refreshing,
      lastError: meta.lastError,
      lastBatchAt: meta.lastBatchAt,
      lastBatchDurationMs: meta.lastBatchDurationMs,
    };
  }

  /**
   * Process a small bounded batch. Each URL is persisted before the next one
   * starts, so eviction, a failed container, or a later timeout cannot discard
   * earlier successes. The alarm reschedules itself until every target is fresh.
   */
  async alarm(): Promise<void> {
    if (this.activeBatch) return;
    this.activeBatch = true;
    const startedAt = Date.now();
    const meta = await this.meta();
    meta.refreshing = true;
    await this.storage.put(META_KEY, meta);

    try {
      let processed = 0;
      // Scan at most one full cycle. Fresh entries are skipped without probing.
      for (
        let scanned = 0;
        scanned < meta.targets.length && processed < PROVIDERS_PER_ALARM_BATCH;
        scanned++
      ) {
        const target = meta.targets[meta.cursor]!;
        meta.cursor = (meta.cursor + 1) % meta.targets.length;
        const existing = await this.storage.get<DialectRecord>(recordKey(target.base));
        if (existing && existing.nextAttemptAt > Date.now()) continue;

        const attemptedAt = Date.now();
        let record: DialectRecord;
        try {
          const outcome = await this.probe(target.base);
          record = {
            base: target.base,
            endpoints: outcome.endpoints,
            probedAt: attemptedAt,
            durationMs: outcome.durationMs,
            nextAttemptAt: attemptedAt + SUCCESS_RETRY_MS,
            error: null,
          };
          meta.lastError = null;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Dialect probe failed for ${target.base}: ${message}`);
          record = {
            base: target.base,
            // A transient failure must not erase the last known good result.
            endpoints: existing?.endpoints ?? { supported: {}, likely: {} },
            probedAt: attemptedAt,
            durationMs: Date.now() - attemptedAt,
            nextAttemptAt: attemptedAt + DIALECT_FAILURE_RETRY_MS,
            error: message,
          };
          meta.lastError = message;
        }
        // This write is deliberately inside the loop: partial progress is durable.
        await this.storage.put(recordKey(target.base), record);
        await this.storage.put(META_KEY, meta);
        processed++;
      }
    } catch (error) {
      meta.lastError = error instanceof Error ? error.message : String(error);
      console.error(`Dialect alarm failed: ${meta.lastError}`);
    } finally {
      meta.refreshing = false;
      meta.lastBatchAt = Date.now();
      meta.lastBatchDurationMs = Date.now() - startedAt;
      await this.storage.put(META_KEY, meta);
      // Keep the batch marker set while scheduling the next alarm. Otherwise
      // an interleaved sync could skip ensureAlarm before the marker clears.
      await this.ensureAlarm();
      this.activeBatch = false;
    }
  }

  private async ensureAlarm(): Promise<void> {
    if (this.activeBatch) return;
    const [meta, records, currentAlarm] = await Promise.all([
      this.meta(),
      this.storage.list<DialectRecord>({ prefix: RECORD_PREFIX }),
      this.storage.getAlarm(),
    ]);
    if (meta.targets.length === 0) {
      if (currentAlarm !== null) await this.storage.deleteAlarm();
      return;
    }

    const now = Date.now();
    let nextAlarm = Number.POSITIVE_INFINITY;
    for (const target of meta.targets) {
      const record = records.get(recordKey(target.base));
      const due = record?.nextAttemptAt ?? now;
      nextAlarm = Math.min(nextAlarm, due);
    }
    if (!Number.isFinite(nextAlarm)) return;
    // Yield briefly between batches so snapshot/sync requests stay responsive.
    const desired = nextAlarm <= now ? now + 1000 : nextAlarm;
    if (currentAlarm === null || desired < currentAlarm) {
      await this.storage.setAlarm(desired);
    }
  }
}
