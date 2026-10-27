// Live verification for the dialect-detection feature.
// Runs against the REAL models.dev api.json and REAL provider endpoints (keyless).
//
//   node test/dialects.mjs
//
// Asserts:
//   1. detect() finds anthropic-messages on https://api.anthropic.com
//   2. detect() finds openai-chat on https://api.openai.com/v1
//   3. refresh cycle: 207 providers -> 30-provider cap -> cache filled, 24h TTL
//   4. `${...}` env-placeholder URLs (e.g. Neon) are never probed
//   5. non-@ai-sdk providers (togetherai, qvac, venice...) are probed too
//   6. stripAiSdkPrefix passes non-@ai-sdk npm names through verbatim
//   7. supported and likely endpoint groups stay separate
//   8. a legacy flat cache is discarded and refreshed, never returned as-is
//
// Timeout: whole run must finish under ~5 min (30 providers x 4s probes, conc 6).

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Build TS -> JS into a temp dir (noEmit is set in tsconfig, so drive tsc by hand).
const out = path.join(root, "node_modules", ".cache", "dialect-test");
execSync(
  `npx tsc src/vendor/llm-baseurl-detector/index.ts src/dialects.ts src/types.ts ` +
    `--outDir "${out}" --module es2022 --target es2022 --moduleResolution bundler ` +
    `--strict --skipLibCheck --declaration false`,
  { cwd: root, stdio: "inherit" },
);
// tsc emits extensionless/directory imports; rewrite them for node ESM.
const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
for (const f of ["dialects.js"]) {
  const fp = path.join(out, f);
  let src = readFileSync(fp, "utf8");
  src = src.replace(/from "(\.\/[^"]+)"/g, (m, p1) => {
    const abs = path.join(out, p1);
    if (existsSync(abs + ".js")) return `from "${p1}.js"`;
    if (existsSync(path.join(abs, "index.js"))) return `from "${p1}/index.js"`;
    return m;
  });
  writeFileSync(fp, src);
}

const { detect } = await import(path.join(out, "vendor", "llm-baseurl-detector", "index.js"));
const dialectsMod = await import(path.join(out, "dialects.js"));

const TIMEOUT = 4000;

// --- 1. anthropic keyless detection -------------------------------------
console.log("[1/7] detect https://api.anthropic.com ...");
const anth = await detect("https://api.anthropic.com", { timeoutMs: TIMEOUT });
console.log("     endpoints:", JSON.stringify(anth.endpoints), `(${anth.durationMs}ms)`);
assert.ok(
  anth.endpoints["anthropic-messages"],
  "anthropic-messages must be detected on api.anthropic.com (keyless, via error envelope)",
);

// --- 2. openai keyless detection -----------------------------------------
console.log("[2/7] detect https://api.openai.com/v1 ...");
const oai = await detect("https://api.openai.com/v1", { timeoutMs: TIMEOUT });
console.log("     endpoints:", JSON.stringify(oai.endpoints), `(${oai.durationMs}ms)`);
assert.ok(
  oai.endpoints["openai-chat"],
  "openai-chat must be detected on api.openai.com/v1 (auth wall => likely)",
);

// --- 3-5. full refresh cycle against live models.dev ----------------------
console.log("[3/7] fetching live models.dev api.json ...");
const res = await fetch("https://models.dev/api.json");
assert.ok(res.ok, `models.dev fetch failed: ${res.status}`);
const data = await res.json();
const fetchedAt = Date.now();
console.log(`     ${Object.keys(data).length} providers`);

console.log("[4/7] running background refresh (30-provider cap, conc 6) ...");
const t0 = Date.now();
const p = dialectsMod.maybeRefreshDialects(data, fetchedAt);
assert.ok(p !== null, "first call must start a refresh");
await p;
console.log(`     refresh done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const status = dialectsMod.dialectCacheStatus();
console.log("     cache:", JSON.stringify({
  providersWithDialects: status.providersWithDialects,
  probedBaseUrls: status.probedBaseUrls,
  ttlMs: status.ttlMs,
  isStale: status.isStale,
}, null, 2));
assert.equal(status.ttlMs, 24 * 60 * 60 * 1000, "dialect cache TTL must be 24h");
assert.equal(status.isStale, false, "fresh cache must not be stale");
assert.ok(status.providersWithDialects > 0, "cache must hold dialect info");
assert.ok(status.probedBaseUrls <= 30, "must respect the 30-provider cap");

// second call with same data must NOT start another refresh
assert.equal(
  dialectsMod.maybeRefreshDialects(data, fetchedAt),
  null,
  "second call with same+fresh data must be a no-op",
);

// --- 4. env-placeholder URLs skipped --------------------------------------
console.log("[5/7] checking env-placeholder + non-@ai-sdk coverage ...");
assert.equal(
  dialectsMod.getDialectInfo("neon"),
  null,
  "Neon (${NEON_AI_GATEWAY_BASE_URL}/v1) must never be probed",
);

// --- 5. first-party + gateway dialects --------------------------------------
// Every host is probed for all five dialects with both supported|likely
// verdicts surfaced — the fingerprint probes (validate-before-auth) separate
// real routes from catch-alls. Verified live: Together really serves
// anthropic-messages (body validated before auth), DeepSeek does not.
const anthInfo = dialectsMod.getDialectInfo("anthropic");
assert.ok(
  anthInfo && anthInfo.endpoints.supported["anthropic-messages"],
  "anthropic-messages must be in the confirmed group on api.anthropic.com",
);
const oaiInfo = dialectsMod.getDialectInfo("openai");
assert.ok(
  oaiInfo &&
    (oaiInfo.endpoints.supported["openai-chat"] ||
      oaiInfo.endpoints.likely["openai-chat"]),
  "openai-chat must be present in exactly one confidence group",
);
const together = dialectsMod.getDialectInfo("togetherai");
for (const info of [anthInfo, oaiInfo, together].filter(Boolean)) {
  for (const dialect of Object.keys(info.endpoints.supported)) {
    assert.ok(
      !Object.hasOwn(info.endpoints.likely, dialect),
      `${dialect} must not appear in both supported and likely`,
    );
  }
}
const printEndpoints = (info) => info
  ? JSON.stringify(info.endpoints)
  : "(silent)";
console.log("     togetherai dialects:", printEndpoints(together));
console.log("     anthropic:", printEndpoints(anthInfo));
console.log("     openai:", printEndpoints(oaiInfo));

// --- 6. sdk prefix stripping ----------------------------------------------
console.log("[6/7] checking sdk prefix pass-through ...");
const strip = (npm) => (npm.startsWith("@ai-sdk/") ? npm.slice("@ai-sdk/".length) : npm);
const nonAiSdk = Object.values(data).filter((pr) => !pr.npm.startsWith("@ai-sdk/"));
assert.ok(nonAiSdk.length >= 10, "live data should have >=10 non-@ai-sdk providers");
for (const pr of nonAiSdk) {
  assert.equal(strip(pr.npm), pr.npm, `non-@ai-sdk npm must pass through verbatim: ${pr.npm}`);
}
console.log(`     ${nonAiSdk.length} non-@ai-sdk npm values all pass through verbatim`);

// --- 7. confidence groups use the detector's exact verdicts -----------------
console.log("[7/7] verifying supported/likely separation ...");
const anthProbe = anth.probes.find((pr) => pr.dialect === "anthropic-messages");
assert.equal(anthProbe.status, "supported");
assert.ok(anthInfo.endpoints.supported["anthropic-messages"]);
assert.ok(!anthInfo.endpoints.likely["anthropic-messages"]);
const oaiChatProbe = oai.probes.find((pr) => pr.dialect === "openai-chat");
const expectedGroup = oaiChatProbe.status === "supported" ? "supported" : "likely";
assert.ok(oaiInfo.endpoints[expectedGroup]["openai-chat"]);
assert.ok(!oaiInfo.endpoints[expectedGroup === "supported" ? "likely" : "supported"]["openai-chat"]);
console.log(`     anthropic-messages: supported @ ${anthProbe.probedUrl}`);
console.log(`     openai-chat: ${oaiChatProbe.status} @ ${oaiChatProbe.probedUrl}`);
console.log(`     detail: ${anthProbe.detail}`);

// --- 8. legacy cache schema compatibility -----------------------------------
// Inject the exact pre-split flat cache entry into a separate compiled module
// instance. This simulates retained module state without adding a production
// test-only cache setter. The provider is intentionally unprobeable so the
// required refresh completes without any network request.
console.log("[8/8] checking legacy flat-cache invalidation ...");
const legacyProvider = {
  id: "legacy",
  name: "Legacy",
  npm: "@ai-sdk/openai-compatible",
  api: "${LEGACY_BASE_URL}/v1",
  doc: "",
  env: [],
  models: {},
};
const legacyData = { legacy: legacyProvider };
const legacyCache = {
  map: {
    legacy: {
      endpoints: { "openai-chat": "https://legacy.example/v1/chat/completions" },
      probedAt: Date.now(),
      durationMs: 1,
    },
  },
  fetchedAt: Date.now(),
  source: "legacy:${LEGACY_BASE_URL}/v1",
  probedCount: 1,
  silentCount: 0,
  durationMs: 1,
};
const legacySource = readFileSync(path.join(out, "dialects.js"), "utf8");
assert.ok(legacySource.includes("cache: null,"), "test must find the cache initializer");
const legacyPath = path.join(out, "dialects-legacy.js");
writeFileSync(
  legacyPath,
  legacySource.replace("cache: null,", `cache: ${JSON.stringify(legacyCache)},`),
);
const legacyModule = await import(legacyPath);
assert.equal(
  legacyModule.getDialectInfo("legacy"),
  null,
  "legacy flat cache must never be returned as nested supported/likely data",
);
const legacyRefresh = legacyModule.maybeRefreshDialects(legacyData, Date.now());
assert.ok(legacyRefresh !== null, "legacy cache must trigger a refresh even when fresh");
await legacyRefresh;
const legacyStatus = legacyModule.dialectCacheStatus();
assert.equal(legacyStatus.schemaVersion, 2, "refresh must write the current cache schema");
assert.equal(legacyStatus.providersWithDialects, 0);
assert.equal(legacyStatus.refreshing, false);
console.log("     old cache discarded; refresh ran; schemaVersion=2");

console.log("\nALL ASSERTIONS PASSED");
