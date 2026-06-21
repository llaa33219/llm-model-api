import { getData, cacheStatus } from "./fetch";
import {
  handleRoot,
  handleProvider,
  handleModelList,
  handleModel,
  handleOptions,
} from "./handlers";

export default {
  async fetch(request: Request): Promise<Response> {
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
        return handleProvider(data);
      }

      if (path === "/model-list") {
        const providerName = url.searchParams.get("provider-name");
        const data = await getData();
        return handleModelList(data, providerName);
      }

      if (path === "/model") {
        const modelName = url.searchParams.get("model-name");
        const providerName = url.searchParams.get("provider-name");
        const data = await getData();
        return handleModel(data, modelName, providerName);
      }

      if (path === "/cache-status") {
        return Response.json(cacheStatus(), {
          headers: { "Access-Control-Allow-Origin": "*" },
        });
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