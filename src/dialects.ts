// In-isolate read cache for Durable Object-backed dialect results.
// Third-party probing happens only in the Cloudflare Container, driven by DO
// alarms. A Worker request performs at most a tiny internal target-list sync.

import { getDialectSnapshot, syncDialectDetector } from "./dialect-client";
import { DIALECT_CACHE_SCHEMA_VERSION } from "./dialect-coordinator";
import { dialectSourceFingerprint, dialectTargets } from "./dialect-targets";
import type { DialectEndpoints, DialectSnapshot, Env, ModelsDevData } from "./types";

// Accept an optional namespace for small, deterministic handler tests. Runtime
// callers simply pass the bound Env object.
type DialectEnv = Pick<Env, "DIALECT_DETECTOR">;

const SNAPSHOT_TTL_MS = 5000;
const SYNC_THROTTLE_MS = 60 * 1000;
const DIALECT_TTL_MS = 24 * 60 * 60 * 1000;
let snapshotCache: { value: DialectSnapshot; fetchedAt: number } | null = null;
let pendingSync: Promise<DialectSnapshot> | null = null;
let lastSyncAt = 0;
let lastSyncSource = "";
let lastSyncError: string | null = null;

function emptySnapshot(): DialectSnapshot {
  return {
    schemaVersion: DIALECT_CACHE_SCHEMA_VERSION,
    source: null,
    targets: [],
    records: [],
    refreshing: false,
    lastError: null,
    lastBatchAt: null,
    lastBatchDurationMs: null,
  };
}

async function readSnapshot(env: DialectEnv): Promise<DialectSnapshot> {
  const now = Date.now();
  if (snapshotCache && now - snapshotCache.fetchedAt < SNAPSHOT_TTL_MS) {
    return snapshotCache.value;
  }
  try {
    const value = await getDialectSnapshot(env);
    if (value.schemaVersion !== DIALECT_CACHE_SCHEMA_VERSION) {
      return snapshotCache?.value ?? emptySnapshot();
    }
    snapshotCache = { value, fetchedAt: now };
    return value;
  } catch (error) {
    lastSyncError = error instanceof Error ? error.message : String(error);
    console.error(`Dialect state read failed: ${lastSyncError}`);
    return snapshotCache?.value ?? emptySnapshot();
  }
}

export function scheduleDialectSync(env: DialectEnv, ctx: ExecutionContext, data: ModelsDevData): void {
  const source = dialectSourceFingerprint(data);
  if (source === lastSyncSource && Date.now() - lastSyncAt < SYNC_THROTTLE_MS) return;
  if (pendingSync) {
    ctx.waitUntil(pendingSync);
    return;
  }
  lastSyncSource = source;
  lastSyncAt = Date.now();
  pendingSync = syncDialectDetector(env, source, dialectTargets(data))
    .then((value) => {
      if (value.schemaVersion === DIALECT_CACHE_SCHEMA_VERSION) {
        snapshotCache = { value, fetchedAt: Date.now() };
      }
      lastSyncError = null;
      return value;
    })
    .catch((error) => {
      lastSyncError = error instanceof Error ? error.message : String(error);
      console.error(`Dialect detector sync failed: ${lastSyncError}`);
      throw error;
    })
    .finally(() => {
      pendingSync = null;
    });
  ctx.waitUntil(pendingSync);
}

function lookupEndpoints(providerId: string, snapshot: DialectSnapshot): DialectEndpoints | null {
  const recordByBase = new Map(snapshot.records.map((record) => [record.base, record]));
  for (const target of snapshot.targets) {
    if (!target.providers.includes(providerId)) continue;
    const record = recordByBase.get(target.base);
    if (!record || record.nextAttemptAt <= Date.now()) return null;
    if (
      Object.keys(record.endpoints.supported).length === 0 &&
      Object.keys(record.endpoints.likely).length === 0
    ) return null;
    return record.endpoints;
  }
  return null;
}

export async function dialectMapForModels(env: DialectEnv): Promise<ReadonlyMap<string, DialectEndpoints>> {
  const snapshot = await readSnapshot(env);
  const map = new Map<string, DialectEndpoints>();
  for (const target of snapshot.targets) {
    const endpoints = lookupEndpoints(target.providers[0] ?? "", snapshot);
    if (!endpoints) continue;
    for (const provider of target.providers) map.set(provider, endpoints);
  }
  return map;
}

export async function dialectCacheStatus(env: DialectEnv): Promise<Record<string, unknown>> {
  const snapshot = await readSnapshot(env);
  const validRecords = snapshot.records.filter((record) => record.nextAttemptAt > Date.now());
  return {
    schemaVersion: snapshot.schemaVersion,
    backend: "cloudflare-container+durable-object",
    ttlMs: DIALECT_TTL_MS,
    refreshing: snapshot.refreshing,
    hasData: validRecords.some((record) =>
      Object.keys(record.endpoints.supported).length > 0 ||
      Object.keys(record.endpoints.likely).length > 0
    ),
    targetBaseUrls: snapshot.targets.length,
    providersWithDialects: snapshot.targets.filter((target) =>
      target.providers.some((id) => lookupEndpoints(id, snapshot) !== null)
    ).reduce((count, target) => count + target.providers.length, 0),
    probedBaseUrls: validRecords.length,
    failedBaseUrls: validRecords.filter((record) => record.error !== null).length,
    lastBatchAt: snapshot.lastBatchAt,
    lastBatchDurationMs: snapshot.lastBatchDurationMs,
    lastError: snapshot.lastError ?? lastSyncError,
    note: "actual npm llm-baseurl-detector in a singleton container; per-base results persist immediately in Durable Object storage and refresh incrementally via alarms",
  };
}
