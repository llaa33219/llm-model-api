// Retain the previous default-policy class so its live Wrangler export stays
// valid during replacement rollout. New traffic uses DIALECT_DETECTOR's
// durable_object class, not this legacy binding.

import { Container } from "@cloudflare/containers";
import { DialectStore } from "./dialect-store";
import type {
  DialectRecord,
  DialectSnapshot,
  DialectTarget,
  Env,
} from "./types";

export interface LegacyProbeResult {
  base: string;
  ok: boolean;
  endpoints?: DialectRecord["endpoints"];
  durationMs: number;
  error?: string;
}

export class DialectDetectorContainer extends Container<Env> {
  static {
    this.outboundByHost = {
      "dialect-detector.internal": async (
        request: Request,
        env: Env,
        ctx: { containerId: string },
      ): Promise<Response> => {
        const id = env.DIALECT_DETECTOR.idFromString(ctx.containerId);
        return await env.DIALECT_DETECTOR.get(id).fetch(request);
      },
    };
  }

  defaultPort = 8080;
  sleepAfter = "30m";
  enableInternet = true;

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const store = new DialectStore(this.ctx.storage);
    if (request.method === "GET" && url.pathname === "/state") {
      return Response.json(await store.snapshot());
    }
    if (request.method === "POST" && url.pathname === "/sync") {
      try {
        const body = await request.json<{ source: string; targets: DialectTarget[] }>();
        if (typeof body.source !== "string" || !Array.isArray(body.targets)) {
          return Response.json({ error: "Expected source and targets" }, { status: 400 });
        }
        await store.configure(body.source, body.targets);
        const control = await this.containerFetch("http://container/control", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!control.ok) {
          return Response.json({ error: `Container control failed: ${await control.text()}` }, { status: 502 });
        }
        return Response.json(await store.snapshot());
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
      }
    }
    if (request.method === "POST" && url.pathname === "/stop") {
      return await this.containerFetch("http://container/stop", { method: "POST" });
    }
    if (request.method === "POST" && url.pathname === "/results") {
      return await this.saveResults(await request.json());
    }
    return Response.json({ error: "Not Found" }, { status: 404 });
  }

  async getSnapshot(): Promise<DialectSnapshot> {
    return await new DialectStore(this.ctx.storage).snapshot();
  }

  async sync(source: string, targets: DialectTarget[]): Promise<void> {
    await new DialectStore(this.ctx.storage).configure(source, targets);
    const response = await this.containerFetch("http://container/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, targets }),
    });
    if (!response.ok) throw new Error(`Container control failed: ${await response.text()}`);
  }

  async saveResults(body: {
    results: LegacyProbeResult[];
    startedAt: number;
    lastError: string | null;
    begin?: string;
  }): Promise<Response> {
    this.renewActivityTimeout();
    const store = new DialectStore(this.ctx.storage);
    if (body.begin) await store.beginPass(body.begin);
    for (const result of body.results) {
      await store.save(
        result.base,
        result.endpoints ?? { supported: {}, likely: {} },
        result.durationMs,
        result.ok ? null : result.error ?? "probe failed",
      );
    }
    await store.completeBatch(body.startedAt, body.lastError);
    return Response.json({ ok: true });
  }
}
