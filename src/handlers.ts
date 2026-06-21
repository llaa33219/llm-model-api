import type { ModelsDevData, Model, ReasoningOption } from "./types";
import { similarity } from "./match";

const MATCH_THRESHOLD = 0.7;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      ...(init.headers ?? {}),
    },
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, { status });
}

export function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

export function handleRoot(): Response {
  return jsonResponse({
    name: "lma.blp.sh",
    description: "Re-shaped models.dev API",
    source: "https://models.dev/api.json",
    endpoints: {
      "GET /provider": "List all providers (name, sdk, api).",
      "GET /model-list?provider-name=<name>":
        "List models for one provider. Fuzzy match (case/whitespace-insensitive, >=70% similarity).",
      "GET /model?model-name=<name>":
        "Find a model across providers. Supports `provider/model` syntax.",
      "GET /cache-status": "Internal cache diagnostics.",
    },
  });
}

export function handleProvider(data: ModelsDevData): Response {
  const providers = Object.values(data).map((p) => ({
    name: p.name,
    sdk: stripAiSdkPrefix(p.npm),
    api: p.api ?? null,
  }));
  providers.sort((a, b) => a.name.localeCompare(b.name));
  return jsonResponse({ count: providers.length, providers });
}

function stripAiSdkPrefix(npm: string): string {
  const prefix = "@ai-sdk/";
  return npm.startsWith(prefix) ? npm.slice(prefix.length) : npm;
}

/**
 * GET /model-list?provider-name=<name>
 * Fuzzy-matches a single provider and returns its model list.
 */
export function handleModelList(
  data: ModelsDevData,
  providerNameRaw: string | null,
): Response {
  if (providerNameRaw === null || providerNameRaw.trim() === "") {
    return errorResponse("Missing required query parameter: provider-name", 400);
  }

  const providers = Object.values(data);
  const scored = providers.map((p) => ({ provider: p, score: similarity(providerNameRaw, p.name) }));
  scored.sort((a, b) => b.score - a.score);

  if (scored.length === 0 || (scored[0]?.score ?? 0) < MATCH_THRESHOLD) {
    return errorResponse(
      `No provider matched "${providerNameRaw}" at >=${MATCH_THRESHOLD * 100}% similarity.`,
      404,
    );
  }

  const top = scored[0]!;
  const matches = scored
    .filter((s) => s.score >= MATCH_THRESHOLD)
    .slice(0, 5)
    .map((s) => ({ name: s.provider.name, score: round2(s.score) }));

  const models = Object.values(top.provider.models)
    .map((m) => ({ id: m.id, name: m.name }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return jsonResponse({
    provider: top.provider.name,
    score: round2(top.score),
    alsoMatched: matches.length > 1 ? matches : undefined,
    modelCount: models.length,
    models,
  });
}

/**
 * GET /model?model-name=<name>
 * Searches every provider's models. Supports `provider/model` input form.
 * The same model can appear under multiple providers (the user explicitly noted this),
 * so the response is an array sorted by best match first.
 */
export function handleModel(
  data: ModelsDevData,
  modelNameRaw: string | null,
): Response {
  if (modelNameRaw === null || modelNameRaw.trim() === "") {
    return errorResponse("Missing required query parameter: model-name", 400);
  }

  const parts = parseModelInput(modelNameRaw);
  const results: ModelMatch[] = [];

  for (const [providerId, provider] of Object.entries(data)) {
    for (const [modelId, model] of Object.entries(provider.models)) {
      const modelScore = similarity(parts.modelPart, model.id);
      const modelNameScore = similarity(parts.modelPart, model.name);
      const bestModelScore = Math.max(modelScore, modelNameScore);

      let score: number;
      if (parts.providerPart !== null) {
        const providerIdScore = similarity(parts.providerPart, providerId);
        const providerNameScore = similarity(parts.providerPart, provider.name);
        const bestProviderScore = Math.max(providerIdScore, providerNameScore);
        if (bestProviderScore < MATCH_THRESHOLD) continue;
        score = Math.min(bestModelScore, bestProviderScore);
      } else {
        score = bestModelScore;
      }

      if (score >= MATCH_THRESHOLD) {
        results.push({
          provider: provider.name,
          provider_id: providerId,
          model_id: modelId,
          model_name: model.name,
          context_window: model.limit.context,
          max_input_tokens: model.limit.input ?? null,
          max_output_tokens: model.limit.output,
          input_price: model.cost?.input ?? null,
          output_price: model.cost?.output ?? null,
          cache_read_price: model.cost?.cache_read ?? null,
          cache_write_price: model.cost?.cache_write ?? null,
          reasoning_options: model.reasoning_options ?? null,
          reasoning: model.reasoning,
          score: round2(score),
        });
      }
    }
  }

  if (results.length === 0) {
    return errorResponse(
      `No model matched "${modelNameRaw}" at >=${MATCH_THRESHOLD * 100}% similarity.`,
      404,
    );
  }

  results.sort((a, b) => b.score - a.score);
  const limited = results.slice(0, 50);
  return jsonResponse({
    query: modelNameRaw,
    count: limited.length,
    totalMatches: results.length,
    models: limited,
  });
}

interface ModelMatch {
  provider: string;
  provider_id: string;
  model_id: string;
  model_name: string;
  context_window: number;
  max_input_tokens: number | null;
  max_output_tokens: number;
  input_price: number | null;
  output_price: number | null;
  cache_read_price: number | null;
  cache_write_price: number | null;
  reasoning_options: ReasoningOption[] | null;
  reasoning: boolean;
  score: number;
}

function parseModelInput(input: string): { providerPart: string | null; modelPart: string } {
  const trimmed = input.trim();
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx === -1) {
    return { providerPart: null, modelPart: trimmed };
  }
  return {
    providerPart: trimmed.slice(0, slashIdx).trim(),
    modelPart: trimmed.slice(slashIdx + 1).trim(),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

