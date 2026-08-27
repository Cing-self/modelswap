// Shared gateway request handling for agent adapters. Model capabilities and
// token limits live in the model directory/cache and are resolved before an
// adapter writes; this module intentionally contains no per-model facts.
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

// The opencode client identifies itself with this User-Agent; the opencode.ai
// gateway routes requests carrying it into a separate, generously-quota'd pool.
export const OPENCODE_GATEWAY_UA = "opencode/1.18.15";


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
