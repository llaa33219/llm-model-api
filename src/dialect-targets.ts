// Provider base URLs and the deduplicated set of URLs to probe.
// models.dev omits `api` for providers whose official SDK derives it internally.

import type { DialectTarget, ModelsDevData, Provider } from "./types";

const KNOWN_BASE_URLS: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  xai: "https://api.x.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  cohere: "https://api.cohere.com/v2",
  perplexity: "https://api.perplexity.ai",
  cerebras: "https://api.cerebras.ai/v1",
  togetherai: "https://api.together.xyz/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai",
};

export function baseUrlOf(id: string, p: Provider): string | null {
  const raw = p.api ?? KNOWN_BASE_URLS[id] ?? null;
  return raw !== null && /^https?:\/\//i.test(raw) ? raw.replace(/\/+$/, "") : null;
}

export function dialectTargets(data: ModelsDevData): DialectTarget[] {
  const byBase = new Map<string, string[]>();
  for (const [id, provider] of Object.entries(data)) {
    const base = baseUrlOf(id, provider);
    if (!base) continue;
    const providers = byBase.get(base);
    if (providers) providers.push(id);
    else byBase.set(base, [id]);
  }
  return [...byBase].map(([base, providers]) => ({
    base,
    providers: providers.sort(),
  })).sort((a, b) => a.base.localeCompare(b.base));
}

export function dialectSourceFingerprint(data: ModelsDevData): string {
  return JSON.stringify(dialectTargets(data));
}
