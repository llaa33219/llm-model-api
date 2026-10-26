import { getData, cacheStatus } from "./fetch";
import { maybeRefreshDialects, dialectCacheStatus } from "./dialects";
import {
  handleRoot,
  handleProvider,
  handleModelList,
  handleModel,
  handleOptions,
} from "./handlers";

/**
 * Track a background dialect refresh. The worker runtime keeps the isolate alive
 * via ctx.waitUntil; outside the runtime (e.g. plain node tests) we just keep the
 * promise referenced so the microtask queue drains.
 */
function trackDialectRefresh(ctx: ExecutionContext, data: Awaited<ReturnType<typeof getData>>): void {
  const promise = maybeRefreshDialects(data, cacheStatus().fetchedAt);
  if (promise !== null) {
    ctx.waitUntil(promise);
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return handleOptions();
    }
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, OPTIONS" },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/" || path === "/index.html") {
        return handleRoot();
      }

      if (path === "/provider") {
        const data = await getData();
        trackDialectRefresh(ctx, data);
        return handleProvider(data);
      }

      if (path === "/model-list") {
        const providerName = url.searchParams.get("provider-name");
        const data = await getData();
        trackDialectRefresh(ctx, data);
        return handleModelList(data, providerName);
      }

      if (path === "/model") {
        const modelName = url.searchParams.get("model-name");
        const providerName = url.searchParams.get("provider-name");
        const data = await getData();
        trackDialectRefresh(ctx, data);
        return handleModel(data, modelName, providerName);
      }

      if (path === "/cache-status") {
        return Response.json(
          { modelsDev: cacheStatus(), dialects: dialectCacheStatus() },
          { headers: { "Access-Control-Allow-Origin": "*" } },
        );
      }

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, {
        status: 502,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }
  },
} satisfies ExportedHandler;