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
  api?: string;
  doc: string;
  env: string[];
  models: Record<string, Model>;
};

export type ModelsDevData = Record<string, Provider>;