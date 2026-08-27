import type { useI18n } from '../../i18n';

export type UsageTranslate = ReturnType<typeof useI18n>['t'];
export type UsageKind = 'subscription' | 'prepaid';
export type CloudBalanceGuide =
  | 'aliyun-billing'
  | 'baidu-billing'
  | 'tencent-billing';
export type CredentialGuide = 'volcengine' | CloudBalanceGuide;
export type CredentialGuideContext = {
  guide: CredentialGuide;
  providerId: string;
};

// Display metadata for known supported providers (icon + human-readable name).
export const PROVIDER_META: Record<
  string,
  { name: string; typeKey: string; kind: UsageKind }
> = {
  openai: {
    name: 'OpenAI API',
    typeKey: 'usage.typeApiPlatform',
    kind: 'prepaid',
  },
  'openai-codex': {
    name: 'Codex (ChatGPT)',
    typeKey: 'usage.typeAgentSubscription',
    kind: 'subscription',
  },
  anthropic: {
    name: 'Anthropic API',
    typeKey: 'usage.typeApiPlatform',
    kind: 'prepaid',
  },
  'anthropic-agent': {
    name: 'Claude Code',
    typeKey: 'usage.typeAgentSubscription',
    kind: 'subscription',
  },
  'xai-grok-build': {
    name: 'SuperGrok',
    typeKey: 'usage.typeAgentSubscription',
    kind: 'subscription',
  },
  'github-copilot': {
    name: 'GitHub Copilot',
    typeKey: 'usage.typeAgentSubscription',
    kind: 'subscription',
  },
  'glm-coding': {
    name: 'GLM Coding Plan',
    typeKey: 'usage.typeCodingPlan',
    kind: 'subscription',
  },
  'zai-global-coding': {
    name: 'Z.AI Coding Plan',
    typeKey: 'usage.typeCodingPlan',
    kind: 'subscription',
  },
  'kimi-coding-plan': {
    name: 'Kimi Coding Plan',
    typeKey: 'usage.typeCodingPlan',
    kind: 'subscription',
  },
  'minimax-coding': {
    name: 'MiniMax Token Plan',
    typeKey: 'usage.typeTokenPlan',
    kind: 'subscription',
  },
  'minimax-global-coding': {
    name: 'MiniMax Token Plan（国际）',
    typeKey: 'usage.typeTokenPlan',
    kind: 'subscription',
  },
  minimax: {
    name: 'MiniMax',
    typeKey: 'usage.typeApiPlatform',
    kind: 'prepaid',
  },
  'minimax-global': {
    name: 'MiniMax（国际站）',
    typeKey: 'usage.typeApiPlatform',
    kind: 'prepaid',
  },
  zai: {
    name: '智谱 AI（国内站）',
    typeKey: 'usage.typeApiPlatform',
    kind: 'prepaid',
  },
  'zai-global': {
    name: 'Z.AI（国际站）',
    typeKey: 'usage.typeApiPlatform',
    kind: 'prepaid',
  },
  'kimi-coding': {
    name: 'Kimi',
    typeKey: 'usage.typeApiPlatform',
    kind: 'prepaid',
  },
  'qwen-coding': {
    name: '阿里云百炼 Coding Plan',
    typeKey: 'usage.typeCodingPlan',
    kind: 'subscription',
  },
  'qwen-token-plan': {
    name: '阿里云百炼 Token Plan',
    typeKey: 'usage.typeTokenPlan',
    kind: 'subscription',
  },
  'qianfan-coding': {
    name: '百度千帆 Token Plan',
    typeKey: 'usage.typeTokenPlan',
    kind: 'subscription',
  },
  qianfan: {
    name: '百度千帆',
    typeKey: 'usage.typeApiPlatform',
    kind: 'prepaid',
  },
  'tencent-token-plan': {
    name: '腾讯云 Token Plan',
    typeKey: 'usage.typeTokenPlan',
    kind: 'subscription',
  },
  tencent: {
    name: '腾讯云',
    typeKey: 'usage.typeApiPlatform',
    kind: 'prepaid',
  },
  'opencode-go': {
    name: 'OpenCode Go',
    typeKey: 'usage.typeAgentSubscription',
    kind: 'subscription',
  },
  'volcengine-coding': {
    name: '火山引擎 Coding Plan',
    typeKey: 'usage.typeCodingPlan',
    kind: 'subscription',
  },
  'volcengine-agent': {
    name: '火山引擎 Agent Plan',
    typeKey: 'usage.typeAgentPlan',
    kind: 'subscription',
  },
  volcengine: {
    name: '火山引擎',
    typeKey: 'usage.typeApiPlatform',
    kind: 'prepaid',
  },
  'xiaomi-coding': {
    name: '小米 MiMo Token Plan',
    typeKey: 'usage.typeTokenPlan',
    kind: 'subscription',
  },
  xiaomi: {
    name: '小米 MiMo API',
    typeKey: 'usage.typeApiPlatform',
    kind: 'prepaid',
  },
  xai: { name: 'xAI API', typeKey: 'usage.typeApiPlatform', kind: 'prepaid' },
  stepfun: {
    name: '阶跃星辰',
    typeKey: 'usage.typeApiPlatform',
    kind: 'prepaid',
  },
  'stepfun-global': {
    name: 'StepFun Global',
    typeKey: 'usage.typeApiPlatform',
    kind: 'prepaid',
  },
  openrouter: {
    name: 'OpenRouter',
    typeKey: 'usage.typePrepaid',
    kind: 'prepaid',
  },
  deepseek: { name: 'DeepSeek', typeKey: 'usage.typePrepaid', kind: 'prepaid' },
  siliconflow: {
    name: '硅基流动',
    typeKey: 'usage.typePrepaid',
    kind: 'prepaid',
  },
  moonshot: { name: 'Moonshot', typeKey: 'usage.typePrepaid', kind: 'prepaid' },
  mistral: { name: 'Mistral', typeKey: 'usage.typePrepaid', kind: 'prepaid' },
  qwen: { name: '通义千问', typeKey: 'usage.typePrepaid', kind: 'prepaid' },
};

export function credentialGuideForProvider(id: string): CredentialGuide | null {
  if (
    id === 'volcengine' ||
    id === 'volcengine-coding' ||
    id === 'volcengine-agent'
  )
    return 'volcengine';
  if (id === 'qwen') return 'aliyun-billing';
  if (id === 'qianfan') return 'baidu-billing';
  if (id === 'tencent') return 'tencent-billing';
  return null;
}
