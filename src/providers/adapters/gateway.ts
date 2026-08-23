// Shared gateway handling for agent adapters (ZCode, OpenCode, MiMo Code,
// Codex, WorkBuddy, ...).
//
// Two failure modes observed on the opencode.ai / OpenRouter gateways affect
// every agent that OKIT points at them:
//
// 1. User-Agent pool rate limiting. The opencode.ai gateway rate-limits
//    anonymous traffic separately from the official opencode client, which
//    identifies itself via "User-Agent: opencode/<version>". Requests without
//    that UA land in the heavily rate-limited anonymous pool (429
//    FreeUsageLimitError → endless "reconnecting" in ZCode). Verified live:
//    the same endpoint + "public" key returns 200 with the UA and 429 without.
//    Agents that send their own UA (opencode itself) don't need the header;
//    everyone else must send it explicitly.
//
// 2. max_tokens over the gateway cap. ZCode's deepseek-family default output
//    is 384000, but the gateway rejects deepseek-v4-flash-free with "max_tokens
//    is too large ... at most 131072" (400 invalid_request). OpenRouter :free
//    models cap output at 8192 (e.g. gpt-oss-20b:free, laguna-xs.2:free).
//    Adapters write explicit per-model limits so the agent never sends a
//    max_tokens the gateway rejects.

// The opencode client identifies itself with this User-Agent; the opencode.ai
// gateway routes requests carrying it into a separate, generously-quota'd pool.
export const OPENCODE_GATEWAY_UA = "opencode/1.18.15";

// OpenCode Zen free-tier models. ZCode's per-family defaults can exceed the
// gateway's max output; the other free models accept >= 200000 output
// (verified live 2026-08-20); 128000 output is the conservative cap pi and the
// pi.dev registry use for this gateway.
export const OPENCODE_FREE_MODEL_LIMITS: Record<string, { context: number; output: number }> = {
  'deepseek-v4-flash-free': { context: 200000, output: 128000 },
  'hy3-free': { context: 200000, output: 128000 },
  'mimo-v2.5-free': { context: 200000, output: 128000 },
  'nemotron-3-ultra-free': { context: 200000, output: 128000 },
  'nemotron-3.5-lightning-free': { context: 200000, output: 128000 },
  'laguna-s-2.1-free': { context: 200000, output: 128000 },
  'muse-spark-1.2-contributor-free': { context: 200000, output: 128000 },
};

// OpenRouter :free models missing from agents' built-in catalogs (so no
// per-model limit would be applied and the agent's default max_tokens could
// exceed what the endpoint accepts). context comes from OpenRouter's live
// /models; output is the conservative 8192 OpenRouter commonly caps free models
// at. Models the agent catalogs already know carry their own limits and are
// intentionally not listed here.
export const OPENROUTER_FREE_MODEL_LIMITS: Record<string, { context: number; output: number }> = {
  'cohere/north-mini-code:free': { context: 256000, output: 8192 },
  'dots-studio/dots-3-note-preview:free': { context: 512000, output: 8192 },
  'liquid/lfm-2.5-2.6b:free': { context: 128000, output: 8192 },
  'nvidia/nemotron-3.5-lightning:free': { context: 1000000, output: 8192 },
  'nvidia/nemotron-3.5-content-safety:free': { context: 1000000, output: 8192 },
  'nvidia/nemotron-3-ultra-550b-a55b:free': { context: 1000000, output: 8192 },
  'poolside/laguna-s-2.1:free': { context: 262144, output: 8192 },
};

export function isOpenCodeGateway(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === "opencode.ai";
  } catch {
    return false;
  }
}

export function isOpenRouter(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === "openrouter.ai";
  } catch {
    return false;
  }
}

// Headers an agent should attach to requests for this base URL so the gateway
// routes them into the official-client quota pool. opencode.ai only — OpenRouter
// does not rate-limit by UA.
export function gatewayHeadersFor(baseUrl: string): Record<string, string> | undefined {
  return isOpenCodeGateway(baseUrl) ? { "User-Agent": OPENCODE_GATEWAY_UA } : undefined;
}

// The per-model {context, output} limit OKIT knows for this model on this base
// URL, or undefined when the agent's own catalog should decide.
export function modelLimitFor(baseUrl: string, modelId: string): { context: number; output: number } | undefined {
  const limits = isOpenCodeGateway(baseUrl)
    ? OPENCODE_FREE_MODEL_LIMITS
    : isOpenRouter(baseUrl)
      ? OPENROUTER_FREE_MODEL_LIMITS
      : undefined;
  return limits?.[modelId];
}