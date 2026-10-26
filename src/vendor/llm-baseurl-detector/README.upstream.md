<p align="center">
  <img src="./logo.png" alt="llm-baseurl-detector" width="720">
</p>

# llm-baseurl-detector

Give it **one LLM API base URL** — it probes candidate endpoints and tells you which API
dialects the host actually speaks:

- `openai-chat` — OpenAI Chat Completions (`POST .../chat/completions`)
- `openai-responses` — OpenAI Responses (`POST .../responses`)
- `anthropic-messages` — Anthropic Messages (`POST .../v1/messages`)
- `gemini-generate` — Gemini `generateContent`
- `typesafe-systemone` — TypeSafe System One (`POST .../v1/systemone`)

Detection is **pure probing** — no bundled provider database, no hardcoded host
list. Every verdict comes from what the host actually answers.

## Install

```sh
npm install llm-baseurl-detector
```

Requires Node.js ≥ 18 (uses global `fetch`). Zero runtime dependencies.

## Library usage

```js
import { detect } from 'llm-baseurl-detector';

const result = await detect('https://api.example.com/v1', {
  apiKey: process.env.MY_API_KEY, // optional but strongly recommended
});

console.log(result.endpoints);
// { 'openai-chat': 'https://api.example.com/v1/chat/completions',
//   'anthropic-messages': 'https://api.example.com/anthropic/v1/messages' }
```

### `detect(baseUrl, options?) → Promise<DetectionResult>`

Options (all optional):

| option | default | meaning |
|---|---|---|
| `apiKey` | — | sent as `Authorization: Bearer` (also `x-api-key` for Anthropic, `x-goog-api-key` for Gemini) |
| `model` / `models` | per-dialect defaults | model id used in probe payloads |
| `timeoutMs` | `8000` | per-probe timeout |
| `concurrency` | `6` | max concurrent probes within one dialect |
| `dialects` | all | restrict which dialects get probed |
| `extraPaths` | — | extra candidate paths per dialect |
| `probeModels` | `false` | also probe `GET {base}/models` and report the OpenAI model list |
| `fingerprintProbes` | `true` | keyless only: retry a generic auth wall with a shape-mismatched body to detect validate-before-auth providers |
| `headers` | — | extra headers merged into every probe |

### Result shape

```ts
{
  baseUrl: string;
  probes: Array<{
    dialect: 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-generate' | 'typesafe-systemone';
    probedUrl: string;
    status: 'supported' | 'likely' | 'not-found' | 'unknown';
    httpStatus?: number;
    detail: string;
    signals: string[];
  }>;
  endpoints: { [dialect]: string };            // dialects with status supported|likely
  durationMs: number;
}
```

### Verdict semantics

- **`supported`** — either HTTP 2xx whose body matches the dialect's **success shape**
  (verified against live provider docs, Oct 2026):
  - chat: `object: "chat.completion"` or `choices[]`
  - responses: `object: "response"` or `output[]` + `status`
  - anthropic: `type: "message"` (+ `content`/`role`)
  - gemini: `candidates` / `modelVersion` / `usageMetadata`
  - typesafe: `answers` + `usage.input_tokens`
  — **or** an auth wall (401/403) carrying the dialect's **error envelope**:
  anthropic `{"type":"error","error":{"type":...}}`, gemini `{"error":{"code":N,"status":"..."}}`,
  typesafe `{"detail":...}` are dialect-specific even on error paths, so they confirm
  the dialect without a key. (The OpenAI `{error:{message}}` envelope is too
  widespread across gateways to count — it stays `likely`.)
- **`likely`** — route probably exists but could not be confirmed: generic auth wall
  (401/403), a model-hint 404/400/422 in the dialect's error envelope, a dialect-shaped
  405, or 429.
- **`not-found`** — clean HTTP 404 (route does not exist). A 404 whose body merely
  echoes the request path (spring-style `{timestamp,status,error,path}`) does **not**
  count as a model hint — that upgrade requires the dialect's error envelope.
- **`unknown`** — network error, timeout, 5xx, a non-JSON 2xx (SPA fallback / echo
  proxy, signal `catch-all-suspected`), a 2xx/400/405 whose JSON body matches no
  known dialect shape (generic catch-all / gateway error — signal `2xx-unusual-shape`
  or `405`).

Probes send a deliberately minimal, spec-valid request per dialect:

| dialect | request body (verified against live docs, Oct 2026) |
|---|---|
| openai-chat | `{model, messages:[{role:user, content:"ping"}], max_tokens:1}` |
| openai-responses | `{model, input:"ping", max_output_tokens:64}` (64: reasoning models burn budget before visible output) |
| anthropic-messages | `{model, max_tokens:1, messages:[...]}` + `anthropic-version: 2023-06-01` header |
| gemini-generate | `{contents:[{parts:[{text:"ping"}]}]}` |
| typesafe-systemone | `{model, state:"ping", questions:{echo:{type:"noul",...}}}` — **no** `messages`/`input` |

## Keyless detection (no API key)

The detector is built to work **without** a key. Three independent keyless signals,
in order of strength:

1. **Dialect error envelope at the auth wall (→ `supported`).** Anthropic answers
   `{type:"error",error:{type:"authentication_error"}}`, Gemini `{error:{code,status}}`,
   TypeSafe `{detail:{error_type}}` — and crucially, these envelopes appear **even on
   the 401/403 that precedes auth**, and even for requests with a broken body. Seeing
   the dialect's envelope proves the dialect is implemented. The OpenAI
   `{error:{message}}` shape is deliberately *not* used (every gateway emits it).
2. **Validate-before-auth fingerprinting (→ `supported`).** When the first probe hits
   a *generic* auth wall, the detector sends a second probe with a required field
   removed (`messages` for chat, `input` for responses, ...). Providers that validate
   the body **before** checking auth answer differently (401 → 400), or answer with a
   body that names the missing field — both prove the route really exists. Auth-first
   providers answer identically, so nothing changes. Verified against a 203-provider
   keyless sweep (models.dev catalog, Oct 2026): ~14 providers validate before auth,
   incl. engy, xai, subconscious, neuralwatt, lowrouter, modelscope, ovhcloud.
   Disable with `fingerprintProbes: false`.
3. **Model-hint 404 / dialect-shaped 400-405 (→ `likely`).** A 404 that rejects the
   *model* (in the dialect's envelope) or a 400/405 with the dialect's envelope means
   the route exists but the probe couldn't fully confirm.

A host-wide auth middleware that answers **identical** 401s for every path (seen on
real providers) defeats keyless dialect discrimination by design — every dialect then
reports `likely`, which is the honest answer. Pass `apiKey` for per-route certainty.

With a key, per-route verdicts are trustworthy and probing early-exits on the primary
candidate.

## CLI

```sh
npx llm-baseurl-detect https://api.example.com/v1 --api-key $KEY
llm-baseurl-detect https://api.example.com/v1 --dialects openai-chat,anthropic-messages --json
```

Options: `--api-key`, `--model`, `--timeout <ms>`, `--dialects a,b,c`, `--models`, `--json`.

## How detection works

1. Normalizes the input (trailing slashes trimmed).
2. Builds candidate URLs per dialect from the input base: the primary pattern plus
   alternate mount points (`{origin}`, `/anthropic`, `/api/v1`, `/openai`, `/v2`...).
   No provider database is consulted — candidates come from path patterns only.
3. For each dialect, builds candidate URLs: DB-seeded endpoints for that host (only
   ones rooted at the input base), then the primary pattern candidate per dialect.
4. Candidates are probed in order, one at a time; dialects run concurrently
   (`concurrency` bounds cross-dialect parallelism). The best verdict per dialect wins
   (`supported` > `likely` > `unknown` > `not-found`).
5. With an `apiKey`, probing early-exits at the first `likely`/`supported` verdict —
   a keyed verdict on the primary route is trustworthy. Without a key, probing keeps
   walking alternate sibling mounts (`{origin}/anthropic`, ...) while the verdict is
   weak, since a keyless generic 401 cannot distinguish route-exists from global-auth —
   but a dialect-shaped error envelope can (see above).

## License

Apache-2.0
