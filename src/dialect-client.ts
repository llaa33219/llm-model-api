// The documented getContainer helper routes all isolates to one singleton.

import { getContainer } from "@cloudflare/containers";
import type { DialectSnapshot, DialectTarget, Env } from "./types";

export async function getDialectSnapshot(env: Env): Promise<DialectSnapshot> {
  return await getContainer(env.DIALECT_DETECTOR).getSnapshot();
}

export async function syncDialectDetector(
  env: Env,
  source: string,
  targets: DialectTarget[],
): Promise<void> {
  await getContainer(env.DIALECT_DETECTOR).sync(source, targets);
}
