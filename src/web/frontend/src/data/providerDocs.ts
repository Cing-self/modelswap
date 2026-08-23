// Official setup documentation for every bundled provider offering.
//
// Documentation is keyed by provider preset id rather than platform family:
// API, Coding Plan, Token Plan and agent subscriptions often use different
// credentials, endpoints and onboarding flows even when they share a brand.

export type ProviderDocsKind =
  | 'api'
  | 'coding_plan'
  | 'token_plan'
  | 'agent_plan'
  | 'agent_subscription'
  | 'go_plan'
  | 'local';

export interface ProviderDocumentation {
  url: string;
  kind: ProviderDocsKind;
  /** Optional console surface where the credential itself is created. */
  consoleUrl?: string;
  consoleLabelKey?: string;
  setupHintKey?: string;
}

export const PROVIDER_DOCS_LAST_AUDITED_AT = '2026-08-14';

export const PROVIDER_DOCS: Record<string, ProviderDocumentation> = {
  // International official providers
  anthropic: {
    kind: 'api',
    url: 'https://platform.claude.com/docs/en/api/overview',
  },
  'anthropic-agent': {
    kind: 'agent_subscription',
    url: 'https://code.claude.com/docs/en/authentication',
  },
  openai: {
    kind: 'api',
    url: 'https://developers.openai.com/api/docs/quickstart/',
  },
  'openai-codex': {
    kind: 'agent_subscription',
    url: 'https://developers.openai.com/codex/auth/',
  },
  xai: {
    kind: 'api',
    url: 'https://docs.x.ai/overview',
  },
  'xai-grok-build': {
    kind: 'agent_subscription',
    url: 'https://docs.x.ai/build/overview',
  },
  'github-copilot': {
    kind: 'agent_subscription',
    url: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli',
  },
  mistral: {
    kind: 'api',
    url: 'https://docs.mistral.ai/getting-started/quickstarts/developer/first-api-request',
  },

  // China and regional providers
  zai: {
    kind: 'api',
    url: 'https://docs.bigmodel.cn/cn/api/introduction',
  },
  'zai-global': {
    kind: 'api',
    url: 'https://docs.z.ai/api-reference/introduction',
  },
  'glm-coding': {
    kind: 'coding_plan',
    url: 'https://docs.bigmodel.cn/cn/coding-plan/quick-start',
  },
  'zai-global-coding': {
    kind: 'coding_plan',
    url: 'https://docs.z.ai/devpack/quick-start',
  },
  minimax: {
    kind: 'api',
    url: 'https://platform.minimaxi.com/docs/api-reference/api-overview',
  },
  'minimax-global': {
    kind: 'api',
    url: 'https://platform.minimax.io/docs/api-reference/api-overview',
  },
  'minimax-coding': {
    kind: 'token_plan',
    url: 'https://platform.minimaxi.com/docs/token-plan/quickstart',
  },
  'minimax-global-coding': {
    kind: 'token_plan',
    url: 'https://platform.minimax.io/docs/token-plan/quickstart',
  },
  moonshot: {
    kind: 'api',
    url: 'https://platform.kimi.ai/docs/overview',
  },
  'kimi-coding': {
    kind: 'api',
    url: 'https://platform.kimi.com/docs/api/overview',
  },
  'kimi-coding-plan': {
    kind: 'coding_plan',
    url: 'https://www.kimi.com/code/docs/en/',
  },
  deepseek: {
    kind: 'api',
    url: 'https://api-docs.deepseek.com/',
  },
  qwen: {
    kind: 'api',
    url: 'https://help.aliyun.com/zh/model-studio/first-api-call-to-qwen',
  },
  'qwen-coding': {
    kind: 'coding_plan',
    url: 'https://help.aliyun.com/zh/model-studio/coding-plan',
  },
  'qwen-token-plan': {
    kind: 'token_plan',
    url: 'https://help.aliyun.com/zh/model-studio/token-plan-personal-quick-start',
  },
  qianfan: {
    kind: 'api',
    url: 'https://cloud.baidu.com/doc/qianfan-docs/s/qm8qxemze',
  },
  'qianfan-coding': {
    kind: 'token_plan',
    url: 'https://cloud.baidu.com/doc/qianfan/s/Smoghsq3g',
  },
  tencent: {
    kind: 'api',
    url: 'https://cloud.tencent.com/document/product/1823/130079',
  },
  'tencent-token-plan': {
    kind: 'token_plan',
    url: 'https://cloud.tencent.com/document/product/1823/130660',
    consoleUrl: 'https://console.cloud.tencent.com/tokenhub/tokenplan',
    consoleLabelKey: 'models.providerConsoleTokenPlan',
    setupHintKey: 'models.tencentTokenPlanSetupHint',
  },
  volcengine: {
    kind: 'api',
    url: 'https://docs.volcengine.com/docs/82379/1494384?lang=zh',
  },
  'volcengine-coding': {
    kind: 'coding_plan',
    url: 'https://docs.volcengine.com/docs/82379/1928261?lang=zh',
  },
  'volcengine-agent': {
    kind: 'agent_plan',
    url: 'https://docs.volcengine.com/docs/82379/2373738?lang=zh',
  },
  siliconflow: {
    kind: 'api',
    url: 'https://docs.siliconflow.cn/cn/userguide/introduction',
  },
  stepfun: {
    kind: 'api',
    url: 'https://platform.stepfun.com/docs/zh/quickstart/overview',
  },
  'stepfun-global': {
    kind: 'api',
    url: 'https://platform.stepfun.ai/docs/en/quickstart/overview',
  },
  xiaomi: {
    kind: 'api',
    url: 'https://mimo.mi.com/docs/',
  },
  'xiaomi-coding': {
    kind: 'token_plan',
    url: 'https://mimo.mi.com/docs/zh-CN/tokenplan/integration/codex-configuration',
  },

  // Aggregators and local runtimes
  openrouter: {
    kind: 'api',
    url: 'https://openrouter.ai/docs/quickstart',
  },
  'opencode-go': {
    kind: 'go_plan',
    url: 'https://opencode.ai/docs/go/',
  },
  'opencode-zen': {
    kind: 'api',
    url: 'https://opencode.ai/docs/zen',
  },
  ollama: {
    kind: 'local',
    url: 'https://docs.ollama.com/api/introduction',
  },
  litellm: {
    kind: 'local',
    url: 'https://docs.litellm.ai/docs/proxy/quick_start',
  },
};

export function getProviderDocs(providerId: string): ProviderDocumentation | null {
  return PROVIDER_DOCS[providerId] || null;
}
