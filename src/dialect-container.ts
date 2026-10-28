// Direct Durable Object Container API, required by this account's
// durable_object scheduling policy. The image and size are selected here.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { DialectStore } from "./dialect-store";
import type {
  DialectRecord,
  DialectSnapshot,
  DialectTarget,
  Env,
} from "./types";

export interface ProbeResult {
  base: string;
  ok: boolean;
  endpoints?: DialectRecord["endpoints"];
  durationMs: number;
  error?: string;
}

/** Receives the Node process's internal virtual-host requests. */
export class DialectResultsWorker extends WorkerEntrypoint<Env, { id: string }> {
  override async fetch(request: Request): Promise<Response> {
    const id = this.env.DIALECT_DETECTOR.idFromString(this.ctx.props.id);
    return await this.env.DIALECT_DETECTOR.get(id).fetch(request);
  }
}

const PORT = 8080;
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
const READY_ATTEMPTS = 100;
const READY_INTERVAL_MS = 200;

export class DialectDetectorDurableContainer extends DurableObject<Env> {
  private starting: Promise<void> | undefined;
  private configuring: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (ctx.container?.running) {
      this.configuring = ctx.blockConcurrencyWhile(() => this.configureContainer());
    }
  }

  private async configureContainer(): Promise<void> {
    const container = this.ctx.container;
    if (!container) throw new Error("No container configured for DialectDetectorDurableContainer");
    const resultsWorker = this.ctx.exports.DialectResultsWorker({
      props: { id: this.ctx.id.toString() },
    }) as Fetcher;
    // Intercepts last until this container stops; re-registering the same
    // host replaces its handler, so running containers stay up to date.
    await container.interceptOutboundHttp("dialect-detector.internal", resultsWorker);
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  }

  private async startAndWaitForPort(): Promise<void> {
    const container = this.ctx.container;
    if (!container) throw new Error("No container configured for DialectDetectorDurableContainer");
    if (!container.running) {
      container.start({
        image: container.images.base,
        instance: "standard-1",
        enableInternet: true,
      });
    }
    // Runtime settings are applied only after start(). Calling
    // setInactivityTimeout on an unstarted container aborts the whole sync.
    await this.configureContainer();
    const port = container.getTcpPort(PORT);
    let lastError: unknown;
    for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
      try {
        const response = await port.fetch("http://container/health", {
          signal: AbortSignal.timeout(1000),
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error(`Health check returned ${response.status}`);
        return;
      } catch (error) {
        lastError = error;
        await scheduler.wait(READY_INTERVAL_MS);
      }
    }
    throw new Error("Container did not become ready on port 8080", { cause: lastError });
  }

  /** Calls from container control and result writes share one startup path. */
  private async containerFetch(path: string, init?: RequestInit): Promise<Response> {
    if (this.configuring) await this.configuring;
    this.starting ??= this.startAndWaitForPort().finally(() => {
      this.starting = undefined;
    });
    await this.starting;
    return await this.ctx.container!.getTcpPort(PORT).fetch(
      `http://container${path}`,
      init,
    );
  }

  async fetch(request: Request): Promise<Response> {
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
        await this.sync(body.source, body.targets);
        return Response.json(await store.snapshot());
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
      }
    }
    if (request.method === "POST" && url.pathname === "/stop") {
      return await this.containerFetch("/stop", { method: "POST" });
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
    const response = await this.containerFetch("/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, targets }),
    });
    if (!response.ok) throw new Error(`Container control failed: ${await response.text()}`);
  }

  async saveResults(body: {
    results: ProbeResult[];
    startedAt: number;
    lastError: string | null;
    begin?: string;
  }): Promise<Response> {
    // Each result counts as activity, so the container stays alive while its
    // internal long-running pass is making progress.
    if (this.ctx.container) {
      await this.ctx.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    }
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
