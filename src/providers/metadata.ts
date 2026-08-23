// Provider metadata: groups, families, and migration constants.
//
// This is the single source of truth for provider *relationships* (grouping,
// family merging) and *data migrations* (retired IDs, URL corrections).
// It complements presets.ts (which defines the providers themselves).
//
// The codegen script (scripts/gen-presets.js) reads this file (after tsc
// compilation) and emits a JSON consumed by the frontend, so the frontend
// no longer needs its own copy of these definitions.

// ── Retired presets ──────────────────────────────────────────
// These used to be bundled presets. Retire them on load so existing OKIT
// installations match the current UI.
export const RETIRED_PRESET_PROVIDER_IDS = new Set([
  "google",
  "google-agent",
  "groq",
  "fireworks",
  "together",
  "moonshot-coding-plan",
  "tencent-lke",
  "tencent-tokenhub",
  "tencent-coding",
]);

// ── URL migrations ───────────────────────────────────────────
// Apply only these exact built-in endpoint corrections. User-customized URLs
// are intentionally left untouched when presets are refreshed.
export const PRESET_BASE_URL_MIGRATIONS = new Map<string, { from: string; to: string }>([
  ["kimi-coding", { from: "https://api.kimi.com", to: "https://api.moonshot.cn/v1" }],
  ["qianfan-coding", { from: "https://qianfan.baidubce.com/v2/coding", to: "https://qianfan.baidubce.com/v2/tokenplan/personal" }],
  ["xiaomi-coding", { from: "https://token-plan-cn.xiaomimimo.com/v1", to: "https://token-plan-sgp.xiaomimimo.com/v1" }],
  ["qwen-coding", { from: "https://coding.dashscope.aliyuncs.com/compatible-mode/v1", to: "https://coding.dashscope.aliyuncs.com/v1" }],
  ["tencent", { from: "https://api.lkeap.cloud.tencent.com/v1", to: "https://tokenhub.tencentmaas.com/v1" }],
  ["tencent-token-plan", { from: "https://api.lkeap.cloud.tencent.com/v1", to: "https://api.lkeap.cloud.tencent.com/plan/v3" }],
]);

type EndpointBaseUrlMigration = {
  type?: import("./types").ProviderType;
  from: string;
  to: string;
};

export const PRESET_ENDPOINT_BASE_URL_MIGRATIONS = new Map<string, EndpointBaseUrlMigration[]>([
  ["opencode-zen", [
    // The anthropic endpoint base must NOT carry /v1 — the handler appends
    // /v1/messages and /v1/models itself (with /v1 it doubled up and 404'd).
    { type: "anthropic", from: "https://opencode.ai/zen/v1", to: "https://opencode.ai/zen" },
  ]],
  ["kimi-coding-plan", [
    { from: "https://api.kimi.com/coding/", to: "https://api.kimi.com/coding" },
  ]],
  ["xiaomi-coding", [
    { type: "anthropic", from: "https://token-plan-cn.xiaomimimo.com/anthropic", to: "https://token-plan-sgp.xiaomimimo.com/anthropic" },
  ]],
  ["qwen", [
    { type: "anthropic", from: "https://dashscope.aliyuncs.com/compatible-mode/v1", to: "https://dashscope.aliyuncs.com/apps/anthropic" },
  ]],
  ["qwen-coding", [
    { type: "anthropic", from: "https://coding.dashscope.aliyuncs.com/compatible-mode/v1", to: "https://coding.dashscope.aliyuncs.com/apps/anthropic" },
  ]],
  ["tencent-token-plan", [
    { type: "anthropic", from: "https://api.lkeap.cloud.tencent.com/api/anthropic", to: "https://api.lkeap.cloud.tencent.com/plan/anthropic" },
  ]],
  ["tencent", [
    { type: "anthropic", from: "https://api.lkeap.cloud.tencent.com/api/anthropic", to: "https://tokenhub.tencentmaas.com" },
  ]],
]);

export const PRESET_AUTH_MODE_MIGRATIONS = new Map<string, { from: string; to: string }>([
  ["anthropic", { from: "both", to: "api_key" }],
  ["openai", { from: "both", to: "api_key" }],
]);

// Exact model lists shipped by older builds. Replace only when the persisted
// list still matches one of these snapshots, so user-curated or remotely
// discovered model catalogs are never overwritten.
export const PRESET_MODEL_ID_MIGRATIONS = new Map<string, string[][]>([
  ["qwen-coding", [["qwen3-coder-plus", "glm-5", "kimi-k2.5", "deepseek-v3.2"]]],
  ["qwen-token-plan", [["qwen3.8-max", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3-coder-plus"]]],
  ["tencent-token-plan", [["deepseek-v4-flash", "deepseek-v4-pro", "minimax-m2.7", "minimax-m2.5", "glm-5.1", "glm-5", "kimi-k2.5", "hy3"]]],
]);

// ── Provider groups (left-nav in models page) ────────────────
export const PROVIDER_GROUPS: { key: string; labelKey: string; ids: string[] }[] = [
  { key: "official", labelKey: "models.groupOfficial", ids: ["anthropic", "anthropic-agent", "openai", "openai-codex", "xai", "xai-grok-build", "github-copilot", "mistral"] },
  { key: "aggregator", labelKey: "models.groupAggregator", ids: ["openrouter", "opencode-go", "opencode-zen"] },
  { key: "china", labelKey: "models.groupChina", ids: [
    // 智谱
    "zai", "zai-global", "glm-coding", "zai-global-coding",
    // MiniMax
    "minimax", "minimax-global", "minimax-coding", "minimax-global-coding",
    // Kimi / Moonshot
    "moonshot", "moonshot-coding-plan", "kimi-coding", "kimi-coding-plan",
    // 火山引擎
    "volcengine", "volcengine-coding", "volcengine-agent",
    // 百度千帆
    "qianfan", "qianfan-coding",
    // 阿里云百炼 / 硅基流动
    "qwen", "qwen-coding", "qwen-token-plan", "siliconflow",
    // DeepSeek
    "deepseek",
    // 阶跃星辰
    "stepfun", "stepfun-global",
    // 小米
    "xiaomi", "xiaomi-coding",
    // 腾讯云
    "tencent", "tencent-token-plan",
  ] },
  { key: "local", labelKey: "models.groupLocal", ids: ["ollama", "litellm"] },
];

// ── Provider families (merge same-site variants into one card) ─
// 国内站和国际站是不同站点、不同 key,不合并。
// 只有同一站点内的不同套餐(API 平台 / Coding Plan / Token Plan)才合并。
export type VariantOption = {
  label: string;
  providerId: string;
  type?: import("./types").OfferingType;
  entitlement?: import("./types").PlatformOffering["entitlement"];
};
export type ProviderFamily = {
  family: string;
  plans?: VariantOption[];
  ids: string[];
};

export const PROVIDER_FAMILIES: ProviderFamily[] = [
  {
    family: "Anthropic",
    plans: [
      { label: "API 平台", providerId: "anthropic" },
      { label: "Agent 订阅", providerId: "anthropic-agent", type: "agent_subscription", entitlement: { type: "subscription_included", product: "Claude Pro / Max" } },
    ],
    ids: ["anthropic", "anthropic-agent"],
  },
  {
    family: "阿里云百炼",
    plans: [
      { label: "API 平台", providerId: "qwen" },
      { label: "Coding Plan", providerId: "qwen-coding" },
      { label: "Token Plan", providerId: "qwen-token-plan" },
    ],
    ids: ["qwen", "qwen-coding", "qwen-token-plan"],
  },
  {
    family: "OpenAI",
    plans: [
      { label: "API Key", providerId: "openai" },
      { label: "Agent 订阅", providerId: "openai-codex", type: "agent_subscription", entitlement: { type: "subscription_included", product: "ChatGPT" } },
    ],
    ids: ["openai", "openai-codex"],
  },
  {
    family: "OpenCode Go",
    plans: [
      { label: "Go 套餐", providerId: "opencode-go", type: "go_plan", entitlement: { type: "subscription_included", product: "OpenCode Go" } },
    ],
    ids: ["opencode-go"],
  },
  {
    family: "xAI",
    plans: [
      { label: "API Key", providerId: "xai" },
      { label: "Agent 订阅", providerId: "xai-grok-build", type: "agent_subscription", entitlement: { type: "subscription_included", product: "Grok / X" } },
    ],
    ids: ["xai", "xai-grok-build"],
  },
  {
    family: "GitHub Copilot",
    plans: [
      { label: "Agent 订阅", providerId: "github-copilot", type: "agent_subscription", entitlement: { type: "subscription_included", product: "GitHub Copilot" } },
    ],
    ids: ["github-copilot"],
  },
  {
    family: "智谱AI（国内）",
    plans: [
      { label: "API 平台", providerId: "zai" },
      { label: "Coding Plan", providerId: "glm-coding" },
    ],
    ids: ["zai", "glm-coding"],
  },
  {
    family: "Z.AI（国际）",
    plans: [
      { label: "API 平台", providerId: "zai-global" },
      { label: "Coding Plan", providerId: "zai-global-coding" },
    ],
    ids: ["zai-global", "zai-global-coding"],
  },
  {
    family: "MiniMax（国内）",
    plans: [
      { label: "API 平台", providerId: "minimax" },
      { label: "Token Plan", providerId: "minimax-coding" },
    ],
    ids: ["minimax", "minimax-coding"],
  },
  {
    family: "MiniMax（国际）",
    plans: [
      { label: "API 平台", providerId: "minimax-global" },
      { label: "Token Plan", providerId: "minimax-global-coding" },
    ],
    ids: ["minimax-global", "minimax-global-coding"],
  },
  {
    family: "Moonshot",
    plans: [
      { label: "API 平台", providerId: "moonshot" },
    ],
    ids: ["moonshot"],
  },
  {
    family: "Kimi",
    plans: [
      { label: "国内 API 平台", providerId: "kimi-coding" },
      { label: "Coding Plan", providerId: "kimi-coding-plan" },
    ],
    ids: ["kimi-coding", "kimi-coding-plan"],
  },
  {
    family: "火山引擎",
    plans: [
      { label: "API 平台", providerId: "volcengine" },
      { label: "Coding Plan", providerId: "volcengine-coding" },
      { label: "Agent Plan", providerId: "volcengine-agent" },
    ],
    ids: ["volcengine", "volcengine-coding", "volcengine-agent"],
  },
  {
    family: "腾讯云",
    plans: [
      { label: "API 平台", providerId: "tencent" },
      { label: "Token Plan", providerId: "tencent-token-plan" },
    ],
    ids: ["tencent", "tencent-token-plan"],
  },
  {
    family: "百度千帆",
    plans: [
      { label: "API 平台", providerId: "qianfan" },
      { label: "Token Plan", providerId: "qianfan-coding" },
    ],
    ids: ["qianfan", "qianfan-coding"],
  },
  {
    family: "小米 MiMo",
    plans: [
      { label: "API 平台", providerId: "xiaomi" },
      { label: "Token Plan", providerId: "xiaomi-coding" },
    ],
    ids: ["xiaomi", "xiaomi-coding"],
  },
];
