// Live-probed API-dialect cache, powered by the vendored llm-baseurl-detector
// (src/vendor/llm-baseurl-detector.ts). Detection is keyless — probes rely on
// dialect-specific error envelopes and validate-before-auth fingerprints.
//
// Refresh strategy ("갱신 타이밍"):
//   - Detection results are ~static (a provider's wire protocol changes rarely),
//     while probing is expensive (~14 candidate URLs per dialect per provider).
//     So dialects get their own 24h TTL, decoupled from the 10-minute models.dev TTL.
//   - A refresh is KICKED OFF when a handler call brings fresh models.dev data and
//     the dialect cache is (a) absent, (b) older than 24h, (c) failed last attempt,
//     or (d) built from a different provider api set.
//   - The refresh runs in the BACKGROUND via ctx.waitUntil — user requests never
//     block on probing; they are served the last-known map (or no dialects on a
//     cold isolate) and pick up the new data on later requests.
//   - Concurrent refreshes are deduped via a single in-flight promise.

import { detect } from "./vendor/llm-baseurl-detector";
import type { DialectEndpoints, DialectInfo, ModelsDevData, Provider } from "./types";

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
// Dialect results are in-memory only (no KV/R2/Cache Storage). Version the
// entry shape so a legacy flat {dialect: URL} map is never served as the new
// {supported, likely} shape if an isolate retains module state.
const CACHE_SCHEMA_VERSION = 2;

/** Hard cap on providers probed per refresh — bounds total wall time. */
const MAX_PROVIDERS_PER_REFRESH = 30;
/** Providers are probed this many at a time (each runs its own internal pool). */
const PROVIDER_CONCURRENCY = 6;
const PER_PROBE_TIMEOUT_MS = 4000;

/**
 * Canonical base URLs for providers whose models.dev entry omits `api`
 * (their official SDKs derive the URL internally, so models.dev leaves it
 * empty). Without this fallback the flagship providers — Anthropic, OpenAI,
 * Google — would never be probed at all. Keys are provider ids.
 *
 * Every probed host is trusted equally: detection is keyless, and both
 * envelope-confirmed "supported" and auth-wall "likely" verdicts surface
 * verbatim — the detector's fingerprint probes (validate-before-auth) are
 * what separate a real route from a gateway catch-all, and they run for
 * every host. Verified live: Together validates the body before auth on
 * /v1/messages (real anthropic route), DeepSeek answers its openai envelope
 * there (no route).
 */
const KNOWN_BASE_URLS: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  xai: "https://api.x.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  cohere: "https://api.cohere.com/v2",
  perplexity: "https://api.perplexity.ai",
  cerebras: "https://api.cerebras.ai/v1",
  togetherai: "https://api.together.xyz/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai",
};

/** Provider ids probed first when the per-refresh cap bites (flagships first). */
const NATIVE_FIRST = Object.keys(KNOWN_BASE_URLS);

interface CacheEntry {
  /** Response/cache schema; older entries are discarded, never migrated by guessing. */
  schemaVersion: number;
  /** provider id -> dialect info */
  map: Record<string, DialectInfo>;
  /** epoch ms when the last refresh COMPLETED successfully */
  fetchedAt: number;
  /** fingerprint of the provider api set this map was built from */
  source: string;
  /** distinct base URLs probed in the last refresh */
  probedCount: number;
  /** probed base URLs that yielded zero dialects (auth-walled everywhere) */
  silentCount: number;
  /** last refresh wall time */
  durationMs: number;
}

interface State {
  cache: CacheEntry | null;
  /** epoch ms of the last failed refresh attempt (backs off retries) */
  failedAt: number | null;
  inflight: Promise<void> | null;
  /** models.dev fetch timestamp the cache was last (re)built against */
  builtFromFetchedAt: number | null;
  refreshing: boolean;
}

const state: State = {
  cache: null,
  failedAt: null,
  inflight: null,
  builtFromFetchedAt: null,
  refreshing: false,
};

/**
 * Return only the current cache shape. A previous isolate/module cache has no
 * schemaVersion and is discarded here; the next refresh rebuilds it with the
 * confidence groups instead of exposing ambiguous legacy endpoints.
 */
function currentCache(): CacheEntry | null {
  const cache = state.cache;
  if (
    cache !== null &&
    (cache as Partial<CacheEntry>).schemaVersion !== CACHE_SCHEMA_VERSION
  ) {
    state.cache = null;
    return null;
  }
  return cache;
}

function sourceFingerprint(data: ModelsDevData): string {
  return Object.entries(data)
    .map(([id, p]) => `${id}:${p.api ?? KNOWN_BASE_URLS[id] ?? ""}`)
    .sort()
    .join("|");
}

function isAbsoluteHttpUrl(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

/** Resolve a provider's probeable base URL: models.dev `api`, else the known fallback. */
export function baseUrlOf(id: string, p: Provider): string | null {
  const raw = p.api ?? KNOWN_BASE_URLS[id] ?? null;
  if (raw === null || !isAbsoluteHttpUrl(raw)) return null; // skips ${ENV} placeholders
  return raw;
}

/** Providers worth probing: have (or fall back to) a real absolute http(s) base URL. */
function probeableProviders(data: ModelsDevData): Array<[string, Provider, string]> {
  const entries: Array<[string, Provider, string]> = [];
  for (const [id, p] of Object.entries(data)) {
    const base = baseUrlOf(id, p);
    if (base !== null) entries.push([id, p, base]);
  }
  // Flagship native-dialect providers first, so the cap never crowds out the
  // providers users most often inspect; the rest alphabetical for determinism.
  entries.sort(([a], [b]) => {
    const ia = NATIVE_FIRST.indexOf(a);
    const ib = NATIVE_FIRST.indexOf(b);
    const ra = ia === -1 ? NATIVE_FIRST.length : ia;
    const rb = ib === -1 ? NATIVE_FIRST.length : ib;
    return ra - rb || a.localeCompare(b);
  });
  return entries;
}

async function refresh(data: ModelsDevData): Promise<void> {
  const started = Date.now();
  const targets = probeableProviders(data).slice(0, MAX_PROVIDERS_PER_REFRESH);

  // Dedupe identical base URLs so 193 openai-compatible twins don't each re-probe
  // the same host — results are shared by URL afterwards.
  const byBase = new Map<string, string[]>();
  for (const [id, , rawBase] of targets) {
    const base = rawBase.replace(/\/+$/, "");
    const slot = byBase.get(base);
    if (slot) slot.push(id);
    else byBase.set(base, [id]);
  }

  const perUrl = new Map<string, DialectInfo>();
  const bases = [...byBase.keys()];
  let cursor = 0;
  const worker = async () => {
    while (cursor < bases.length) {
      const base = bases[cursor++]!;
      try {
        const result = await detect(base, {
          timeoutMs: PER_PROBE_TIMEOUT_MS,
          concurrency: 6,
          // Every host keeps all five dialects. Preserve the detector's exact
          // confidence: supported and likely must never be presented as one set.
        });
        const endpoints: DialectEndpoints = { supported: {}, likely: {} };
        for (const probe of result.probes) {
          if (probe.dialect === "models-list") continue;
          if (probe.status === "supported" || probe.status === "likely") {
            endpoints[probe.status][probe.dialect] = probe.probedUrl;
          }
        }
        const sorted: DialectEndpoints = {
          supported: Object.fromEntries(
            Object.entries(endpoints.supported).sort(([a], [b]) => a.localeCompare(b)),
          ),
          likely: Object.fromEntries(
            Object.entries(endpoints.likely).sort(([a], [b]) => a.localeCompare(b)),
          ),
        };
        perUrl.set(base, {
          endpoints: sorted,
          probedAt: Date.now(),
          durationMs: result.durationMs,
        });
      } catch {
        // A whole-provider failure (invalid URL etc.) leaves the provider without
        // dialect info; it will be retried on the next refresh cycle.
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PROVIDER_CONCURRENCY, bases.length) }, worker),
  );

  const map: Record<string, DialectInfo> = {};
  let silentCount = 0;
  for (const [base, ids] of byBase) {
    const info = perUrl.get(base);
    // Skip bases whose probes found nothing (every candidate auth-walled or
    // unreachable) — an empty endpoints object is noise in the response.
    if (
      !info ||
      (Object.keys(info.endpoints.supported).length === 0 &&
        Object.keys(info.endpoints.likely).length === 0)
    ) {
      silentCount++;
      continue;
    }
    for (const id of ids) map[id] = info;
  }

  state.cache = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    map,
    fetchedAt: Date.now(),
    source: sourceFingerprint(data),
    probedCount: bases.length,
    silentCount,
    durationMs: Date.now() - started,
  };
  state.failedAt = null;
}

/**
 * Serve the cached dialect info for a provider, if any.
 * Never blocks — returns whatever the last completed refresh produced.
 */
export function getDialectInfo(providerId: string): DialectInfo | null {
  return currentCache()?.map[providerId] ?? null;
}

/**
 * Consider kicking off a background dialect refresh.
 * Call this with fresh models.dev data; the caller MUST pass the returned promise
 * to ctx.waitUntil (or otherwise keep it referenced) so the isolate stays alive.
 * Returns null when no refresh was started.
 */
export function maybeRefreshDialects(
  data: ModelsDevData,
  dataFetchedAt: number | null,
): Promise<void> | null {
  const now = Date.now();
  const cache = currentCache();
  const source = sourceFingerprint(data);
  const stale = cache === null || now - cache.fetchedAt >= TTL_MS;
  const sourceChanged = cache !== null && cache.source !== source;
  const lastAttemptFailed =
    state.failedAt !== null && now - state.failedAt >= 5 * 60 * 1000; // 5-min backoff after a failed refresh
  // Don't loop a refresh on every models.dev refetch when nothing changed.
  const alreadyBuiltFromThisData =
    cache !== null &&
    !stale &&
    !sourceChanged &&
    cache.source === source;
  if (alreadyBuiltFromThisData) return null;
  if (!stale && !sourceChanged && !lastAttemptFailed) return null;
  if (state.inflight !== null) return state.inflight;

  state.refreshing = true;
  state.builtFromFetchedAt = dataFetchedAt;
  state.inflight = refresh(data)
    .catch(() => {
      state.failedAt = Date.now();
    })
    .finally(() => {
      state.inflight = null;
      state.refreshing = false;
    });
  return state.inflight;
}

/** Diagnostics for /cache-status. */
export function dialectCacheStatus(): Record<string, unknown> {
  const now = Date.now();
  const cache = currentCache();
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    ttlMs: TTL_MS,
    refreshing: state.refreshing,
    builtFromFetchedAt: state.builtFromFetchedAt,
    hasData: cache !== null,
    fetchedAt: cache?.fetchedAt ?? null,
    ageMs: cache ? now - cache.fetchedAt : null,
    isStale: cache === null ? true : now - cache.fetchedAt >= TTL_MS,
    providersWithDialects: cache ? Object.keys(cache.map).length : 0,
    probedBaseUrls: cache?.probedCount ?? 0,
    silentBaseUrls: cache?.silentCount ?? 0,
    lastRefreshDurationMs: cache?.durationMs ?? null,
    lastFailedAt: state.failedAt,
    maxProvidersPerRefresh: MAX_PROVIDERS_PER_REFRESH,
    note: "keyless live probing via vendored llm-baseurl-detector; supported = confirmed; likely = tentative; every host probed for all five dialects",
  };
}
