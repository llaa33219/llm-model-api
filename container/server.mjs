// Long-running dialect probe service for Cloudflare Containers.
// This process deliberately uses the published npm package, not the Worker's
// vendored port. The Durable Object owns persistence and schedules small jobs.

import http from "node:http";
import assert from "node:assert/strict";
import { detect } from "llm-baseurl-detector";

export const MAX_BASES_PER_REQUEST = 4;
export const BATCH_TIMEOUT_MS = 180 * 1000;
const PORT = Number(process.env.PORT ?? 8080);
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

export async function probeBatch(body) {
  const { bases, timeoutMs } = validateProbeRequest(body);
  let timer;
  try {
    const work = Promise.all(bases.map(async (base) => {
      const startedAt = Date.now();
      try {
        const result = await detect(base, { timeoutMs, concurrency: 6 });
        return {
          base: result.baseUrl,
          ok: true,
          endpoints: partitionEndpoints(result.probes),
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
    }));
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("probe batch timed out")), BATCH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Exported for Node tests; production runs the same handler through node:http.
export async function handleRequest(request) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, service: "lma-dialect-probe" });
  }
  if (request.method === "POST" && url.pathname === "/probe") {
    let body;
    try {
      body = await request.json();
      const result = await probeBatch(body);
      return json({ results: result });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }
  return json({ error: "Not Found" }, 404);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 32 * 1024) {
          req.destroy();
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
      const response = await handleRequest(request);
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
