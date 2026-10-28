import { getData, cacheStatus } from "./fetch";
import type { Env } from "./types";
export { ContainerProxy } from "@cloudflare/containers";
export { DialectDetectorContainer } from "./legacy-dialect-container";
export { DialectDetectorDurableContainer, DialectResultsWorker } from "./dialect-container";
import { dialectCacheStatus, dialectMapForModels, scheduleDialectSync } from "./dialects";
import {
  handleRoot,
  handleProvider,
  handleModelList,
  handleModel,
  handleOptions,
} from "./handlers";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
        const dialectMap = await dialectMapForModels(env);
        scheduleDialectSync(env, ctx, data);
        return handleProvider(data, dialectMap);
      }

      if (path === "/model-list") {
        const providerName = url.searchParams.get("provider-name");
        const data = await getData();
        scheduleDialectSync(env, ctx, data);
        return handleModelList(data, providerName);
      }

      if (path === "/model") {
        const modelName = url.searchParams.get("model-name");
        const providerName = url.searchParams.get("provider-name");
        const data = await getData();
        const dialectMap = await dialectMapForModels(env);
        scheduleDialectSync(env, ctx, data);
        return handleModel(data, modelName, providerName, dialectMap);
      }

      if (path === "/cache-status") {
        return Response.json(
          { modelsDev: cacheStatus(), dialects: await dialectCacheStatus(env) },
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
} satisfies ExportedHandler<Env>;