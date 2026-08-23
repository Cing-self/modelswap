// Endpoint profiles for provider routes that cannot be tested with one global
// model. Centralises probe-model selection and known model fallbacks so that
// connection tests (vault.testApiKey) and model discovery
// (providers.fetchModels) stay in sync.
//
// Each profile maps a baseUrl pattern to:
//   - probeModel: the model name to send in a 1-token chat/completions probe
//     when /models is unavailable. Must be a model the plan accepts.
//   - models: known model list to fall back to after a successful probe.
//   - verifyInference: optionally require a real minimal inference probe even
//     when /models succeeds, because a list call does not prove billing access.
//
// Qianfan Coding is still handled by qianfan-coding.js (it has richer error
// messages); this module covers the remaining Coding Plan providers that were
// previously falling through to the generic gpt-4o-mini probe and failing.

const PROFILES = [
  {
    id: 'anthropic-official',
    // Official Anthropic API. Without a profile the generic gpt-4o-mini
    // probe is sent to /v1/messages and 404s on every key ("model not
    // found"), wrongly marking valid keys as invalid.
    match: /^https?:\/\/api\.anthropic\.com\/?(?:v1)?\/?$/i,
    probeModel: 'claude-haiku-4-5',
  },
  {
    id: 'opencode-go-anthropic',
    // OpenCode Go Anthropic wire API uses /v1/messages and only accepts the
    // models documented for that protocol. Grok is OpenAI-compatible only.
    match: /^https?:\/\/opencode\.ai\/zen\/go\/?$/i,
    probeModel: 'minimax-m3',
    models: [
      { id: 'minimax-m3', name: 'MiniMax M3' },
      { id: 'minimax-m2.7', name: 'MiniMax M2.7' },
      { id: 'minimax-m2.5', name: 'MiniMax M2.5' },
      { id: 'qwen3.7-max', name: 'Qwen3.7 Max' },
      { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus' },
      { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus' },
    ],
  },
  {
    id: 'opencode-go-openai',
    // OpenCode-compatible /v1 endpoint. Grok is available on chat/completions.
    match: /^https?:\/\/opencode\.ai\/zen\/go\/v1\/?$/i,
    probeModel: 'grok-4.5',
    models: [
      { id: 'grok-4.5', name: 'Grok 4.5' },
      { id: 'glm-5.2', name: 'GLM-5.2' },
      { id: 'glm-5.1', name: 'GLM-5.1' },
      { id: 'kimi-k3', name: 'Kimi K3' },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code' },
      { id: 'kimi-k2.6', name: 'Kimi K2.6' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'mimo-v2.5', name: 'MiMo V2.5' },
      { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro' },
    ],
  },
  {
    id: 'zai-global-coding',
    // Z.AI international GLM Coding Plan.
    match: /^https?:\/\/api\.z\.ai\/api\/coding\//i,
    probeModel: 'glm-5.1',
    models: [
      { id: 'glm-5.1', name: 'GLM-5.1' },
      { id: 'glm-5', name: 'GLM-5' },
      { id: 'glm-4.7', name: 'GLM-4.7' },
    ],
  },
  {
    id: 'zai-global-anthropic',
    // The Coding Plan and pay-as-you-go offering share this Anthropic route.
    // Both require a GLM model and Bearer authentication.
    match: /^https?:\/\/api\.z\.ai\/api\/anthropic\/?$/i,
    probeModel: 'glm-4.7',
    anthropicAuth: 'bearer',
    models: [
      { id: 'glm-5.1', name: 'GLM-5.1' },
      { id: 'glm-5', name: 'GLM-5' },
      { id: 'glm-4.7', name: 'GLM-4.7' },
    ],
  },
  {
    id: 'glm-coding',
    // GLM Coding Plan — open.bigmodel.cn/api/coding/...
    match: /^https?:\/\/open\.bigmodel\.cn\/api\/coding\//i,
    probeModel: 'glm-4.7',
    models: [
      { id: 'glm-5.2', name: 'GLM-5.2' },
      { id: 'glm-5-turbo', name: 'GLM-5 Turbo' },
      { id: 'glm-4.7', name: 'GLM-4.7' },
    ],
  },
  {
    id: 'glm-anthropic',
    // GLM's Anthropic-compatible endpoint is shared by API and Coding Plan.
    match: /^https?:\/\/open\.bigmodel\.cn\/api\/anthropic\/?$/i,
    probeModel: 'glm-4.7',
    anthropicAuth: 'bearer',
    models: [
      { id: 'glm-5.2', name: 'GLM-5.2' },
      { id: 'glm-5-turbo', name: 'GLM-5 Turbo' },
      { id: 'glm-4.7', name: 'GLM-4.7' },
    ],
  },
  {
    id: 'minimax-coding',
    // MiniMax Token Plan — mainland China and international endpoints.
    match: /^https?:\/\/api\.minimax(?:i\.com|\.io)\/(?:v1|anthropic)/i,
    probeModel: 'MiniMax-M2.7',
    models: [
      { id: 'MiniMax-M3', name: 'MiniMax M3' },
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7' },
      { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed' },
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5' },
    ],
  },
  {
    id: 'moonshot-anthropic',
    // Moonshot's Anthropic-compatible endpoint does not accept the generic
    // OpenAI probe model. Use a Kimi model that is supported by this route.
    match: /^https?:\/\/api\.moonshot\.(?:cn|ai)\/anthropic\/?$/i,
    probeModel: 'kimi-k2.5',
    models: [
      { id: 'kimi-k2.5', name: 'Kimi K2.5' },
      { id: 'kimi-k2.6', name: 'Kimi K2.6' },
      { id: 'moonshot-v1-128k', name: 'Moonshot V1 128K' },
      { id: 'moonshot-v1-32k', name: 'Moonshot V1 32K' },
      { id: 'moonshot-v1-8k', name: 'Moonshot V1 8K' },
    ],
  },
  {
    id: 'qwen-coding',
    // Alibaba Model Studio Coding Plan. ANTHROPIC_AUTH_TOKEN maps to a
    // Bearer header; the same exact model IDs are accepted by both wires.
    match: /^https?:\/\/coding(?:-intl)?\.dashscope\.aliyuncs\.com\/(?:v1|apps\/anthropic)\/?$/i,
    probeModel: 'qwen3.7-plus',
    anthropicAuth: 'bearer',
    models: [
      { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus' },
      { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus' },
      { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus' },
      { id: 'kimi-k2.5', name: 'Kimi K2.5' },
      { id: 'glm-5', name: 'GLM-5' },
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5' },
      { id: 'qwen3-max-2026-01-23', name: 'Qwen3 Max' },
      { id: 'qwen3-coder-next', name: 'Qwen3 Coder Next' },
      { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus' },
      { id: 'glm-4.7', name: 'GLM-4.7' },
    ],
  },
  {
    id: 'qwen-token-plan',
    // Alibaba Model Studio Token Plan (personal/team). qwen3.7-plus is
    // available across the current plans and avoids preview-only probes.
    match: /^https?:\/\/token-plan\.cn-beijing\.maas\.aliyuncs\.com\/(?:compatible-mode\/v1|apps\/anthropic)\/?$/i,
    probeModel: 'qwen3.7-plus',
    anthropicAuth: 'bearer',
    models: [
      { id: 'qwen3.8-max-preview', name: 'Qwen3.8 Max Preview' },
      { id: 'qwen3.7-max', name: 'Qwen3.7 Max' },
      { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus' },
      { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus' },
      { id: 'qwen3.6-flash', name: 'Qwen3.6 Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'deepseek-v3.2', name: 'DeepSeek V3.2' },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code' },
      { id: 'kimi-k2.6', name: 'Kimi K2.6' },
      { id: 'kimi-k2.5', name: 'Kimi K2.5' },
      { id: 'glm-5.2', name: 'GLM-5.2' },
      { id: 'glm-5.1', name: 'GLM-5.1' },
      { id: 'glm-5', name: 'GLM-5' },
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5' },
    ],
  },
  {
    id: 'qianfan-openai',
    // Qianfan's /models route can succeed while billable inference is blocked
    // (for example, account_overdue). Verify the OpenAI-compatible route with
    // a Qianfan model instead of treating the list call as end-to-end success.
    match: /^https?:\/\/qianfan\.baidubce\.com\/v2\/?$/i,
    probeModel: 'deepseek-v3.2',
    verifyInference: true,
    models: [
      { id: 'deepseek-v3.2', name: 'DeepSeek V3.2' },
      { id: 'ernie-4.5-turbo-20260402', name: 'ERNIE 4.5 Turbo' },
    ],
  },
  {
    id: 'qianfan-anthropic',
    // The Anthropic-compatible route is a protocol adapter over Qianfan's
    // model catalog. gpt-4o-mini returns 401 invalid_model here, so use a
    // model explicitly supported by Qianfan.
    match: /^https?:\/\/qianfan\.baidubce\.com\/anthropic\/?$/i,
    probeModel: 'deepseek-v3.2',
    verifyInference: true,
    models: [
      { id: 'deepseek-v3.2', name: 'DeepSeek V3.2' },
      { id: 'ernie-4.5-turbo-20260402', name: 'ERNIE 4.5 Turbo' },
    ],
  },
  {
    id: 'qianfan-token-plan',
    // Qianfan has richer provider-specific error handling, but still needs a
    // profile so every bundled plan endpoint is covered by the same audit.
    match: /^https?:\/\/qianfan\.baidubce\.com\/(?:v2\/tokenplan\/personal|anthropic\/tokenplan\/personal)\/?$/i,
    probeModel: 'qianfan-code-latest',
    models: [
      { id: 'qianfan-code-latest', name: 'Qianfan Code' },
      { id: 'kimi-k2.5', name: 'Kimi K2.5' },
      { id: 'deepseek-v3.2', name: 'DeepSeek V3.2' },
      { id: 'glm-5', name: 'GLM-5' },
      { id: 'minimax-m2.5', name: 'MiniMax M2.5' },
    ],
  },
  {
    id: 'volcengine-coding',
    // 火山引擎 Coding Plan — ark.cn-beijing.volces.com/api/coding/...
    match: /^https?:\/\/ark\.cn-beijing\.volces\.com\/api\/coding(?:\/|$)/i,
    probeModel: 'doubao-seed-code-preview-251028',
    anthropicAuth: 'bearer',
    models: [
      { id: 'doubao-seed-code-preview-251028', name: 'Doubao Seed Code' },
      { id: 'doubao-seed-2.0-pro', name: 'Doubao Seed 2.0 Pro' },
      { id: 'kimi-k2.5', name: 'Kimi K2.5' },
      { id: 'deepseek-v3.2', name: 'DeepSeek V3.2' },
      { id: 'glm-5', name: 'GLM-5' },
    ],
  },
  {
    id: 'volcengine-agent',
    // 火山引擎 Agent Plan uses a separate /api/plan endpoint family.
    match: /^https?:\/\/ark\.cn-beijing\.volces\.com\/api\/plan(?:\/|$)/i,
    probeModel: 'doubao-seed-2.0-pro',
    anthropicAuth: 'bearer',
    models: [
      { id: 'doubao-seed-2.0-pro', name: 'Doubao Seed 2.0 Pro' },
      { id: 'doubao-seed-evolving', name: 'Doubao Seed Evolving' },
    ],
  },
  {
    id: 'tencent-coding',
    // 腾讯云 Coding Plan — api.lkeap.cloud.tencent.com/coding/...
    match: /^https?:\/\/api\.lkeap\.cloud\.tencent\.com\/coding\//i,
    probeModel: 'tc-code-latest',
    models: [
      { id: 'tc-code-latest', name: 'Tencent Code' },
      { id: 'kimi-k2.5', name: 'Kimi K2.5' },
      { id: 'glm-5', name: 'GLM-5' },
      { id: 'minimax-m2.5', name: 'MiniMax M2.5' },
    ],
  },
  {
    id: 'tencent-token-plan',
    // Current TokenHub Token Plan URLs use /plan, not the legacy /coding
    // family. tc-code-latest is the documented Auto routing model.
    match: /^https?:\/\/api\.lkeap\.cloud\.tencent\.com\/plan\/(?:v3|anthropic)\/?$/i,
    probeModel: 'tc-code-latest',
    probeModels: ['tc-code-latest', 'hy3'],
    models: [
      { id: 'tc-code-latest', name: 'Auto' },
      { id: 'deepseek-v4-flash-202605', name: 'DeepSeek V4 Flash' },
      { id: 'deepseek-v4-pro-202606', name: 'DeepSeek V4 Pro' },
      { id: 'minimax-m2.7', name: 'MiniMax M2.7' },
      { id: 'glm-5.1', name: 'GLM-5.1' },
      { id: 'glm-5', name: 'GLM-5' },
      { id: 'hy3', name: 'Hy3' },
      { id: 'hy3-preview', name: 'Hy3 Preview' },
    ],
  },
  {
    id: 'kimi-coding-plan',
    // Kimi Coding Plan — api.kimi.com/coding/...
    match: /^https?:\/\/api\.kimi\.com\/coding(?:\/|$)/i,
    probeModel: 'kimi-for-coding',
    models: [
      { id: 'k3', name: 'Kimi K3' },
      { id: 'k3-256k', name: 'Kimi K3 256K' },
      { id: 'kimi-for-coding', name: 'Kimi for Coding' },
      { id: 'kimi-for-coding-highspeed', name: 'Kimi for Coding Highspeed' },
    ],
  },
  {
    id: 'xiaomi-coding',
    // 小米 MiMo Token Plan — token-plan-*.xiaomimimo.com
    match: /^https?:\/\/token-plan-[^/]*\.xiaomimimo\.com\//i,
    probeModel: 'mimo-v2.5',
    models: [
      { id: 'mimo-v2.5', name: 'MiMo V2.5' },
      { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro' },
    ],
  },
];

// Default probe model for endpoints without a provider-specific profile.
const DEFAULT_PROBE_MODEL = 'gpt-4o-mini';

/**
 * Returns the endpoint profile matching the given baseUrl, or null if no
 * Coding Plan pattern matches.
 */
function getEndpointProfile(baseUrl) {
  const url = String(baseUrl || '').trim();
  return PROFILES.find(p => p.match.test(url)) || null;
}

/**
 * Picks the correct probe model for a given endpoint. Some plan and standard
 * endpoints reject the generic gpt-4o-mini model, so profiles select one that
 * the offering actually supports.
 */
function pickProbeModel(baseUrl) {
  const profile = getEndpointProfile(baseUrl);
  return profile ? profile.probeModel : DEFAULT_PROBE_MODEL;
}

/**
 * Some products expose multiple mutually exclusive plan tiers behind one
 * endpoint. Return candidates in priority order so callers can retry only
 * when the response clearly says the selected model is unavailable.
 */
function getProbeModels(baseUrl) {
  const profile = getEndpointProfile(baseUrl);
  if (!profile) return [DEFAULT_PROBE_MODEL];
  return Array.isArray(profile.probeModels) && profile.probeModels.length
    ? profile.probeModels.slice()
    : [profile.probeModel];
}

/**
 * Anthropic-compatible gateways use either the standard x-api-key header or
 * Claude Code's ANTHROPIC_AUTH_TOKEN (Authorization: Bearer). Profiles record
 * the exceptions explicitly instead of guessing from the provider name.
 */
function getAnthropicAuthMode(baseUrl) {
  return getEndpointProfile(baseUrl)?.anthropicAuth || 'x-api-key';
}

function requiresInferenceProbe(baseUrl) {
  return getEndpointProfile(baseUrl)?.verifyInference === true;
}

function isModelAccessFailure(status, body) {
  if (status !== 401 && status !== 403 && status !== 404) return false;
  const message = String(body || '');
  return /invalid_model|model[_\s-]*(?:not[_\s-]*supported|not[_\s-]*found)|not found the model|the model does not exist|current model does not support|model[^\n]{0,80}permission denied|permission denied[^\n]{0,80}model|模型[^\n]{0,40}(?:不支持|不存在|无权限)/i.test(message);
}

/**
 * Errors that can only be returned after the credential has been accepted.
 * They should block inference, but must not make the UI claim that the key is
 * invalid. Keep this deliberately limited to explicit billing/quota codes.
 */
function getAuthenticatedResourceFailureMessage(status, body) {
  if (status !== 402 && status !== 403 && status !== 429) return null;
  const message = String(body || '');
  if (/account[_\s-]*overdue|past[_\s-]*due|欠费/i.test(message)) {
    return '连接成功，Key 有效；当前账户欠费，暂时无法调用模型';
  }
  if (/insufficient[_\s-]*(?:quota|balance|credit)|quota[_\s-]*exceeded|余额不足|额度(?:不足|已用尽)/i.test(message)) {
    return '连接成功，Key 有效；当前账户余额或额度不足，暂时无法调用模型';
  }
  if (/rate[_\s-]*limit(?:ed|_exceeded)?|too many requests|请求(?:过于)?频繁/i.test(message)) {
    return '连接成功，Key 有效；当前请求频率受限，请稍后重试';
  }
  return null;
}

/**
 * Returns the known model fallback list for a Coding Plan endpoint, or null
 * if the endpoint is not a recognised Coding Plan.
 */
function getFallbackModels(baseUrl) {
  const profile = getEndpointProfile(baseUrl);
  return profile ? profile.models.slice() : null;
}

module.exports = {
  PROFILES,
  DEFAULT_PROBE_MODEL,
  getEndpointProfile,
  pickProbeModel,
  getProbeModels,
  getAnthropicAuthMode,
  requiresInferenceProbe,
  isModelAccessFailure,
  getAuthenticatedResourceFailureMessage,
  getFallbackModels,
};
