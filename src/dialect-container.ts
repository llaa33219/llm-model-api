// Singleton Cloudflare Container + persistent Durable Object coordination.
// The Linux container runs the real llm-baseurl-detector package. This DO owns
// all durable state and schedules small probe batches with storage alarms.

import { DurableObject } from "cloudflare:workers";
import { DialectCoordinator } from "./dialect-coordinator";
import type { DialectRecord, DialectTarget, Env } from "./types";

const CONTAINER_PORT = 8080;
const CONTAINER_INACTIVITY_MS = 30 * 60 * 1000;
const CONTAINER_READY_ATTEMPTS = 100;
const CONTAINER_READY_DELAY_MS = 200;
const CONTAINER_PROBE_TIMEOUT_MS = 180 * 1000;
const CONTAINER_HEALTH_TIMEOUT_MS = 1000;

export class DialectDetectorContainer extends DurableObject<Env> {
  private readonly coordinator: DialectCoordinator;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.coordinator = new DialectCoordinator(ctx.storage, (base) => this.probe(base));
    if (ctx.container?.running) {
      void ctx.blockConcurrencyWhile(() =>
        ctx.container!.setInactivityTimeout(CONTAINER_INACTIVITY_MS),
      );
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/state") {
      return Response.json(await this.coordinator.snapshot());
    }
    if (request.method === "POST" && url.pathname === "/sync") {
      try {
        const body = await request.json<{ source?: string; targets?: DialectTarget[] }>();
        if (
          typeof body.source !== "string" ||
          !Array.isArray(body.targets) ||
          !body.targets.every((target) =>
            typeof target.base === "string" &&
            Array.isArray(target.providers) &&
            target.providers.every((id) => typeof id === "string")
          )
        ) {
          return Response.json({ error: "Expected {source, targets:[{base,providers}]}" }, { status: 400 });
        }
        return Response.json(await this.coordinator.sync(body.source, body.targets));
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
      }
    }
    return Response.json({ error: "Not Found" }, { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.coordinator.alarm();
  }

  private async probe(base: string): Promise<Pick<DialectRecord, "endpoints" | "durationMs">> {
    const container = this.ctx.container;
    if (!container) throw new Error("No container configured for DialectDetectorContainer");
    await container.setInactivityTimeout(CONTAINER_INACTIVITY_MS);
    if (!container.running) {
      // Default scheduling policy takes image/instance from wrangler.jsonc.
      container.start({ enableInternet: true });
    }
    const port = container.getTcpPort(CONTAINER_PORT);
    await this.waitForContainer(port);
    const response = await port.fetch("http://container/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bases: [base], timeoutMs: 4000 }),
      signal: AbortSignal.timeout(CONTAINER_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Container probe returned HTTP ${response.status}: ${await response.text()}`);
    }
    const body = await response.json<{
      results?: Array<{
        ok: boolean;
        endpoints?: DialectRecord["endpoints"];
        durationMs: number;
        error?: string;
      }>;
    }>();
    const result = body.results?.[0];
    if (!result || !result.ok || !result.endpoints) {
      throw new Error(result?.error ?? "Container probe returned no result");
    }
    return { endpoints: result.endpoints, durationMs: result.durationMs };
  }

  private async waitForContainer(port: Fetcher): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < CONTAINER_READY_ATTEMPTS; attempt++) {
      try {
        const response = await port.fetch("http://container/health", {
          signal: AbortSignal.timeout(CONTAINER_HEALTH_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`Health check returned HTTP ${response.status}`);
        return;
      } catch (error) {
        lastError = error;
        await scheduler.wait(CONTAINER_READY_DELAY_MS);
      }
    }
    throw new Error("Container did not become ready on port 8080", { cause: lastError });
  }
}
