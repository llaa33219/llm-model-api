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
import type { DialectId } from "./vendor/llm-baseurl-detector";
import type { DialectInfo, ModelsDevData, Provider } from "./types";

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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
 * `likelyTrust` caps how much weight a "likely"-grade verdict carries for that
 * host: on dedicated first-party API hosts (api.openai.com etc.) an auth-wall
 * "likely" is reliable — these hosts exist solely to serve their own API.
 * On multi-tenant gateways "likely" is often just the gateway's global auth
 * wall answering for a route that does not exist (observed: cohere.com/v2 and
 * mistral.ai "detecting" anthropic-messages/typesafe-systemone keyless), so it
 * is dropped there and only envelope-confirmed "supported" verdicts surface.
 */
const KNOWN_BASE_URLS: Record<string, { base: string; likelyTrust: "full" | "supported-only" }> = {
  anthropic: { base: "https://api.anthropic.com", likelyTrust: "full" },
  openai: { base: "https://api.openai.com/v1", likelyTrust: "full" },
  google: { base: "https://generativelanguage.googleapis.com/v1beta", likelyTrust: "full" },
  xai: { base: "https://api.x.ai/v1", likelyTrust: "full" },
  groq: { base: "https://api.groq.com/openai/v1", likelyTrust: "full" },
  mistral: { base: "https://api.mistral.ai/v1", likelyTrust: "supported-only" },
  cohere: { base: "https://api.cohere.com/v2", likelyTrust: "supported-only" },
  perplexity: { base: "https://api.perplexity.ai", likelyTrust: "supported-only" },
  cerebras: { base: "https://api.cerebras.ai/v1", likelyTrust: "supported-only" },
  togetherai: { base: "https://api.together.xyz/v1", likelyTrust: "supported-only" },
  deepinfra: { base: "https://api.deepinfra.com/v1/openai", likelyTrust: "supported-only" },
};

const OPENAI_DIALECTS: DialectId[] = ["openai-chat", "openai-responses"];

/** Provider ids probed first when the per-refresh cap bites (flagships first). */
const NATIVE_FIRST = Object.keys(KNOWN_BASE_URLS);

/**
 * models.dev `api` URLs for multi-tenant gateways get the same distrust:
 * every openai-compatible gateway 401s every probed path, so a bare "likely"
 * there would claim anthropic-messages on all ~193 of them.
 */
const GATEWAY_TRUSTS_LIKELY = false;

interface CacheEntry {
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

function sourceFingerprint(data: ModelsDevData): string {
  return Object.entries(data)
    .map(([id, p]) => `${id}:${p.api ?? KNOWN_BASE_URLS[id]?.base ?? ""}`)
    .sort()
    .join("|");
}

function isAbsoluteHttpUrl(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

/**
 * Resolve a provider's probeable base URL: models.dev `api`, else the known fallback.
 * The boolean flags whether "likely"-grade verdicts are trusted for this URL
 * (see KNOWN_BASE_URLS / GATEWAY_LIKELY_TRUST).
 */
export function baseUrlOf(id: string, p: Provider): string | null {
  return probeTargetOf(id, p)?.base ?? null;
}

function probeTargetOf(
  id: string,
  p: Provider,
): { base: string; trustLikely: boolean } | null {
  const raw = p.api;
  if (typeof raw === "string" && isAbsoluteHttpUrl(raw)) {
    return { base: raw, trustLikely: GATEWAY_TRUSTS_LIKELY };
  }
  const known = KNOWN_BASE_URLS[id];
  if (known !== undefined) {
    return { base: known.base, trustLikely: known.likelyTrust === "full" };
  }
  return null; // no api, no fallback, or ${ENV} placeholder URL
}

/** Providers worth probing: have (or fall back to) a real absolute http(s) base URL. */
function probeableProviders(
  data: ModelsDevData,
): Array<[string, Provider, string, boolean]> {
  const entries: Array<[string, Provider, string, boolean]> = [];
  for (const [id, p] of Object.entries(data)) {
    const target = probeTargetOf(id, p);
    if (target !== null) entries.push([id, p, target.base, target.trustLikely]);
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
  // the same host — results are shared by URL afterwards. trustLikely is
  // per-base: true only if every provider sharing the URL trusts "likely".
  const byBase = new Map<string, { ids: string[]; trustLikely: boolean }>();
  for (const [id, , rawBase, trustLikely] of targets) {
    const base = rawBase.replace(/\/+$/, "");
    const slot = byBase.get(base);
    if (slot) {
      slot.ids.push(id);
      slot.trustLikely = slot.trustLikely && trustLikely;
    } else {
      byBase.set(base, { ids: [id], trustLikely });
    }
  }

  const perUrl = new Map<string, DialectInfo>();
  const bases = [...byBase.keys()];
  let cursor = 0;
  const worker = async () => {
    while (cursor < bases.length) {
      const base = bases[cursor++]!;
      const { trustLikely } = byBase.get(base)!;
      try {
        const result = await detect(base, {
          timeoutMs: PER_PROBE_TIMEOUT_MS,
          concurrency: 6,
          // Distrusted hosts (gateways, landing pages) are probed for the
          // openai dialects only — the other dialects' strong error envelopes
          // are gateway-emulable (Together answers anthropic's exact
          // authentication_error envelope), which would produce false positives.
          dialects: trustLikely ? undefined : OPENAI_DIALECTS,
        });
        const endpoints: Record<string, string> = {};
        for (const p of result.probes) {
          if (p.dialect === "models-list") continue;
          // "likely" is a bare auth-wall guess — trusted only on dedicated
          // first-party hosts, never on multi-tenant gateways (see KNOWN_BASE_URLS).
          if (p.status !== "supported" && !(trustLikely && p.status === "likely")) {
            continue;
          }
          endpoints[p.dialect] = p.probedUrl;
        }
        const sorted = Object.fromEntries(
          Object.entries(endpoints).sort(([a], [b]) => a.localeCompare(b)),
        );
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
  for (const [base, { ids }] of byBase) {
    const info = perUrl.get(base);
    // Skip bases whose probes found nothing (every candidate auth-walled or
    // unreachable) — an empty endpoints object is noise in the response.
    if (!info || Object.keys(info.endpoints).length === 0) {
      silentCount++;
      continue;
    }
    for (const id of ids) map[id] = info;
  }

  state.cache = {
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
  return state.cache?.map[providerId] ?? null;
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
  const source = sourceFingerprint(data);
  const stale =
    state.cache === null || now - state.cache.fetchedAt >= TTL_MS;
  const sourceChanged = state.cache !== null && state.cache.source !== source;
  const lastAttemptFailed =
    state.failedAt !== null && now - state.failedAt >= 5 * 60 * 1000; // 5-min backoff after a failed refresh
  // Don't loop a refresh on every models.dev refetch when nothing changed.
  const alreadyBuiltFromThisData =
    state.cache !== null &&
    !stale &&
    !sourceChanged &&
    state.cache.source === source;
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
  return {
    ttlMs: TTL_MS,
    refreshing: state.refreshing,
    builtFromFetchedAt: state.builtFromFetchedAt,
    hasData: state.cache !== null,
    fetchedAt: state.cache?.fetchedAt ?? null,
    ageMs: state.cache ? now - state.cache.fetchedAt : null,
    isStale: state.cache === null ? true : now - state.cache.fetchedAt >= TTL_MS,
    providersWithDialects: state.cache ? Object.keys(state.cache.map).length : 0,
    probedBaseUrls: state.cache?.probedCount ?? 0,
    silentBaseUrls: state.cache?.silentCount ?? 0,
    lastRefreshDurationMs: state.cache?.durationMs ?? null,
    lastFailedAt: state.failedAt,
    maxProvidersPerRefresh: MAX_PROVIDERS_PER_REFRESH,
    note: "keyless live probing via vendored llm-baseurl-detector; gateways are probed for openai-* dialects only (other envelopes are gateway-emulable), first-party hosts keep all five",
  };
}
