import { Provider, ProviderEndpoint, Platform } from '../../api/providers';
import providersGenerated from '../../data/providers-generated.json';
const crossData: Record<string, any[]> = {};
// Provider metadata (groups, families) — generated from src/providers/metadata.ts by scripts/gen-presets.js
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PROVIDER_GROUPS: { key: string; labelKey: string; ids: string[] }[] = (providersGenerated as any).groups;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type VariantOption = { label: string; providerId: string };
type ProviderFamily = { family: string; plans?: VariantOption[]; ids: string[] };
const PLATFORM_DEFINITIONS: Platform[] = (providersGenerated as any).platforms || [];
const PRESET_PROVIDER_IDS = new Set<string>(
  ((providersGenerated as any).presets || []).map((item: { id: string }) => item.id),
);
const PROVIDER_FAMILIES: ProviderFamily[] = PLATFORM_DEFINITIONS.map(platform => ({
  family: platform.name,
  plans: platform.offerings.map(offering => ({ label: offering.label, providerId: offering.providerId })),
  ids: platform.providerIds,
}));
const PROVIDER_OFFERING_TYPE = new Map<string, string>();
for (const platform of PLATFORM_DEFINITIONS) {
  for (const offering of platform.offerings) PROVIDER_OFFERING_TYPE.set(offering.providerId, offering.type);
}

const TYPE_OPTIONS = [
  { value: 'anthropic', label: 'anthropic' },
  { value: 'openai', label: 'openai' },
  { value: 'responses', label: 'responses' },
];
const OPENAI_PROTOCOL_OPTIONS = [
  { value: 'chat', label: 'chat' },
  { value: 'responses', label: 'responses' },
];
// 平台分组由 providers-generated.json 提供（见文件头部 import）

// 协议视角：支持的协议类型
const PROTOCOLS: { key: string; labelKey: string }[] = [
  { key: 'openai-chat', labelKey: 'models.protocolOpenaiChat' },
  { key: 'openai-responses', labelKey: 'models.protocolOpenaiResponses' },
  { key: 'anthropic', labelKey: 'models.protocolAnthropic' },
];

function providerProtocols(p: Provider): string[] {
  if (p.executionMode === 'agent_native') return [];
  const eps = p.endpoints || [{ type: p.type, baseUrl: p.baseUrl }];
  const keys = new Set<string>();
  for (const ep of eps) {
    if (ep.type === 'openai') keys.add(ep.protocol === 'responses' ? 'openai-responses' : 'openai-chat');
    else if (ep.type === 'anthropic') keys.add('anthropic');
  }
  return Array.from(keys);
}

const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI', anthropic: 'Anthropic', 'x-ai': 'xAI', mistralai: 'Mistral', 'meta-llama': 'Meta',
  qwen: 'Qwen · 阿里', deepseek: 'DeepSeek', moonshotai: 'Moonshot · 月之暗面', minimax: 'MiniMax · 稀宇科技',
  'z-ai': '智谱 Z.AI', stepfun: '阶跃星辰', tencent: '腾讯混元', baidu: '百度文心', siliconflow: '硅基流动',
  xiaomi: '小米 MiMo', meituan: '美团 LongCat', inclusionai: '阿里云', 'nex-agi': 'Nex AGI', cohere: 'Cohere',
  perplexity: 'Perplexity', amazon: 'Amazon', microsoft: 'Microsoft', nvidia: 'NVIDIA', kwaipilot: '快手 Kwai',
  bytedance: '字节 Seed', sao10k: 'Sao10K', unknown: '其他',
};

function filterModelEntries(
  entries: [string, any[]][],
  opts: { hideLegacy: boolean; activeProtocol: string | null; activeModality?: string | null; searchQuery: string; providers: Provider[]; activeProvider?: string | null; },
): [string, any[]][] {
  let result = entries;
  if (opts.hideLegacy) result = result.filter(([, models]) => !models.some((model: any) => model.legacy));
  if (opts.activeModality) result = result.filter(([, models]) => models.some((model: any) => (model.modality || 'text') === opts.activeModality));
  if (opts.activeProtocol) result = result.filter(([, models]) => models.some((model: any) => {
    const provider = opts.providers.find(item => item.id === model.platform);
    return provider && providerProtocols(provider).includes(opts.activeProtocol as string);
  }));
  if (opts.searchQuery.trim()) {
    const query = opts.searchQuery.toLowerCase();
    result = result.filter(([id]) => id.toLowerCase().includes(query));
  }
  if (opts.activeProvider) result = result.filter(([, models]) => (models[0]?.primary_provider || 'unknown') === opts.activeProvider);
  return result;
}

type ViewKey = 'platform' | 'model';

// 暂停尚未形成完整使用闭环的入口。保留实现，待数据同步与使用场景明确后恢复。
const MODEL_COMPARISON_ENABLED = false;
const PLATFORM_DETAIL_ENABLED = false;

// Provider families 由 providers-generated.json 提供数据（见文件头部 import）。
const PROVIDER_FAMILY_MAP = new Map<string, string>();
for (const f of PROVIDER_FAMILIES) for (const id of f.ids) PROVIDER_FAMILY_MAP.set(id, f.family);

function resolveFamilyProvider(fam: ProviderFamily, _region?: string, planLabel?: string): string | null {
  if (planLabel && fam.plans) {
    const plan = fam.plans.find(p => p.label === planLabel);
    if (plan) return plan.providerId;
  }
  return fam.plans?.[0]?.providerId || null;
}

function groupOf(providerId: string): { key: string; labelKey: string } {
  for (const g of PROVIDER_GROUPS) {
    if (g.ids.includes(providerId)) return { key: g.key, labelKey: g.labelKey };
  }
  return { key: 'other', labelKey: 'models.groupOther' };
}

function endpointProtocol(ep: ProviderEndpoint) {
  if (ep.type === 'responses') return 'responses';
  return ep.type === 'openai' ? (ep.protocol || 'chat') : undefined;
}

function endpointPlan(ep: ProviderEndpoint) {
  if (ep.plan === 'coding') return 'coding';
  if (ep.plan === 'token') return 'token';
  if (ep.plan === 'go') return 'go';
  return undefined;
}

function normalizeEndpoint(ep: ProviderEndpoint): ProviderEndpoint {
  if (ep.type === 'openai') return { ...ep, protocol: ep.protocol || 'chat' };
  if (ep.type === 'responses') return { ...ep, protocol: 'responses' };
  const { protocol, ...rest } = ep;
  return rest;
}

function createOpenAIEndpoint(): ProviderEndpoint {
  return { type: 'openai', protocol: 'chat', baseUrl: '' };
}

interface AuthState {
  hasApiKey: boolean;
  authVerified: boolean;
  oauthLoggedIn: boolean | null;
  authMode: string;
  authState?: string;
  authVerifiedAt?: string;
  authLastCheckedAt?: string;
  authLastError?: string;
  authEndpointStates?: Provider['authEndpointStates'];
}

function runtimeAuthReady(provider: Provider | undefined, auth: AuthState | undefined): boolean {
  if (!provider) return false;
  if (provider.authMode === 'none') return true;
  if (auth?.oauthLoggedIn === true) return true;
  return Boolean(provider.vaultKey && auth?.hasApiKey && auth.authVerified === true && auth.authState !== 'invalid');
}

type StatusFilter = 'all' | 'authed' | 'unauthed' | 'unverified' | 'attention' | 'used';
type PlanFilter = 'coding' | 'token' | 'agent' | 'subscription' | 'go' | 'api-only';

const PLAN_FILTERS: { key: PlanFilter; labelKey: string }[] = [
  { key: 'coding', labelKey: 'models.planCoding' },
  { key: 'token', labelKey: 'models.planToken' },
  { key: 'go', labelKey: 'models.planGo' },
  { key: 'subscription', labelKey: 'models.planAgentSubscription' },
  { key: 'agent', labelKey: 'models.planAgent' },
  { key: 'api-only', labelKey: 'models.planApiOnly' },
];

/**
 * Plan metadata is not persisted on older provider records yet. Keep the
 * filter useful for those records by deriving the small set of product
 * categories from stable provider ids and auth modes.
 */
function providerPlans(p: Provider): PlanFilter[] {
  const plans: PlanFilter[] = [];
  const offeringType = PROVIDER_OFFERING_TYPE.get(p.id);
  const endpointPlans = new Set((p.endpoints || []).map(endpoint => endpoint.plan).filter(Boolean));
  if (offeringType === 'coding_plan' || endpointPlans.has('coding')) plans.push('coding');
  if (offeringType === 'token_plan' || endpointPlans.has('token')) plans.push('token');
  if (offeringType === 'agent_subscription') plans.push('subscription');
  if (offeringType === 'agent_plan' || endpointPlans.has('agent')) plans.push('agent');
  if (offeringType === 'go_plan' || endpointPlans.has('go')) plans.push('go');
  if (plans.length === 0) plans.push('api-only');
  return plans;
}
export { crossData, PROVIDER_GROUPS, PLATFORM_DEFINITIONS, PRESET_PROVIDER_IDS, PROVIDER_FAMILIES, PROVIDER_OFFERING_TYPE, TYPE_OPTIONS, OPENAI_PROTOCOL_OPTIONS, PROTOCOLS, MODEL_COMPARISON_ENABLED, PLATFORM_DETAIL_ENABLED, PROVIDER_FAMILY_MAP, PROVIDER_LABELS, providerProtocols, filterModelEntries, resolveFamilyProvider, groupOf, endpointProtocol, endpointPlan, normalizeEndpoint, createOpenAIEndpoint, runtimeAuthReady, PLAN_FILTERS, providerPlans };
export type { VariantOption, ProviderFamily, ViewKey, StatusFilter, PlanFilter, AuthState };
