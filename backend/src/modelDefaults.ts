import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/** The main agent's model for a new session; MAIN_MODEL_PROVIDER and MAIN_MODEL_ID override it. */
export const DEFAULT_MAIN_MODEL = {
  provider: process.env.MAIN_MODEL_PROVIDER ?? "openai-codex",
  modelId: process.env.MAIN_MODEL_ID ?? "gpt-6-astra",
  thinkingLevel: "low" satisfies ModelThinkingLevel,
} as const;

/** The workers' model for a new session; WORKER_MODEL_PROVIDER and WORKER_MODEL_ID override it. */
export const DEFAULT_WORKER_MODEL = {
  provider: process.env.WORKER_MODEL_PROVIDER ?? "openai-codex",
  modelId: process.env.WORKER_MODEL_ID ?? "gpt-5.6-luna",
  thinkingLevel: "medium" satisfies ModelThinkingLevel,
} as const;
