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
| `GET https://lma.blp.sh/provider` | Every provider's `name`, short `sdk` package name, and `api` URL. |
| `GET https://lma.blp.sh/model-list?provider-name=<name>` | All models for one provider. Fuzzy-matches the provider name (case/whitespace-insensitive, ≥70% similarity). |
| `GET https://lma.blp.sh/model?model-name=<name>` | Every model matching the name across **all** providers. **Strict** exact match (no fuzzy) — see [Matching rules](#matching-rules). Supports `provider/model` and `provider-model` syntax. Returns provider name, context window, max output tokens, input/output pricing, cache pricing, reasoning options. |
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

# Find GPT-5 across every provider (strict exact — returns only gpt-5, not gpt-5.1 / gpt-5.5 / gpt-5-mini)
curl 'https://lma.blp.sh/model?model-name=gpt-5'

# Same query, different normalizations all hit gpt-5
curl 'https://lma.blp.sh/model?model-name=GPT-5'
curl 'https://lma.blp.sh/model?model-name=gpt%205'
curl 'https://lma.blp.sh/model?model-name=gpt5'

# Provider/model syntax
curl 'https://lma.blp.sh/model?model-name=openai/gpt-5'

# Provider prefix with dash also accepted
curl 'https://lma.blp.sh/model?model-name=openai-gpt-5'

# Whitespace + separator-insensitive
curl 'https://lma.blp.sh/model?model-name=claude%20opus%204%205'

# These will NOT match gpt-5 (404):
#   ?model-name=gpt-5.1    ?model-name=gpt-5.5    ?model-name=gpt-5-mini    ?model-name=gpt-4o

# Cache diagnostics
curl https://lma.blp.sh/cache-status
```

## Matching rules

The two endpoints use **different** matching strategies. Provider names are forgiving — they're display labels and you usually only need to be close. Model identifiers are load-bearing — `gpt-5`, `gpt-5.1`, `gpt-5.5`, and `gpt-5-mini` are four distinct models and must never collapse.

### Provider matching (`/model-list?provider-name=`)

Forgiving fuzzy match. Normalize, score, return the best candidate ≥70%.

- **Case-insensitive** — `OpenAI` ≡ `openai`
- **Whitespace-insensitive** — `GitHub Copilot` ≡ `githubcopilot`
- **Separator-insensitive** — `ali baba cn` ≡ `alibabacn` (strips ` - _ .`)
- **Substring boosting** — `openai` inside `openai-compatible` scores `0.7 + 0.3 · lenRatio`
- **Edit-distance fallback** — otherwise `1 - levenshtein/maxLen`
- **Threshold** — `0.7` (70% similarity); otherwise returns `404`

### Model matching (`/model?model-name=`)

**Strict exact match only** after normalization. No fuzzy, no substring, no edit distance. The `match_type` field on each result tells you which of three paths matched:

| `match_type` | Form | Example input | Example match |
|---|---|---|---|
| `exact` | Full input equals a normalized `model.id` or `model.name` | `gpt-5`, `gpt 5`, `GPT-5`, `gpt5`, `claude opus 4 5` | `gpt-5`, `claude-opus-4-5` |
| `split` | Input contains `/`; both halves exactly match a known provider and a model identifier | `openai/gpt-5`, `Anthropic/claude-opus-4-5` | OpenAI / `gpt-5` |
| `prefix` | Input begins with a known provider's normalized name/id; remainder is a model identifier | `openai-gpt-5`, `anthropic-claude-opus-4-5` | OpenAI / `gpt-5` |

**Will NOT match** (these are blocked on purpose):
- `gpt-5.1`, `gpt-5.5`, `gpt-5-mini` — distinct models
- `gpt-4o` when searching for `gpt-5` — distinct models
- `claudeopus` for `claude-opus-4-5` — too short, fuzzy rejected

If you want a model variant, type the full id (e.g. `gpt-5.1` directly). If no model matches, the endpoint returns `404`.

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
    { "name": "OpenAI",    "sdk": "openai",            "api": null },
    { "name": "Anthropic", "sdk": "anthropic",         "api": null },
    { "name": "DeepSeek",  "sdk": "openai-compatible", "api": "https://api.deepseek.com" }
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