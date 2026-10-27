// Worker-side client for the singleton Durable Object. Kept separate from the
// DO/Container implementation so ordinary API handlers and tests do not load
// the cloudflare:workers module.

import type { DialectSnapshot, DialectTarget, Env } from "./types";

export async function getDialectSnapshot(env: Env): Promise<DialectSnapshot> {
  const detector = env.DIALECT_DETECTOR.getByName("global");
  const response = await detector.fetch("https://dialect-detector.internal/state");
  if (!response.ok) throw new Error(`Dialect detector state returned HTTP ${response.status}`);
  return await response.json<DialectSnapshot>();
}

export async function syncDialectDetector(
  env: Env,
  source: string,
  targets: DialectTarget[],
): Promise<DialectSnapshot> {
  const detector = env.DIALECT_DETECTOR.getByName("global");
  const response = await detector.fetch("https://dialect-detector.internal/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source, targets }),
  });
  if (!response.ok) {
    throw new Error(`Dialect detector sync returned HTTP ${response.status}: ${await response.text()}`);
  }
  return await response.json<DialectSnapshot>();
}
