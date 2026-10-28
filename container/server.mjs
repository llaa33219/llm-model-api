// Long-running detector process. The documented Container class owns process
// lifecycle; this process owns only target scheduling and actual npm probing.
// Completed results go to Durable Object storage, never ephemeral local disk.

import http from "node:http";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { setTimeout } from "node:timers";
import { detect } from "llm-baseurl-detector";

export const MAX_BASES_PER_REQUEST = 4;
const PORT = Number(process.env.PORT ?? 8080);
const RESULTS_URL = process.env.DIALECT_RESULTS_URL ?? "http://dialect-detector.internal/results";
const BETWEEN_BASES_MS = Number(process.env.DIALECT_BETWEEN_BASES_MS ?? 1000);
const BETWEEN_PASSES_MS = Number(process.env.DIALECT_BETWEEN_PASSES_MS ?? 5000);
const DIALECTS = new Set([
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "gemini-generate",
  "typesafe-systemone",
]);

export function validateProbeRequest(body) {
  assert.ok(body !== null && typeof body === "object" && !Array.isArray(body), "JSON object required");
  assert.ok(Array.isArray(body.bases), "bases must be an array");
  assert.ok(body.bases.length >= 1 && body.bases.length <= MAX_BASES_PER_REQUEST,
    `bases must contain 1-${MAX_BASES_PER_REQUEST} URLs`);
  const bases = body.bases.map((raw) => {
    assert.equal(typeof raw, "string", "each base must be a string");
    const normalized = raw.trim().replace(/\/+$/, "");
    let url;
    try {
      url = new URL(normalized);
    } catch {
      assert.fail(`invalid base URL: ${raw}`);
    }
    assert.ok(url.protocol === "https:" || url.protocol === "http:", "base URL must be http(s)");
    assert.equal(url.username, "", "base URL credentials are not allowed");
    assert.equal(url.password, "", "base URL credentials are not allowed");
    return normalized;
  });
  assert.equal(new Set(bases).size, bases.length, "duplicate base URLs are not allowed");
  const timeoutMs = body.timeoutMs === undefined ? 4000 : body.timeoutMs;
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 15000,
    "timeoutMs must be between 100 and 15000");
  return { bases, timeoutMs };
}

export function partitionEndpoints(probes) {
  const endpoints = { supported: {}, likely: {} };
  for (const probe of probes) {
    if (!DIALECTS.has(probe.dialect)) continue;
    if (probe.status !== "supported" && probe.status !== "likely") continue;
    endpoints[probe.status][probe.dialect] = probe.probedUrl;
  }
  endpoints.supported = Object.fromEntries(Object.entries(endpoints.supported).sort());
  endpoints.likely = Object.fromEntries(Object.entries(endpoints.likely).sort());
  return endpoints;
}

/** Public response values are SDK base URLs from detector 0.2.0, not raw endpoints. */
export function partitionSdkBaseUrls(result) {
  const endpoints = { supported: {}, likely: {} };
  for (const probe of result.probes) {
    if (!DIALECTS.has(probe.dialect)) continue;
    if (probe.status !== "supported" && probe.status !== "likely") continue;
    endpoints[probe.status][probe.dialect] = result.sdkBaseUrls[probe.dialect];
  }
  endpoints.supported = Object.fromEntries(Object.entries(endpoints.supported).sort());
  endpoints.likely = Object.fromEntries(Object.entries(endpoints.likely).sort());
  return endpoints;
}

export async function probeBase(base, timeoutMs = 4000) {
  const startedAt = Date.now();
  try {
    const result = await detect(base, { timeoutMs, concurrency: 6 });
    return {
      base: result.baseUrl,
      ok: true,
      endpoints: partitionSdkBaseUrls(result),
      rawEndpoints: partitionEndpoints(result.probes),
      durationMs: result.durationMs,
    };
  } catch (error) {
    return {
      base,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

export async function probeBatch(body) {
  const { bases, timeoutMs } = validateProbeRequest(body);
  return await Promise.all(bases.map((base) => probeBase(base, timeoutMs)));
}

/** One bounded pass over due targets, preserving each result independently. */
export async function runProbePass(targets, previousRecords, {
  saveResults,
  probe = probeBase,
  pauseMs = BETWEEN_BASES_MS,
}) {
  const startedAt = Date.now();
  const oldByBase = new Map(previousRecords.map((record) => [record.base, record]));
  let attempted = 0;
  let lastError = null;
  for (const target of targets) {
    const previous = oldByBase.get(target.base);
    if (previous?.nextAttemptAt > Date.now()) continue;
    await saveResults([], startedAt, null, target.base);
    const result = await probe(target.base);
    attempted++;
    if (!result.ok) lastError = result.error ?? "probe failed";
    await saveResults([result], startedAt, lastError);
    if (pauseMs > 0) await sleep(pauseMs);
  }
  return { attempted, lastError };
}

export class DetectorLoop {
  #queue = Promise.resolve();
  #timer;
  #started = false;
  #generation = 0;

  constructor({ getSnapshot, saveResults, probe = probeBase, idleMs = BETWEEN_PASSES_MS, pauseMs = BETWEEN_BASES_MS }) {
    this.getSnapshot = getSnapshot;
    this.saveResults = saveResults;
    this.probe = probe;
    this.idleMs = idleMs;
    this.pauseMs = pauseMs;
  }

  start() {
    if (this.#started) return;
    this.#started = true;
    this.#generation++;
    const generation = this.#generation;
    this.#queue = this.#queue.then(async () => {
      await this.#sweep();
      this.#schedule(generation);
    }).catch((error) => console.error("Dialect loop error:", error));
  }

  configure() {
    // Keep the queue resolved after a transient snapshot/save failure so the
    // next pass can recover instead of poisoning every subsequent pass.
    this.#queue = this.#queue.then(() => this.#sweep()).catch((error) => {
      console.error("Dialect loop error:", error);
    });
    return this.#queue;
  }

  async #sweep() {
    const snapshot = await this.getSnapshot();
    const result = await runProbePass(snapshot.targets, snapshot.records, {
      saveResults: this.saveResults,
      probe: this.probe,
      pauseMs: this.pauseMs,
    });
    console.log(`Dialect pass: ${result.attempted} probes; lastError=${result.lastError ?? "none"}`);
  }

  #schedule(generation) {
    if (!this.#started || generation !== this.#generation) return;
    this.#timer = setTimeout(() => {
      if (!this.#started || generation !== this.#generation) return;
      this.#timer = undefined;
      this.#queue = this.#queue.then(async () => {
        await this.#sweep();
        this.#schedule(generation);
      }).catch((error) => console.error("Dialect loop error:", error));
    }, this.idleMs);
    this.#timer.unref();
  }

  async stop() {
    this.#started = false;
    this.#generation++;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#queue;
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Injectable state/save adapters let local tests exercise the loop without a
// Cloudflare binding; production defaults use the outboundByHost virtual host.
export function createControlHandler({ getSnapshot, saveResults, probe, startLoop = true } = {}) {
  const state = getSnapshot ?? (async () => {
    const response = await fetch("http://dialect-detector.internal/state");
    return await response.json();
  });
  const save = saveResults ?? (async (results, startedAt, lastError, begin) => {
    const response = await fetch(RESULTS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ results, startedAt, lastError, begin }),
    });
    if (!response.ok) throw new Error(`Saving results failed: HTTP ${response.status}`);
  });
  const loop = new DetectorLoop({ getSnapshot: state, saveResults: save, probe });
  if (startLoop) loop.start();
  return async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "lma-dialect-probe" });
    }
    if (request.method === "POST" && url.pathname === "/control") {
      // Return after scheduling, not after every provider has been probed.
      void loop.configure();
      return json({ ok: true }, 202);
    }
    if (request.method === "POST" && url.pathname === "/stop") {
      await loop.stop();
      return json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/probe") {
      try {
        return json({ results: await probeBatch(await request.json()) });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }
    return json({ error: "Not Found" }, 404);
  };
}

export function createServer(options = {}) {
  const handle = createControlHandler(options);
  return http.createServer(async (req, res) => {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 32 * 1024) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Request body too large" }));
          return;
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const request = new Request(`http://container${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      });
      const response = await handle(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const server = createServer();
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Dialect probe service listening on ${PORT}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
