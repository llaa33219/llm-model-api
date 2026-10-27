export type Modality = "text" | "image" | "audio" | "video" | "pdf";

export type ReasoningOption =
  | { type: "effort"; values: Array<string | null> }
  | { type: "budget_tokens"; min?: number; max?: number }
  | { type: "toggle" };

export type ModelProviderOverride = {
  npm?: string;
  api?: string;
  shape?: "responses" | "completions";
};

export type Interleaved = boolean | { field: "reasoning_content" | "reasoning_details" };

export type ModelStatus = "alpha" | "beta" | "deprecated";

export type Model = {
  id: string;
  name: string;
  family: string;
  attachment: boolean;
  tool_call: boolean;
  temperature?: boolean;
  structured_output?: boolean;
  open_weights: boolean;
  reasoning: boolean;
  reasoning_options?: ReasoningOption[];
  interleaved?: Interleaved;
  modalities: { input: Modality[]; output: Modality[] };
  limit: {
    context: number;
    input?: number;
    output: number;
  };
  cost?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
    input_audio?: number;
    output_audio?: number;
    reasoning?: number;
    context_over_200k?: { input: number; output: number; cache_read?: number };
    tiers?: Array<{
      input: number;
      output: number;
      cache_read?: number;
      tier: { type: string; size: number };
    }>;
  };
  knowledge?: string;
  release_date: string;
  last_updated: string;
  status?: ModelStatus;
  experimental?: {
    modes: Record<string, { cost?: Model["cost"]; provider?: ModelProviderOverride }>;
  };
  provider?: ModelProviderOverride;
};

export type Provider = {
  id: string;
  name: string;
  npm: string;
  /**
   * Base URL of the provider's API. Absent for providers whose SDK derives the
   * URL internally (OpenAI, Anthropic, Google, xAI, Groq, ...) — models.dev
   * leaves `api` empty for those; see KNOWN_BASE_URLS in dialects.ts.
   * May contain `${ENV_VAR}` placeholders (e.g. Neon, Snowflake).
   */
  api?: string;
  doc: string;
  env: string[];
  models: Record<string, Model>;
};

export type ModelsDevData = Record<string, Provider>;

/** Dialect endpoints partitioned by the detector's confidence. */
export type DialectEndpoints = {
  /** Confirmed by a dialect-specific response, error envelope, or fingerprint. */
  supported: Record<string, string>;
  /** Plausible but unconfirmed (for example, a generic auth wall or rate limit). */
  likely: Record<string, string>;
};

/** Live-probed dialect support for one provider (keyless detection). */
export type DialectInfo = {
  /** Dialect id -> full endpoint URL, partitioned by confidence. */
  endpoints: DialectEndpoints;
  /** epoch ms when this provider was probed */
  probedAt: number;
  /** wall time of that provider's detection */
  durationMs: number;
};
/** A unique provider base URL and the provider ids that share its probe result. */
export type DialectTarget = {
  base: string;
  providers: string[];
};

/** One persisted probe attempt, including empty and failed results. */
export type DialectRecord = {
  base: string;
  endpoints: DialectEndpoints;
  probedAt: number;
  durationMs: number;
  nextAttemptAt: number;
  error: string | null;
};

/** Shared snapshot returned by the singleton Durable Object to Worker isolates. */
export type DialectSnapshot = {
  schemaVersion: number;
  source: string | null;
  targets: DialectTarget[];
  records: DialectRecord[];
  refreshing: boolean;
  lastError: string | null;
  lastBatchAt: number | null;
  lastBatchDurationMs: number | null;
};

export type Env = {
  DIALECT_DETECTOR: DurableObjectNamespace;
};
