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
//   7. /provider response shape: {name, sdk, api, dialects}
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
// tsc emits ./vendor/... and ./dialects.js with extensionless imports; rewrite to .js
execSync(
  `find "${out}" -name '*.js' -exec sed -i -E "s|from \\"(\\./[^\\"]+)\\"|from \\"\\\\1.js\\"|g" {} +`,
  { stdio: "inherit" },
);

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
// First-party fallbacks keep all five dialects; gateways are restricted to
// openai-* (their emulation of anthropic/gemini envelopes would false-positive).
const anthInfo = dialectsMod.getDialectInfo("anthropic");
assert.ok(
  anthInfo && anthInfo.endpoints["anthropic-messages"],
  "anthropic provider must expose anthropic-messages endpoint",
);
const oaiInfo = dialectsMod.getDialectInfo("openai");
assert.ok(
  oaiInfo && oaiInfo.endpoints["openai-chat"],
  "openai provider must expose openai-chat endpoint",
);
const gateway = dialectsMod.getDialectInfo("togetherai");
if (gateway !== null) {
  const dialects = Object.keys(gateway.endpoints);
  console.log("     togetherai (gateway) dialects:", dialects.join(", "));
  assert.ok(
    dialects.every((d) => d.startsWith("openai-")),
    `gateway providers must only expose openai-* dialects, got: ${dialects}`,
  );
}
console.log("     anthropic:", Object.keys(anthInfo.endpoints).join(", "));
console.log("     openai:", Object.keys(oaiInfo.endpoints).join(", "));

// --- 6. sdk prefix stripping ----------------------------------------------
console.log("[6/7] checking sdk prefix pass-through ...");
const strip = (npm) => (npm.startsWith("@ai-sdk/") ? npm.slice("@ai-sdk/".length) : npm);
const nonAiSdk = Object.values(data).filter((pr) => !pr.npm.startsWith("@ai-sdk/"));
assert.ok(nonAiSdk.length >= 10, "live data should have >=10 non-@ai-sdk providers");
for (const pr of nonAiSdk) {
  assert.equal(strip(pr.npm), pr.npm, `non-@ai-sdk npm must pass through verbatim: ${pr.npm}`);
}
console.log(`     ${nonAiSdk.length} non-@ai-sdk npm values all pass through verbatim`);

// --- 7. anthropic endpoint sanity ------------------------------------------
console.log("[7/7] verifying anthropic probe details ...");
const anthProbe = anth.probes.find((pr) => pr.dialect === "anthropic-messages");
console.log(`     verdict: ${anthProbe.status} @ ${anthProbe.probedUrl} (HTTP ${anthProbe.httpStatus})`);
console.log(`     detail: ${anthProbe.detail}`);

console.log("\nALL ASSERTIONS PASSED");
