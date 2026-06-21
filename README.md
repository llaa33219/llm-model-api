<p align="center">
  <img src="logo.svg" width="800" alt="lma — LLM Model API">
</p>

<p align="center">
  <a href="https://lma.blp.sh"><img alt="Live" src="https://img.shields.io/endpoint?url=https%3A%2F%2Flma.blp.sh%2F&label=live"></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/License-Apache_2.0-blue.svg"></a>
  <img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare-Workers-orange?logo=cloudflare">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript">
</p>

Re-shaped view of [`models.dev/api.json`](https://models.dev/api.json) deployed to `lma.blp.sh` via Cloudflare Workers.

**Live endpoint**: <https://lma.blp.sh>

## Endpoints

| Endpoint | Returns |
|---|---|
| `GET https://lma.blp.sh/provider` | Every provider's `name`, short `npm` package name, and `api` URL. |
| `GET https://lma.blp.sh/model-list?provider-name=<name>` | All models for one provider. Fuzzy-matches the provider name (case/whitespace-insensitive, ≥70% similarity). |
| `GET https://lma.blp.sh/model?model-name=<name>` | Every model matching the name across **all** providers. Supports `provider/model` input syntax. Returns provider name, context window, max output tokens, input/output pricing, cache pricing, reasoning options. |
| `GET https://lma.blp.sh/cache-status` | Internal cache diagnostics (age, TTL, staleness). |
| `GET https://lma.blp.sh/` | This index. |

## Quick examples

```bash
# List every provider
curl https://lma.blp.sh/provider

# Models for OpenAI (whitespace + case-insensitive)
curl 'https://lma.blp.sh/model-list?provider-name=open%20ai'

# Models for Anthropic (typo-tolerant fuzzy match)
curl 'https://lma.blp.sh/model-list?provider-name=anthrpoic'

# Find GPT-5 across every provider (returns 20+ duplicates from gateways)
curl 'https://lma.blp.sh/model?model-name=gpt-5'

# Provider/model syntax — restricts to a specific provider
curl 'https://lma.blp.sh/model?model-name=openai/gpt-5'

# Whitespace + version-separator-insensitive
curl 'https://lma.blp.sh/model?model-name=claude%20opus%204%205'

# Cache diagnostics
curl https://lma.blp.sh/cache-status
```

## Matching rules

- **Case-insensitive** — `GPT-5` ≡ `gpt-5`
- **Whitespace-insensitive** — `claude opus 4 5` ≡ `claudeopus45`
- **Separator-insensitive** — `claude-opus-4.5` ≡ `claudeopus45` (strips ` - _ .`)
- **Substring boosting** — `gpt-5` inside `gpt-5-mini` scores `0.7 + 0.3 · lenRatio`
- **Edit-distance fallback** — otherwise `1 - levenshtein/maxLen`
- **Threshold** — `0.7` (70% similarity) by default; otherwise the endpoint returns `404`

## Provider/model input

`GET /model?model-name=openai/gpt-5` is parsed as `{ provider: "openai", model: "gpt-5" }`. Both halves must independently score ≥70%. Use plain `gpt-5` to search across every provider — the same underlying model can appear under OpenAI, OpenRouter, Vercel, GitHub Models, ZenMux, Requesty, and 20+ others, and all of them will be returned (sorted by match score).

## Caching

- Source: `https://models.dev/api.json`
- TTL: **10 minutes** (balances freshness against request volume)
- Module-level cache survives across requests within the same isolate
- Concurrent refreshes are deduped via a single in-flight promise — no thundering herd

## Local development

```bash
npm install
npm run dev            # wrangler dev on http://127.0.0.1:8787
npm run typecheck      # tsc --noEmit
```

## Deploying to lma.blp.sh

### Prerequisites

1. **Domain on Cloudflare.** `blp.sh` (and therefore `lma.blp.sh`) must be added as a zone in your Cloudflare account with nameservers pointed at Cloudflare. DNS for `lma.blp.sh` will be managed automatically by Workers once the custom domain is attached — you don't need to create a CNAME record manually.

2. **Wrangler authentication.** Either run `wrangler login` interactively, or set:
   ```bash
   export CLOUDFLARE_API_TOKEN=...        # Account → Workers → Edit + Account Settings → Read
   export CLOUDFLARE_ACCOUNT_ID=...       # Account ID, right sidebar of the dashboard home
   ```

### Deploy

```bash
npm run deploy
```

The `routes` block in `wrangler.jsonc` tells Cloudflare to attach `lma.blp.sh` as a custom domain for this worker on first deploy (and on every subsequent deploy it just updates the existing binding):

```jsonc
"routes": [
  {
    "pattern": "lma.blp.sh",
    "custom_domain": true
  }
]
```

If the deploy fails with *"custom hostname is not allowed"*, `lma.blp.sh` is not yet on Cloudflare — add the parent `blp.sh` zone first via the Cloudflare dashboard (or transfer it to Cloudflare Registrar).

### Verify

After the first deploy, Cloudflare provisions a certificate for `lma.blp.sh` (usually under a minute). Then:

```bash
curl -i https://lma.blp.sh/provider
# → 200 OK, JSON body, Content-Type: application/json
```

If you see a 525 or 526 error, the SSL certificate hasn't finished provisioning — wait ~60 seconds and retry.

## Project layout

```
.
├── src/
│   ├── index.ts        # router + fetch handler
│   ├── handlers.ts     # per-endpoint logic
│   ├── fetch.ts        # models.dev fetch + 10-min cache
│   ├── match.ts        # normalize / levenshtein / similarity
│   └── types.ts        # models.dev type definitions
├── wrangler.jsonc
├── tsconfig.json
└── package.json
```

## Example responses

### `GET /provider`

```json
{
  "count": 144,
  "providers": [
    { "name": "OpenAI",    "npm": "openai",            "api": null },
    { "name": "Anthropic", "npm": "anthropic",         "api": null },
    { "name": "DeepSeek",  "npm": "openai-compatible", "api": "https://api.deepseek.com" }
  ]
}
```

### `GET /model-list?provider-name=open%20ai`

```json
{
  "provider": "OpenAI",
  "score": 1,
  "modelCount": 51,
  "models": [
    { "id": "gpt-3.5-turbo", "name": "GPT-3.5 Turbo" },
    { "id": "gpt-4",         "name": "GPT-4" },
    { "id": "gpt-5",         "name": "GPT-5" }
  ]
}
```

### `GET /model?model-name=openai/gpt-5`

```json
{
  "query": "openai/gpt-5",
  "count": 1,
  "totalMatches": 1,
  "models": [
    {
      "provider": "OpenAI",
      "provider_id": "openai",
      "model_id": "gpt-5",
      "model_name": "GPT-5",
      "context_window": 400000,
      "max_input_tokens": 272000,
      "max_output_tokens": 128000,
      "input_price": 1.25,
      "output_price": 10,
      "cache_read_price": 0.125,
      "cache_write_price": null,
      "reasoning": true,
      "reasoning_options": [{ "type": "effort", "values": ["minimal", "low", "medium", "high"] }],
      "score": 1
    }
  ]
}
```

### `GET /cache-status`

```json
{
  "hasData": true,
  "fetchedAt": 1782010626957,
  "ageMs": 42318,
  "ttlMs": 600000,
  "isStale": false
}
```

## License

[Apache License 2.0](./LICENSE) — see [`LICENSE`](./LICENSE) for the full text.