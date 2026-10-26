/**
 * Vendored from llm-baseurl-detector@0.1.2 (Apache-2.0)
 * https://github.com/llaa33219/llm-baseurl-detector
 *
 * TypeScript port of dist/probe.js + dist/detector.js, stripped to what this
 * worker uses: keyless `detect()` (no apiKey / probeModels / models-list probe).
 * Copyright 2026 llaa33219. See LICENSE (Apache-2.0) at repo root.
 */

/** API dialects the detector can identify. */
export type DialectId =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "gemini-generate"
  | "typesafe-systemone";

/** How confident the probe verdict is. */
export type ProbeStatus = "supported" | "likely" | "not-found" | "unknown";

export interface DialectProbe {
  dialect: DialectId | "models-list";
  /** URL that was actually probed. */
  probedUrl: string;
  status: ProbeStatus;
  /** HTTP status code of the probe response, if a response was received. */
  httpStatus?: number;
  /** One-line human explanation of the verdict. */
  detail: string;
  /** Raw signal codes, useful for programmatic consumers. */
  signals: string[];
}

export interface DetectionResult {
  /** Normalized input base URL (trailing slash trimmed). */
  baseUrl: string;
  probes: DialectProbe[];
  /** Dialects with status 'supported' or 'likely', with the best-guess full endpoint URL. */
  endpoints: Partial<Record<DialectId, string>>;
  /** Total wall time of the detection in ms. */
  durationMs: number;
}

export interface DetectOptions {
  /**
   * Send a second, shape-mismatched probe (missing required field) when the first
   * probe hits a generic auth wall. Some providers validate the body BEFORE auth,
   * which reveals the dialect keyless. Default true.
   */
  fingerprintProbes?: boolean;
  /** Extra headers merged into every probe request. */
  headers?: Record<string, string>;
  /** Model id used in probe payloads. Default per-dialect. */
  model?: string;
  /** Per-dialect model override. */
  models?: Partial<Record<DialectId, string>>;
  /** Per-probe timeout in ms. Default 8000. */
  timeoutMs?: number;
  /** Max concurrent probes. Default 6. */
  concurrency?: number;
  /** Restrict probing to these dialects. Default: all. */
  dialects?: DialectId[];
  /** Extra candidate URL paths to try, appended per dialect after built-ins. */
  extraPaths?: Partial<Record<DialectId, string[]>>;
}

/* ------------------------------------------------------------------ */
/* probe.js port                                                       */
/* ------------------------------------------------------------------ */

const SNIPPET_LIMIT = 4096; // large enough for reasoning-first Responses payloads

interface ProbeRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

interface ProbeResponse {
  ok: boolean;
  status?: number;
  bodySnippet?: string;
  contentType?: string;
  error?: string;
}

async function sendProbe(
  req: ProbeRequest,
  timeoutMs: number,
  bodyLimit: number = SNIPPET_LIMIT,
): Promise<ProbeResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body ?? null,
      signal: controller.signal,
      redirect: "follow",
    });
    let bodySnippet: string | undefined;
    try {
      const text = await res.text();
      bodySnippet = text.slice(0, bodyLimit);
    } catch {
      bodySnippet = undefined;
    }
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    return { ok: true, status: res.status, bodySnippet, contentType };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === "AbortError"
          ? `timeout after ${timeoutMs}ms`
          : err.message
        : String(err);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

const MODEL_404_HINT = /model/;

/**
 * Classify a probe response for an LLM dialect endpoint.
 *
 * Key insight: many providers route unknown paths to a SPA fallback or a plain 404,
 * while a real LLM route that rejects the *model* still mentions "model" in the body.
 */
function classify(
  res: ProbeResponse,
  dialect: DialectId,
  hadAuth: boolean,
  verifyBody: (snippet: string) => boolean,
  verifyErrorBody: (snippet: string) => boolean,
): { status: ProbeStatus; detail: string; signals: string[] } {
  const signals: string[] = [];
  if (!res.ok) {
    return {
      status: "unknown",
      detail: `request failed: ${res.error ?? "network error"}`,
      signals: ["network-error"],
    };
  }
  const code = res.status ?? 0;
  const body = (res.bodySnippet ?? "").toLowerCase();
  const mentionsModel = MODEL_404_HINT.test(body);

  if (code >= 200 && code < 300) {
    signals.push("2xx");
    const snippet = res.bodySnippet ?? "";
    const isJson = (res.contentType ?? "").includes("json");
    if (verifyBody(snippet)) {
      signals.push("body-shape-match");
      return {
        status: "supported",
        detail: `HTTP ${code} with a ${dialect}-shaped response body`,
        signals,
      };
    }
    if (!isJson) {
      signals.push("non-json-2xx", "catch-all-suspected");
      return {
        status: "unknown",
        detail: `HTTP ${code} but non-JSON body — likely a SPA fallback or echo proxy`,
        signals,
      };
    }
    signals.push("2xx-unusual-shape");
    return {
      status: "unknown",
      detail: `HTTP ${code} JSON but not a ${dialect} shape — possible catch-all route`,
      signals,
    };
  }

  if (code === 401 || code === 403) {
    signals.push("auth-wall");
    if (verifyErrorBody(res.bodySnippet ?? "")) {
      signals.push("error-shape-match");
      if (dialect !== "openai-chat" && dialect !== "openai-responses") {
        // Strong envelopes (anthropic / gemini / typesafe) confirm the dialect even
        // at the auth wall — a global gateway would not emit the dialect's envelope.
        return {
          status: "supported",
          detail: `HTTP ${code} auth wall with a ${dialect}-specific error envelope`,
          signals,
        };
      }
    }
    return {
      status: "likely",
      detail: hadAuth
        ? `HTTP ${code} despite credentials — key may lack scope, but the route answered`
        : `HTTP ${code} auth wall (route probably exists; resend with an apiKey to confirm)`,
      signals,
    };
  }

  if (code === 404) {
    signals.push("http-404");
    if (mentionsModel && verifyErrorBody(res.bodySnippet ?? "")) {
      signals.push("model-hint", "error-shape-match");
      return {
        status: "likely",
        detail: `HTTP 404 mentioning "model" in a ${dialect}-shaped error — route exists, model id rejected`,
        signals,
      };
    }
    return {
      status: "not-found",
      detail: "HTTP 404 — route does not exist",
      signals,
    };
  }

  if (code === 400 || code === 422) {
    signals.push(`http-${code}`);
    if (verifyErrorBody(res.bodySnippet ?? "")) {
      signals.push("error-shape-match", "validation-error");
      return {
        status: "likely",
        detail: `HTTP ${code} validation error in a ${dialect}-shaped envelope — route exists, body rejected`,
        signals,
      };
    }
    return {
      status: "unknown",
      detail: `HTTP ${code} without a recognizable error envelope`,
      signals,
    };
  }

  if (code === 405) {
    signals.push("http-405");
    if (verifyErrorBody(res.bodySnippet ?? "")) {
      signals.push("error-shape-match");
      return {
        status: "likely",
        detail: `HTTP 405 with a ${dialect}-shaped error envelope — route exists, method rejected`,
        signals,
      };
    }
    return { status: "unknown", detail: "HTTP 405 Method Not Allowed", signals };
  }

  if (code === 429) {
    signals.push("http-429");
    return {
      status: "likely",
      detail: "HTTP 429 rate limited — route exists but throttled",
      signals,
    };
  }

  signals.push(`http-${code}`);
  return {
    status: "unknown",
    detail: `HTTP ${code} — no dialect signal`,
    signals,
  };
}

/** Build the verdict record for one probe attempt. */
function buildProbeResult(
  dialect: DialectId,
  url: string,
  res: ProbeResponse,
  hadAuth: boolean,
  verifyBody: (snippet: string) => boolean,
  verifyErrorBody: (snippet: string) => boolean,
): DialectProbe {
  const { status, detail, signals } = classify(res, dialect, hadAuth, verifyBody, verifyErrorBody);
  return {
    dialect,
    probedUrl: url,
    status,
    httpStatus: res.status,
    detail,
    signals,
  };
}

/* ------------------------------------------------------------------ */
/* detector.js port                                                    */
/* ------------------------------------------------------------------ */

const ALL_DIALECTS: DialectId[] = [
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "gemini-generate",
  "typesafe-systemone",
];

const DEFAULT_MODELS: Record<DialectId, string> = {
  "openai-chat": "gpt-4o-mini",
  "openai-responses": "gpt-4o-mini",
  // claude-haiku-5-5 is the current-generation id (2026); haiku-4-5 nears retirement
  "anthropic-messages": "claude-haiku-5-5",
  "gemini-generate": "gemini-2.5-flash",
  "typesafe-systemone": "jev-latest",
};

/** Path layouts worth probing for a given input base, derived from the provider DB. */
function candidateUrls(inputBase: string, dialect: DialectId, model: string): string[] {
  const base = inputBase.replace(/\/+$/, "");
  const urls: string[] = [];
  const seen = new Set<string>();
  const push = (u: string) => {
    if (!seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  };
  switch (dialect) {
    case "openai-chat":
      push(`${base}/chat/completions`);
      // observed in the wild: some hosts mount openai surface under /openai
      push(`${base}/openai/chat/completions`);
      push(`${base}/openai/v1/chat/completions`);
      break;
    case "openai-responses":
      push(`${base}/responses`);
      push(`${base}/openai/responses`);
      push(`${base}/openai/v1/responses`);
      break;
    case "anthropic-messages":
      push(`${base}/v1/messages`); // anthropic-style base without /v1
      push(`${base}/messages`); // base already includes /v1
      push(`${base}/anthropic/v1/messages`); // providers that mount anthropic under /anthropic
      break;
    case "gemini-generate":
      push(`${base}/models/${model}:generateContent`);
      push(`${base}/v1beta/models/${model}:generateContent`);
      push(`${base}/v1/models/${model}:generateContent`);
      break;
    case "typesafe-systemone":
      push(`${base}/v1/systemone`);
      push(`${base}/systemone`);
      break;
  }
  // common alternate mount points seen across providers
  for (const b of alternateBases(base)) {
    switch (dialect) {
      case "openai-chat":
        push(`${b}/chat/completions`);
        break;
      case "openai-responses":
        push(`${b}/responses`);
        break;
      case "anthropic-messages":
        push(`${b}/v1/messages`);
        push(`${b}/messages`);
        break;
      case "gemini-generate":
        push(`${b}/models/${model}:generateContent`);
        break;
      case "typesafe-systemone":
        push(`${b}/v1/systemone`);
        break;
    }
  }
  return urls;
}

/**
 * Sibling mount points to try in addition to the given base itself.
 * Pattern alternates derived from the input base.
 * (e.g. zhipu serves chat at /api/paas/v4, responses at /api/v1, anthropic at
 * /api/anthropic — pattern alternates alone never find those).
 */
function alternateBases(base: string): string[] {
  const out: string[] = [];
  const push = (u: string) => {
    if (u !== base && !out.includes(u)) out.push(u);
  };
  const bare = base.replace(/\/(v1|v2|v3|openai|anthropic|api\/v1|api\/paas\/v4|compatible-mode\/v1)$/, "");
  if (bare !== base) {
    push(bare);
    push(`${bare}/anthropic`);
    push(`${bare}/api/v1`);
    push(`${bare}/openai`);
    push(`${bare}/v1`);
  } else {
    push(`${base}/v1`);
    push(`${base}/v2`);
    push(`${base}/anthropic`);
    push(`${base}/api/v1`);
    push(`${base}/openai`);
  }
  return out;
}

interface ProbeDialectOptions {
  timeoutMs: number;
  headers?: Record<string, string>;
  model?: string;
  models?: Partial<Record<DialectId, string>>;
  extraPaths?: Partial<Record<DialectId, string[]>>;
  fingerprintProbes?: boolean;
}

function buildRequest(
  dialect: DialectId,
  url: string,
  model: string,
  extraHeaders: Record<string, string> | undefined,
  fingerprint = false,
): ProbeRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "llm-baseurl-detector/0.1",
    ...(extraHeaders ?? {}),
  };
  // Keyless only: no apiKey branch (vendored port drops keyed probing).
  if (dialect === "anthropic-messages") {
    headers["anthropic-version"] = "2023-06-01";
  }
  let body: string;
  switch (dialect) {
    case "openai-chat":
      body = fingerprint
        ? JSON.stringify({ model }) // omit `messages`: auth-first providers 401,
        // validate-first providers answer 400 {param:"messages"} — revealing the dialect
        : JSON.stringify({
            model,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
            stream: false,
          });
      break;
    case "openai-responses":
      body = fingerprint
        ? JSON.stringify({ model }) // omit `input`
        : JSON.stringify({ model, input: "ping", max_output_tokens: 64 });
      break;
    case "anthropic-messages":
      body = fingerprint
        ? JSON.stringify({ model, max_tokens: 1 }) // omit `messages`
        : JSON.stringify({
            model,
            max_tokens: 1,
            messages: [{ role: "user", content: "ping" }],
          });
      break;
    case "gemini-generate":
      body = fingerprint
        ? JSON.stringify({}) // omit `contents`
        : JSON.stringify({ contents: [{ parts: [{ text: "ping" }] }] });
      break;
    case "typesafe-systemone":
      // real System One wire format (verified against api.typesafe.ai openapi 0.2.0):
      // {model, state, questions} — no messages/input/max_tokens
      body = JSON.stringify({
        model,
        state: "ping",
        questions: { echo: { type: "noul", instructions: "Reply to the ping." } },
      });
      break;
  }
  return { url, method: "POST", headers, body };
}

/**
 * Does a 2xx body actually look like this dialect's response?
 * Guards against SPA fallbacks / echo proxies answering 200 for any path.
 */
export function verifyDialectBody(dialect: DialectId, snippet: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snippet);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const o = parsed as Record<string, unknown>;
  switch (dialect) {
    case "openai-chat":
      return (
        o.object === "chat.completion" ||
        Array.isArray(o.choices) ||
        // minimax-style: openai-compatible surface that still wraps in its native
        // {id, model, base_resp} envelope
        ("base_resp" in o && typeof o.model === "string")
      );
    case "openai-responses": {
      // wire shape (spec): object:"response" + output[] + status. output_text is an
      // SDK-only convenience property — do NOT rely on it.
      if (o.object === "response") return true;
      if (Array.isArray(o.output) && typeof o.status === "string") return true;
      // minimax-style partial: reasoning models with tiny max_output_tokens can return
      // output:[] with only reasoning — no message item, no output_text. The dialect
      // is still Responses if status + usage.input_tokens are present.
      const usage = o.usage as Record<string, unknown> | null | undefined;
      return (
        typeof o.status === "string" &&
        "incomplete_details" in o &&
        typeof usage === "object" &&
        usage !== null &&
        "input_tokens" in usage
      );
    }
    case "anthropic-messages":
      return o.type === "message" || (typeof o.role === "string" && "content" in o);
    case "gemini-generate":
      // native GenerateContentResponse: candidates[] (+ usageMetadata/modelVersion/responseId).
      // note: prompt-blocked responses have NO candidates (promptFeedback.blockReason instead).
      return (
        "candidates" in o ||
        "modelVersion" in o ||
        "responseId" in o ||
        "usageMetadata" in o
      );
    case "typesafe-systemone": {
      // SystemOneResponse: exactly {model, answers, usage:{input_tokens, output_tokens}}
      const usage = o.usage as Record<string, unknown> | null | undefined;
      return (
        "answers" in o &&
        typeof o.model === "string" &&
        typeof usage === "object" &&
        usage !== null &&
        "input_tokens" in usage
      );
    }
  }
}

/**
 * Does an ERROR body look like this dialect's error envelope?
 * Strong discriminator at auth walls: Anthropic-compatible surfaces always answer
 * {"type":"error","error":{"type":...}} — even for nonexistent routes — so seeing
 * that shape means the dialect is really implemented, not just globally auth-gated.
 */
export function verifyDialectErrorBody(dialect: DialectId, snippet: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snippet);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const o = parsed as Record<string, unknown>;
  switch (dialect) {
    case "anthropic-messages": {
      const err = o.error as Record<string, unknown> | null | undefined;
      if (
        !(
          o.type === "error" &&
          typeof err === "object" &&
          err !== null &&
          typeof err.type === "string"
        )
      ) {
        return false;
      }
      // Restrict to Anthropic's documented error.type vocabulary. Providers like
      // minimax emit the same outer {type:error,error:{type}} envelope with a
      // provider-specific type ("authorized_error") on NON-anthropic routes — that
      // is not an anthropic dialect signal. Anthropic's own types (docs.claude.com
      // /en/api/errors): authentication_error, invalid_request_error, not_found_error,
      // permission_error, rate_limit_error, overloaded_error, api_error, billing_error,
      // timeout_error. Third-party anthropic-compatible surfaces reuse these.
      const t = String(err.type);
      return /^(authentication|invalid_request|not_found|permission|rate_limit|overloaded|api|billing|timeout|request_too_large|conflict)_error$/.test(
        t,
      );
    }
    case "openai-chat":
    case "openai-responses": {
      // {error: {message, type, ...}} — shared by chat/responses; weaker than the
      // anthropic envelope, so NOT used to upgrade auth walls to supported.
      const err = o.error as Record<string, unknown> | null | undefined;
      return typeof err === "object" && err !== null && typeof err.message === "string";
    }
    case "gemini-generate": {
      // google.rpc envelope: {error: {code: number, message, status: UPPER_SNAKE}}
      const err = o.error as Record<string, unknown> | null | undefined;
      return (
        typeof err === "object" &&
        err !== null &&
        typeof err.code === "number" &&
        typeof err.status === "string"
      );
    }
    case "typesafe-systemone":
      // FastAPI-style {detail} envelope: object w/ error_type (400/401/403/415/429/529),
      // bare string (404/405), or validation array (422). All dialect-specific.
      return "detail" in o;
  }
}

const STATUS_RANK: Record<ProbeStatus, number> = {
  supported: 3,
  likely: 2,
  unknown: 1,
  "not-found": 0,
};

/** Run probes with bounded concurrency, early-exiting a dialect once 'supported'. */
async function probeDialect(
  inputBase: string,
  dialect: DialectId,
  opts: ProbeDialectOptions,
  seededUrls: string[],
  skipAlternates: boolean,
): Promise<DialectProbe> {
  const model = opts.models?.[dialect] ?? opts.model ?? DEFAULT_MODELS[dialect];
  const primary = [
    ...seededUrls,
    ...candidateUrls(inputBase, dialect, model),
    ...(opts.extraPaths?.[dialect] ?? []).map((p) =>
      p.startsWith("http") ? p : `${inputBase.replace(/\/+$/, "")}/${p.replace(/^\/+/, "")}`,
    ),
  ];
  const alternates = skipAlternates
    ? []
    : candidateUrls(inputBase, dialect, model).filter((u) => !primary.includes(u));
  const urls = [...primary, ...alternates].filter((u, i, a) => a.indexOf(u) === i);
  // Probe strictly in candidate order (primary first), one at a time.
  // Keyless probes keep going while the verdict is weak (a global-auth 401 on the
  // primary route says nothing about alternate mounts); a strong verdict
  // (supported) stops early.
  const fingerprintOn = opts.fingerprintProbes !== false;
  let best: DialectProbe | undefined;
  for (const url of urls) {
    const req = buildRequest(dialect, url, model, opts.headers);
    const res = await sendProbe(req, opts.timeoutMs);
    let probe = buildProbeResult(
      dialect,
      url,
      res,
      false /* hadAuth: keyless */,
      (snip) => verifyDialectBody(dialect, snip),
      (snip) => verifyDialectErrorBody(dialect, snip),
    );
    // Keyless fingerprint: a generic auth wall may just be the host's global auth.
    // Retry with a shape-mismatched body — if the provider validates the body BEFORE
    // auth, the error changes (400/validation), proving the dialect route is real.
    if (
      fingerprintOn &&
      probe.status === "likely" &&
      probe.signals.includes("auth-wall") &&
      !probe.signals.includes("error-shape-match")
    ) {
      const freq = buildRequest(dialect, url, model, opts.headers, true);
      const fres = await sendProbe(freq, opts.timeoutMs);
      if (fres.ok && fres.status !== undefined && fres.status !== probe.httpStatus) {
        // status changed when we broke the body -> validation ran before auth.
        probe = {
          ...probe,
          status: "supported",
          httpStatus: fres.status,
          detail: `validate-before-auth: breaking the body changed HTTP ${probe.httpStatus} -> ${fres.status}, so the ${dialect} route really exists`,
          signals: [...probe.signals, "validate-before-auth", "fingerprint-confirmed"],
        };
      } else if (
        fres.ok &&
        fres.status === probe.httpStatus &&
        (fres.bodySnippet ?? "") !== (res.bodySnippet ?? "")
      ) {
        // same status but the body changed in a way that mentions a request field:
        // the server validated the body before auth, proving the route exists.
        // request_id / timestamp -only diffs do NOT count.
        const diff = (fres.bodySnippet ?? "").toLowerCase();
        // Must name a REQUEST BODY field, not an auth credential. "API key is
        // required" is an auth message, not body validation — exclude it.
        // Patterns verified against a 203-provider keyless sweep (Oct 2026).
        const mentionsField =
          /"param"\s*:\s*"(messages|input|contents|model|state|questions|max_tokens)"/.test(diff) ||
          /["'`](messages|input|contents|state|questions|max_tokens)["'`]?\s+(field\s+)?(is\s+)?(required|missing|cannot be empty)/.test(
            diff,
          ) ||
          /(missing|required|cannot be empty|expected|field required( at)?)[^a-z]{0,12}["'`]?(messages|input|contents|state|questions|max_tokens)["'`]?/.test(
            diff,
          ) ||
          /"loc"\s*:\s*\[\s*"body"\s*,\s*"(messages|input|contents|state|questions)"/.test(diff); // pydantic/fastapi 422
        if (mentionsField) {
          probe = {
            ...probe,
            status: "supported",
            detail: `validate-before-auth: body change revealed field-level validation at HTTP ${fres.status}, so the ${dialect} route really exists`,
            signals: [...probe.signals, "validate-before-auth", "fingerprint-confirmed"],
          };
        }
      }
      // NOTE: a bare same-status body difference is NOT enough — per-request values
      // like request_id differ on every call even when the provider never inspected
      // the body. Only a status change or field-level validation language proves
      // validate-before-auth.
    }
    if (!best || STATUS_RANK[probe.status] > STATUS_RANK[best.status]) best = probe;
    if (probe.status === "supported") break;
  }
  return (
    best ?? {
      dialect,
      probedUrl: "",
      status: "unknown",
      detail: "no candidate URLs generated",
      signals: [],
    }
  );
}

/**
 * Detect which LLM API dialects a base URL supports (keyless).
 *
 * @param baseUrl e.g. "https://api.example.com/v1"
 * @param options see {@link DetectOptions}
 */
export async function detect(baseUrl: string, options: DetectOptions = {}): Promise<DetectionResult> {
  const started = Date.now();
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error(`baseUrl must be an absolute http(s) URL, got: ${baseUrl}`);
  }
  const timeoutMs = options.timeoutMs === undefined ? 8000 : Number(options.timeoutMs);
  const concurrency = options.concurrency === undefined ? 6 : Number(options.concurrency);
  const dialects = options.dialects ?? ALL_DIALECTS;
  // Dialects are probed sequentially. Once any dialect is confirmed at the primary
  // mount, later dialects skip alternate mounts — a catch-all 200/JSON path (seen on
  // real hosts, e.g. zhipu answering 200 {code:500} for unknown routes) must not get
  // the chance to win a dialect that clearly lives elsewhere. Dialects with a strong
  // error envelope (anthropic/gemini/typesafe) keep their alternates: a global 401
  // on the primary says nothing about them, and their envelope can confirm the real
  // mount even keyless.
  const STRONG_ENVELOPE: ReadonlySet<DialectId> = new Set([
    "anthropic-messages",
    "gemini-generate",
    "typesafe-systemone",
  ]);
  const probes: DialectProbe[] = new Array<DialectProbe>(dialects.length);
  const confirmedElsewhere = () =>
    probes.some((p) => p !== undefined && (p.status === "supported" || p.status === "likely"));
  let cursor = 0;
  const pool = Math.max(1, concurrency);
  const worker = async () => {
    while (cursor < dialects.length) {
      const i = cursor++;
      const dialect = dialects[i]!;
      const seeded: string[] = [];
      const skipAlternates = confirmedElsewhere() && !STRONG_ENVELOPE.has(dialect);
      probes[i] = await probeDialect(
        normalized,
        dialect,
        { timeoutMs, ...options },
        seeded,
        skipAlternates,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(pool, dialects.length) }, worker));
  const endpoints: Partial<Record<DialectId, string>> = {};
  for (const p of probes) {
    if (p.dialect === "models-list") continue;
    if (p.status === "supported" || p.status === "likely") {
      (endpoints as Record<string, string>)[p.dialect] = p.probedUrl;
    }
  }
  return {
    baseUrl: normalized,
    probes,
    endpoints,
    durationMs: Date.now() - started,
  };
}
