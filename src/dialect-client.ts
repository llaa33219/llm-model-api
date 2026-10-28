// All API isolates use the same named Durable Object / container instance.

import type { DialectSnapshot, DialectTarget, Env } from "./types";

export async function getDialectSnapshot(env: Env): Promise<DialectSnapshot> {
  return await env.DIALECT_DETECTOR.getByName("global").getSnapshot();
}

export async function syncDialectDetector(
  env: Env,
  source: string,
  targets: DialectTarget[],
): Promise<void> {
  await env.DIALECT_DETECTOR.getByName("global").sync(source, targets);
}
