import type { ModelsDevData, Model, Provider, ReasoningOption } from "./types";
import { normalize, similarity } from "./match";

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

  const matches = findProviderMatches(data, providerNameRaw.trim(), 5);
  if (matches.length === 0) {
    return errorResponse(
      `No provider matched "${providerNameRaw}" at >=${MATCH_THRESHOLD * 100}% similarity.`,
      404,
    );
  }

  const top = matches[0]!;
  const alsoMatched = matches.length > 1
    ? matches.slice(1).map((m) => ({ name: m.provider.name, score: round2(m.score) }))
    : undefined;

  const models = Object.values(top.provider.models)
    .map((m) => ({ id: m.id, name: m.name }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return jsonResponse({
    provider: top.provider.name,
    score: round2(top.score),
    alsoMatched,
    modelCount: models.length,
    models,
  });
}

function findProviderMatches(
  data: ModelsDevData,
  query: string,
  limit: number,
): Array<{ provider: Provider; score: number }> {
  const scored = Object.values(data)
    .map((p) => ({ provider: p, score: similarity(query, p.name) }))
    .filter((s) => s.score >= MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * GET /model?model-name=<name>[&provider-name=<name>]
 * Strict exact-match search across every provider's models. Matching is
 * case-, whitespace-, and separator-insensitive after normalization. The
 * same model can appear under multiple providers (the user explicitly noted
 * this), so the response is an array.
 *
 * If `provider-name` is supplied, the search is scoped to one provider
 * (fuzzy-matched using the same rules as `/model-list`). This collapses
 * the 20+ duplicate hits from gateways into a single result.
 *
 * Why strict matching (not fuzzy): fuzzy similarity catches `gpt-5.1` when
 * the user searches `gpt-5` because both share the prefix `gpt5`. We treat
 * the model identifier as load-bearing — `gpt-5`, `gpt-5.1`, `gpt-5.5` are
 * distinct models and must never collapse.
 *
 * Four match paths, in priority order:
 *   1. `exact`      — full input equals normalized model.id or model.name
 *   2. `split`      — input contains `/`; both halves equal a known provider
 *                     and a model identifier
 *   3. `prefix`     — input begins with a known provider's normalized name/id;
 *                     the remainder equals a model identifier
 *   4. `permutation`— input has the same tokens (in any order) as model.id
 *                     or model.name, where tokens are letter-runs and digit-runs
 *                     extracted from the normalized string
 *
 * Examples that match `gpt-5`: "gpt-5", "gpt 5", "GPT-5", "gpt5",
 *   "openai/gpt-5", "openai-gpt-5".
 * Examples that match `claude-opus-4-5`: "claude-opus-4-5", "claude opus 4 5",
 *   "claude-4-5-opus", "claude 4.5 opus", "openai/claude-opus-4-5".
 * Examples that do NOT match `gpt-5`: "gpt-5.1", "gpt-5.5", "gpt-5-mini",
 *   "gpt-4o".
 */
export function handleModel(
  data: ModelsDevData,
  modelNameRaw: string | null,
  providerNameRaw: string | null,
): Response {
  if (modelNameRaw === null || modelNameRaw.trim() === "") {
    return errorResponse("Missing required query parameter: model-name", 400);
  }

  let scopedProvider: Provider | null = null;
  let providerMatch: { name: string; score: number } | null = null;
  if (providerNameRaw !== null && providerNameRaw.trim() !== "") {
    const matches = findProviderMatches(data, providerNameRaw.trim(), 1);
    if (matches.length === 0) {
      return errorResponse(
        `No provider matched "${providerNameRaw}" at >=${MATCH_THRESHOLD * 100}% similarity.`,
        404,
      );
    }
    scopedProvider = matches[0]!.provider;
    providerMatch = { name: matches[0]!.provider.name, score: round2(matches[0]!.score) };
  }

  const rawInput = modelNameRaw.trim();
  const normalizedInput = normalize(rawInput);
  const inputTokens = tokenize(rawInput);
  const providerIndex = buildProviderIndex(data);
  const results: ModelMatch[] = [];

  const providersToScan: ReadonlyArray<readonly [string, Provider]> =
    scopedProvider !== null ? [[scopedProvider.id, scopedProvider]] : Object.entries(data);

  for (const [providerId, provider] of providersToScan) {
    for (const [modelId, model] of Object.entries(provider.models)) {
      const matchType = matchModel(rawInput, normalizedInput, model, provider, providerIndex, inputTokens);
      if (matchType === null) continue;

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
        match_type: matchType,
      });
    }
  }

  if (results.length === 0) {
    if (scopedProvider !== null) {
      return errorResponse(
        `No model matched "${modelNameRaw}" in provider "${scopedProvider.name}".`,
        404,
      );
    }
    return errorResponse(
      `No model matched "${modelNameRaw}". Model matching is strict (case/whitespace/separator-insensitive exact match only). ` +
        `Try the provider/model form, e.g. ?model-name=openai/gpt-5. ` +
        `Variants like ${"\"gpt-5.1\""} are distinct models and will not match ${"\"gpt-5\""}.`,
      404,
    );
  }

  const typePriority: Record<MatchType, number> = { exact: 0, split: 1, prefix: 2, permutation: 3 };
  results.sort(
    (a, b) =>
      typePriority[a.match_type] - typePriority[b.match_type] ||
      a.provider.localeCompare(b.provider) ||
      a.model_id.localeCompare(b.model_id),
  );

  const limited = results.slice(0, 50);
  const responseBody: Record<string, unknown> = {
    query: modelNameRaw,
    count: limited.length,
    totalMatches: results.length,
    models: limited,
  };
  if (providerMatch !== null) {
    responseBody.provider = providerMatch.name;
    responseBody.provider_score = providerMatch.score;
  }
  return jsonResponse(responseBody);
}

type MatchType = "exact" | "split" | "prefix" | "permutation";

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
  match_type: MatchType;
}

function matchModel(
  rawInput: string,
  normalizedInput: string,
  model: Model,
  provider: Provider,
  providerIndex: Set<string>,
  inputTokens: string[],
): MatchType | null {
  const modelIdNorm = normalize(model.id);
  const modelNameNorm = normalize(model.name);

  if (normalizedInput === modelIdNorm || normalizedInput === modelNameNorm) {
    return "exact";
  }

  const slashIdx = rawInput.indexOf("/");
  if (slashIdx > 0 && slashIdx < rawInput.length - 1) {
    const providerPart = normalize(rawInput.slice(0, slashIdx));
    const modelPart = normalize(rawInput.slice(slashIdx + 1));
    const providerMatches =
      providerPart.length > 0 &&
      (providerPart === normalize(provider.id) || providerPart === normalize(provider.name));
    const modelMatches = modelPart === modelIdNorm || modelPart === modelNameNorm;
    if (providerMatches && modelMatches) {
      return "split";
    }
  }

  const stripped = stripKnownProviderPrefix(normalizedInput, providerIndex);
  if (stripped !== null && stripped.length > 0) {
    if (stripped === modelIdNorm || stripped === modelNameNorm) {
      return "prefix";
    }
  }

  const modelIdTokens = tokenize(model.id);
  const modelNameTokens = tokenize(model.name);
  if (tokensMultisetEqual(inputTokens, modelIdTokens) || tokensMultisetEqual(inputTokens, modelNameTokens)) {
    return "permutation";
  }

  return null;
}

function tokenize(s: string): string[] {
  const norm = normalize(s);
  return norm.match(/[a-z]+|\d+/g) ?? [];
}

function tokensMultisetEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((t, i) => t === sortedB[i]);
}

function stripKnownProviderPrefix(input: string, providerIndex: Set<string>): string | null {
  let bestLen = 0;
  for (const key of providerIndex) {
    if (input.startsWith(key) && key.length > bestLen) {
      bestLen = key.length;
    }
  }
  return bestLen > 0 ? input.slice(bestLen) : null;
}

function buildProviderIndex(data: ModelsDevData): Set<string> {
  const set = new Set<string>();
  for (const provider of Object.values(data)) {
    const idNorm = normalize(provider.id);
    const nameNorm = normalize(provider.name);
    if (idNorm.length > 0) set.add(idNorm);
    if (nameNorm.length > 0) set.add(nameNorm);
  }
  return set;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

