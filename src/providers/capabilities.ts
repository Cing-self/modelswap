// Model capability metadata, consumed when OKIT writes custom model entries
// into additive agents' config files (WorkBuddy models.json).
//
// WorkBuddy's UI writes these flags automatically when a user creates a model
// from its template, and the flags have runtime effects (e.g.
// supportsToolCall===false makes WorkBuddy strip tools/tool_choice from the
// request body). OKIT-written entries must therefore carry the same fields
// explicitly instead of relying on unknown defaults.
//
// Sources: models.dev catalog (fetched by web/api/models-dev.js); name-based
// heuristics below are the fallback when catalog metadata is absent.
// (official pricing pages), MiMo's official CodeBuddy integration template,
// and field values from WorkBuddy's own model template UI. When data is
// uncertain we fall back to conservative family defaults and omit optional
// numeric limits rather than guess.

export interface ModelCapabilities {
  supportsToolCall: boolean;
  supportsImages: boolean;
  supportsReasoning: boolean;
  /** Reasoning effort vocabulary, e.g. ["low","high","max"]. Omit when unknown. */
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

// Conservative fallback for unknown models: coding endpoints virtually always
// speak tool calls; vision/reasoning stay off until proven otherwise.
const DEFAULT_CAPS: ModelCapabilities = {
  supportsToolCall: true,
  supportsImages: false,
  supportsReasoning: false,
};

// Exact-id overrides. Values here either come from official docs or from
// entries the user created via WorkBuddy's own template UI.
const EXACT: Record<string, Partial<ModelCapabilities>> = {
  // DeepSeek V4 — template-verified efforts (user's WorkBuddy UI entry).
  "deepseek-v4-pro": { supportsReasoning: true, reasoningEfforts: ["high", "max"], defaultReasoningEffort: "high", maxInputTokens: 1_000_000 },
  "deepseek-v4-flash": { supportsReasoning: true, reasoningEfforts: ["high", "max"], defaultReasoningEffort: "high", maxInputTokens: 1_000_000 },
  // Kimi — template-verified (user's WorkBuddy UI entries).
  "kimi-k3": { supportsReasoning: true, reasoningEfforts: ["low", "high", "max"], defaultReasoningEffort: "high", maxInputTokens: 1_000_000, maxOutputTokens: 131_072 },
  "kimi-k2.5": { supportsImages: true },
  "kimi-k2.6": { supportsImages: true, supportsReasoning: true, maxInputTokens: 2_000_000 },
  // GLM — token limits from the user's template entry for 5.2.
  "glm-5.2": { supportsReasoning: true, maxInputTokens: 1_000_000, maxOutputTokens: 131_072 },
  // MiMo — official integration template values.
  "mimo-v2.5": { supportsReasoning: true, maxInputTokens: 1_000_000 },
  "mimo-v2.5-pro": { supportsReasoning: true, maxInputTokens: 1_000_000 },
  // Vision / OCR variants.
  "glm-5v-turbo": { supportsImages: true, supportsReasoning: true },
  "glm-4.6v": { supportsImages: true },
  "glm-ocr": { supportsToolCall: false, supportsImages: true },
  "step-image-edit-2": { supportsToolCall: false, supportsImages: true },
  // Tencent token-plan aggregated entry (template-verified).
  "tc-code-latest": { supportsReasoning: true },
  // Template-verified against WorkBuddy's own provider templates (the user
  // created these via WorkBuddy's UI; template values win over family rules).
  "glm-5": { supportsReasoning: false },
  "MiniMax-M2.5": { supportsImages: true, supportsReasoning: false },
};

// Family rules, longest-prefix-first. Applied after exact lookup misses.
// tool calls default to true everywhere (DEFAULT_CAPS), so entries below only
// carry deltas.
const PREFIX_RULES: Array<{ prefix: string; caps: Partial<ModelCapabilities> }> = [
  { prefix: "claude-", caps: { supportsImages: true, supportsReasoning: true } },
  { prefix: "gpt-", caps: { supportsImages: true, supportsReasoning: true } },
  { prefix: "openai/gpt-", caps: { supportsImages: true, supportsReasoning: true } },
  { prefix: "o3", caps: { supportsImages: true, supportsReasoning: true } },
  { prefix: "o4-mini", caps: { supportsImages: true, supportsReasoning: true } },
  { prefix: "grok-", caps: { supportsImages: true, supportsReasoning: true, maxInputTokens: 500_000 } },
  { prefix: "deepseek-v4", caps: { supportsReasoning: true, maxInputTokens: 1_000_000 } },
  { prefix: "deepseek-r1", caps: { supportsReasoning: true } },
  { prefix: "deepseek-v3", caps: { supportsReasoning: true } },
  { prefix: "glm-5", caps: { supportsReasoning: true } },
  { prefix: "glm-4", caps: { supportsReasoning: true } },
  { prefix: "kimi-k3", caps: { supportsImages: true, supportsReasoning: true } },
  { prefix: "kimi-k2.7", caps: { supportsReasoning: true } },
  { prefix: "kimi-k2", caps: { supportsImages: true } },
  { prefix: "minimax-m", caps: { supportsReasoning: true } },
  { prefix: "MiniMax-M", caps: { supportsReasoning: true } },
  { prefix: "MiniMax-Text", caps: {} },
  { prefix: "qwen3-coder", caps: { supportsReasoning: true, maxInputTokens: 1_000_000 } },
  { prefix: "qwen3.", caps: { supportsReasoning: true } },
  { prefix: "qwen3-", caps: { supportsReasoning: true } },
  { prefix: "qwen-", caps: {} },
  { prefix: "doubao-seed", caps: { supportsReasoning: true, maxInputTokens: 256_000 } },
  { prefix: "hy3", caps: { supportsReasoning: true } },
  { prefix: "hunyuan-", caps: {} },
  { prefix: "mistral-", caps: {} },
  { prefix: "step-3", caps: { supportsReasoning: true } },
  { prefix: "step-", caps: {} },
  { prefix: "moonshot-v1", caps: {} },
];

/**
 * Resolve capability metadata for a model id. Exact ids win, then the longest
 * matching family prefix, then conservative defaults. Never returns partial
 * data — callers can spread the result directly.
 */
export function resolveModelCapabilities(modelId: string): ModelCapabilities {
  const exact = EXACT[modelId];
  if (exact) return { ...DEFAULT_CAPS, ...exact };

  let best: { prefix: string; caps: Partial<ModelCapabilities> } | undefined;
  for (const rule of PREFIX_RULES) {
    if (modelId.startsWith(rule.prefix) && (!best || rule.prefix.length > best.prefix.length)) {
      best = rule;
    }
  }
  return best ? { ...DEFAULT_CAPS, ...best.caps } : { ...DEFAULT_CAPS };
}
