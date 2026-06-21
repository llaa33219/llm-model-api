// Cached fetch of https://models.dev/api.json with a 10-minute TTL.
//
// Cache strategy:
//   - Module-level `cache` survives across requests within the same isolate.
//   - `inflight` dedupes concurrent refreshes so we never hit models.dev twice
//     when many requests arrive simultaneously after the TTL expires.
//   - TTL = 10 minutes — balances freshness (models.dev updates frequently)
//     against request volume on models.dev.

import type { ModelsDevData } from "./types";

const SOURCE_URL = "https://models.dev/api.json";
const TTL_MS = 10 * 60 * 1000; // 10 minutes

interface CacheEntry {
  data: ModelsDevData;
  fetchedAt: number;
}

let cache: CacheEntry | null = null;
let inflight: Promise<ModelsDevData> | null = null;

async function refresh(): Promise<ModelsDevData> {
  const res = await fetch(SOURCE_URL, {
    headers: { Accept: "application/json" },
    // Cloudflare's fetch cache respects this implicitly via the default cache key;
    // we rely on the module-level cache for TTL.
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${SOURCE_URL}: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as ModelsDevData;
  cache = { data, fetchedAt: Date.now() };
  return data;
}

/**
 * Returns the latest models.dev data, refreshing in the background when stale.
 *
 * On a cache miss OR stale entry, the FIRST caller triggers an await on refresh
 * while subsequent concurrent callers reuse the same in-flight promise. After
 * the TTL expires, the next call refreshes synchronously (we don't return stale
 * data when stale — the user wants fresher data once 10 minutes have passed).
 */
export async function getData(): Promise<ModelsDevData> {
  const now = Date.now();
  if (cache !== null && now - cache.fetchedAt < TTL_MS) {
    return cache.data;
  }
  if (inflight === null) {
    inflight = refresh().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** For diagnostics / debugging. */
export function cacheStatus(): {
  hasData: boolean;
  fetchedAt: number | null;
  ageMs: number | null;
  ttlMs: number;
  isStale: boolean;
} {
  if (cache === null) {
    return { hasData: false, fetchedAt: null, ageMs: null, ttlMs: TTL_MS, isStale: true };
  }
  const ageMs = Date.now() - cache.fetchedAt;
  return {
    hasData: true,
    fetchedAt: cache.fetchedAt,
    ageMs,
    ttlMs: TTL_MS,
    isStale: ageMs >= TTL_MS,
  };
}