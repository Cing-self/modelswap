import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { listProviders, deleteProvider, createProvider, updateProvider, getAuthStatus, verifyProviderAuth, triggerOAuthLogin, fetchModels, Provider, ProviderModel, ProviderEndpoint, Platform } from '../../api/providers';
import { useApp } from '../Layout/AppContext';
import { useI18n } from '../../i18n';
import VaultPickerModal from '../shared/VaultPickerModal';
import CustomSelect from '../shared/CustomSelect';
import { getProviderIcon, getProviderIconClass } from '../../assets/providers';
import { getProviderDocs, ProviderDocsKind } from '../../data/providerDocs';
import crossDataRaw from '../../data/cross_platform_models.json';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const crossData: Record<string, any[]> = crossDataRaw as any;
// Provider metadata (groups, families) — generated from src/providers/metadata.ts by scripts/gen-presets.js
import providersGenerated from '../../data/providers-generated.json';
import { api } from '../../api/client';
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

export default function ModelsPage() {
  const { showToast: toast, confirm } = useApp() as any;
  const { t, providerName } = useI18n();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>(PLATFORM_DEFINITIONS);
  const [authMap, setAuthMap] = useState<Record<string, AuthState>>({});
  // Badges stay neutral until the first auth snapshot lands, so cards never
  // flash 待配置 for providers that are actually configured.
  const [authLoaded, setAuthLoaded] = useState(false);
  const [authLoadFailed, setAuthLoadFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editProvider, setEditProvider] = useState<Provider | null>(null);
  const [view, setView] = useState<ViewKey>('platform');
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [activeProtocol, setActiveProtocol] = useState<string | null>(null);
  const [activePlanFilter, setActivePlanFilter] = useState<PlanFilter | null>(null);
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [activeModelProvider, setActiveModelProvider] = useState<string | null>(null);
  const [activeModality, setActiveModality] = useState<string | null>(null);
  const [hideLegacy, setHideLegacy] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  // 平台视角：当前查看详情的平台（点击平台卡片进入）
  const [activePlatform, setActivePlatform] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState<string | null>(null);
  const [testingConn, setTestingConn] = useState<string | null>(null);
  const [endpointResults, setEndpointResults] = useState<Record<string, { success: boolean; message: string }[]>>({});
  const [syncingModels, setSyncingModels] = useState<string | null>(null);
  const [actionMenuId, setActionMenuId] = useState<string | null>(null);
  const [cardAuthMethod, setCardAuthMethod] = useState<Record<string, 'api_key' | 'oauth'>>({});

  const load = useCallback(async () => {
    try {
      const data = await listProviders();
      setProviders(data.providers || []);
      setPlatforms(data.platforms || PLATFORM_DEFINITIONS);
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setLoading(false);
    }
    // Auth badges are secondary decoration — fetch them after the cards are
    // already on screen and let them pop in, instead of blocking first paint.
    try {
      setAuthLoadFailed(false);
      const authData = await getAuthStatus();
      const map: Record<string, AuthState> = {};
      for (const s of authData.statuses || []) {
        map[s.id] = {
          hasApiKey: s.hasApiKey,
          authVerified: s.authVerified === true,
          oauthLoggedIn: s.oauthLoggedIn,
          authMode: s.authMode,
          authState: s.authState,
          authVerifiedAt: s.authVerifiedAt,
          authLastCheckedAt: s.authLastCheckedAt,
          authLastError: s.authLastError,
          authEndpointStates: s.authEndpointStates,
        };
      }
      setAuthMap(map);
      setAuthLoaded(true);
    } catch {
      // Authentication is a separate, fallible data source. Keep its state
      // unknown instead of turning a failed request into a misleading zero.
      setAuthLoadFailed(true);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  async function handleDelete(p: Provider) {
    setActionMenuId(null);
    const ok = await confirm(t('models.confirmDelete', { name: p.name }));
    if (!ok) return;
    try {
      await deleteProvider(p.id);
      toast(t('models.deleted', { name: p.name }), 'success');
      load();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  }

  async function handleOAuthLogin(providerId: string) {
    setLoggingIn(providerId);
    try {
      const res = await triggerOAuthLogin(providerId);
      toast(res.message, 'success');
      // The CLI login runs in another terminal. Poll the local session so the
      // user does not need to click Connect or refresh the page afterwards.
      const deadline = Date.now() + 60_000;
      let loggedIn = false;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 2_000));
        const authData = await getAuthStatus();
        const status = authData.statuses.find(item => item.id === providerId);
        const oauthLoggedIn = status?.oauthLoggedIn === true;
        if (status) {
          setAuthMap(prev => ({
            ...prev,
            [providerId]: {
              ...(prev[providerId] || { hasApiKey: false, authVerified: false, authMode: status.authMode }),
              hasApiKey: status.hasApiKey,
              authVerified: status.authVerified === true,
              oauthLoggedIn,
              authMode: status.authMode,
              authState: status.authState,
              authVerifiedAt: status.authVerifiedAt,
              authLastCheckedAt: status.authLastCheckedAt,
              authLastError: status.authLastError,
            },
          }));
        }
        if (oauthLoggedIn) {
          loggedIn = true;
          break;
        }
      }
      if (loggedIn) {
        toast(t('models.statusAuthed'), 'success');
        await load();
        const sync = await fetchModels(providerId);
        if (sync.success) toast(t('models.connected', { n: sync.models.length }), 'success');
      } else {
        toast(t('models.oauthWaitingTimeout'), 'info');
      }
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setLoggingIn(null);
    }
  }

  async function handleConnect(p: Provider) {
    setActionMenuId(null);
    if (p.authMode === 'none') {
      setSyncingModels(p.id);
      try {
        const res = await fetchModels(p.id);
        toast(res.success ? t('models.connected', { n: res.models.length }) : t('models.syncFailed'), res.success ? 'success' : 'error');
        if (res.success) await load();
      } catch (err: any) {
        toast(err.message || t('models.syncFailed'), 'error');
      } finally {
        setSyncingModels(null);
      }
      return;
    }
    if (getCardAuthMethod(p) === 'oauth') {
      setTestingConn(p.id);
      try {
        const authData = await getAuthStatus();
        const status = (authData.statuses || []).find((item: any) => item.id === p.id);
        const oauthLoggedIn = status?.oauthLoggedIn === true;
        setAuthMap(prev => ({
          ...prev,
          [p.id]: {
            ...(prev[p.id] || { hasApiKey: Boolean(p.vaultKey), authVerified: false, authMode: p.authMode }),
            oauthLoggedIn,
          },
        }));
        if (!oauthLoggedIn) {
          await handleOAuthLogin(p.id);
          return;
        }

        setSyncingModels(p.id);
        const res = await fetchModels(p.id);
        if (res.success) {
          toast(t('models.connected', { n: res.models.length }), 'success');
          load();
        } else {
          toast(t('models.statusAuthed'), 'success');
        }
      } catch (err: any) {
        toast(err.message || t('models.testFailed'), 'error');
      } finally {
        setTestingConn(null);
        setSyncingModels(null);
      }
      return;
    }

    setTestingConn(p.id);
    setEndpointResults(prev => {
      const next = { ...prev };
      delete next[p.id];
      return next;
    });
    try {
      const verification = await verifyProviderAuth(p.id);
      const results = verification.results || [];
      setEndpointResults(prev => ({
        ...prev,
        [p.id]: results.map(result => ({ success: result.success, message: result.message })),
      }));
      const status = verification.status;
      setAuthMap(prev => ({
        ...prev,
        [p.id]: {
          ...(prev[p.id] || { hasApiKey: Boolean(p.vaultKey), oauthLoggedIn: null, authMode: p.authMode }),
          hasApiKey: status.hasApiKey,
          authVerified: status.authVerified,
          oauthLoggedIn: status.oauthLoggedIn,
          authMode: status.authMode,
          authState: status.authState,
          authLastCheckedAt: status.authLastCheckedAt,
          authLastError: status.authLastError,
          authEndpointStates: status.authEndpointStates,
        },
      }));

      if (!verification.success) {
        toast(status.authLastError || t('models.endpointsFailed', { n: results.filter(r => !r.success).length }), status.authState === 'stale' ? 'info' : 'error');
        setTestingConn(null);
        return;
      }

      // 连接成功后自动拉取最新模型列表
      setSyncingModels(p.id);
      setTestingConn(null);
      const res = await fetchModels(p.id);
      if (res.success) {
        toast(t('models.connected', { n: res.models.length }), 'success');
        load();
      } else if (res.kept) {
        toast(t('models.connectKept', { n: res.kept.length }), 'success');
        load();
      } else {
        toast(t('models.allEndpointsOk'), 'success');
      }
    } catch (err: any) {
      toast(err.message || t('models.testFailed'), 'error');
    } finally {
      setTestingConn(null);
      setSyncingModels(null);
    }
  }

  // 获取卡片当前选中的认证方式,默认: 有 vaultKey 选 api_key,否则 oauth
  function getCardAuthMethod(p: Provider): 'api_key' | 'oauth' {
    const stored = cardAuthMethod[p.id];
    if (stored) return stored;
    // 根据 provider 支持的方式决定默认值
    if (p.authMode === 'oauth') return 'oauth';
    if (p.authMode === 'both' && authMap[p.id]?.oauthLoggedIn === true && !p.vaultKey) return 'oauth';
    if (p.vaultKey) return 'api_key';
    if (p.authMode === 'both') return 'api_key';
    return 'api_key';
  }

  // provider 是否支持某种认证方式
  function supportsMethod(p: Provider, method: 'api_key' | 'oauth'): boolean {
    if (method === 'api_key') return p.authMode === 'api_key' || p.authMode === 'both';
    return p.authMode === 'oauth' || p.authMode === 'both';
  }

  async function handleSyncModels(p: Provider) {
    setActionMenuId(null);
    setSyncingModels(p.id);
    try {
      const res = await fetchModels(p.id);
      if (res.success) {
        toast(t('models.synced', { n: res.models.length }), 'success');
        load();
      } else if (res.kept) {
        toast(t('models.syncKept', { n: res.kept.length }), 'info');
      } else {
        toast(t('models.syncFailed'), 'error');
      }
    } catch (err: any) {
      toast(err.message || t('models.syncFailed'), 'error');
    } finally {
      setSyncingModels(null);
    }
  }

  function handleEdit(p: Provider) {
    setActionMenuId(null);
    setEditProvider(p);
    setShowForm(true);
  }

  function handleAdd() {
    setEditProvider(null);
    setShowForm(true);
  }

  function switchView(v: ViewKey) {
    if (v === 'model' && !MODEL_COMPARISON_ENABLED) return;
    setView(v);
    setActiveProvider(null);
    setActiveGroup(null);
    setActiveProtocol(null);
    setActivePlanFilter(null);
    setActivePlatform(null);
  }

  async function handleFormSave(data: any) {
    try {
      if (editProvider) {
        await updateProvider(editProvider.id, data);
        toast(t('models.updated', { name: data.name }), 'success');
      } else {
        await createProvider(data);
        toast(t('models.added', { name: data.name }), 'success');
      }
      setShowForm(false);
      setEditProvider(null);
      load();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  }


  // 计算每个 provider 是否"已被使用"
  function isUsedBy(p: Provider): boolean {
    return Boolean(p.usedBy && p.usedBy.length > 0);
  }

  function isAuthed(p: Provider): boolean {
    if (p.authMode === 'none') return true;
    const auth = authMap[p.id];
    return Boolean(
      auth?.oauthLoggedIn === true
      || (p.vaultKey && auth?.hasApiKey && auth?.authVerified === true && auth?.authState !== 'invalid')
    );
  }

  function isAuthMethodAuthed(p: Provider, method: 'api_key' | 'oauth'): boolean {
    if (p.authMode === 'none') return true;
    const auth = authMap[p.id];
    if (method === 'oauth') return auth?.oauthLoggedIn === true;
    return Boolean(p.vaultKey && auth?.hasApiKey && auth.authVerified === true && auth.authState !== 'invalid');
  }

  function needsAuthVerification(p: Provider): boolean {
    const auth = authMap[p.id];
    return Boolean(
      p.authMode !== 'none'
      && p.vaultKey
      && auth?.hasApiKey
      && (auth.authState === 'needs_verification' || auth.authState === 'invalid')
    );
  }

  function needsAuthAttention(p: Provider): boolean {
    const state = authMap[p.id]?.authState;
    return state === 'stale' || state === 'partial';
  }

  function matchesQuery(p: Provider): boolean {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    if (p.name?.toLowerCase().includes(q)) return true;
    if (p.id.toLowerCase().includes(q)) return true;
    if (p.models?.some(m => m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q))) return true;
    return false;
  }

  // 过滤 + 分组
  const filteredProviders = useMemo(() => {
    // 预计算每个 provider 的家族成员(用于套餐筛选时保留同家族成员)
    const familyIdsMap = new Map<string, string[]>();
    for (const f of PROVIDER_FAMILIES) {
      for (const id of f.ids) familyIdsMap.set(id, f.ids);
    }

    return providers.filter(p => {
      // 平台视角：按分组或具体平台过滤
      if (activeProvider && p.id !== activeProvider) return false;
      if (activeGroup && groupOf(p.id).key !== activeGroup) return false;
      // 协议筛选：平台必须提供该协议端点
      if (activeProtocol && !providerProtocols(p).includes(activeProtocol)) return false;
      // 套餐筛选:对多成员家族,任一成员匹配则保留整个家族(卡片内用 tab 切换)
      if (activePlanFilter) {
        const ownPlans = providerPlans(p);
        let planMatches = ownPlans.includes(activePlanFilter);
        const familyIds = familyIdsMap.get(p.id);
        if (familyIds) {
          const familyMatch = familyIds.some(fid => {
            const fp = providers.find(pp => pp.id === fid);
            return fp && providerPlans(fp).includes(activePlanFilter);
          });
          planMatches = planMatches || familyMatch;
        }
        if (!planMatches) return false;
      }
      if (!matchesQuery(p)) return false;
      if (statusFilter === 'authed' && !isAuthed(p)) return false;
      if (statusFilter === 'unauthed' && isAuthed(p)) return false;
      if (statusFilter === 'unverified' && !needsAuthVerification(p)) return false;
      if (statusFilter === 'attention' && !needsAuthAttention(p)) return false;
      if (statusFilter === 'used' && !isUsedBy(p)) return false;
      return true;
    });
  }, [providers, authMap, activeProvider, activeGroup, activeProtocol, activePlanFilter, searchQuery, statusFilter]);

  // Build a global ordering: group priority (official → aggregator → china → local)
  // then the position within each group's ids array. Providers not in any group
  // sink to the bottom sorted alphabetically.
  const providerOrder = useMemo(() => {
    const map = new Map<string, number>();
    let idx = 0;
    for (const g of PROVIDER_GROUPS) {
      for (const id of g.ids) map.set(id, idx++);
    }
    return map;
  }, []);

  const sortedProviders = useMemo(
    () => [...filteredProviders].sort((a, b) =>
      (a.name || a.id).localeCompare(b.name || b.id, 'zh-Hans-CN')
    ),
    [filteredProviders]
  );

  // Group sorted providers into families for the platform view.
  const sortedFamilies = useMemo(() => {
    const result: { familyDef: ProviderFamily | null; providers: Provider[]; isMulti: boolean }[] = [];
    const seen = new Set<string>();
    for (const p of sortedProviders) {
      const famName = PROVIDER_FAMILY_MAP.get(p.id);
      if (famName) {
        const famDef = PROVIDER_FAMILIES.find(f => f.family === famName)!;
        let bucket = result.find(r => r.familyDef?.family === famName);
        if (!bucket) {
          bucket = { familyDef: famDef, providers: [], isMulti: famDef.ids.length > 1 };
          result.push(bucket);
        }
        bucket.providers.push(p);
        seen.add(p.id);
      } else {
        result.push({ familyDef: null, providers: [p], isMulti: false });
        seen.add(p.id);
      }
    }
    return result;
  }, [sortedProviders]);

  // Per-family plan selection state
  const [familyPlan, setFamilyPlan] = useState<Record<string, string>>({});

  const platformPlanOptions = useMemo(() => [
    { value: 'all', label: t('models.filterAllPlans') },
    ...PLAN_FILTERS.map(plan => ({
      value: plan.key,
      label: `${t(plan.labelKey)} · ${new Set(
        providers
          .filter(provider => providerPlans(provider).includes(plan.key))
          .map(provider => PROVIDER_FAMILY_MAP.get(provider.id) || provider.id)
      ).size}`,
    })),
  ], [providers, t]);

  const platformStatusOptions: { value: StatusFilter; label: string }[] = [
    { value: 'all', label: t('models.filterAllStatuses') },
    { value: 'authed', label: t('models.filterAuthed') },
    { value: 'unauthed', label: t('models.filterUnauthed') },
    { value: 'unverified', label: t('models.filterUnverified') },
    { value: 'attention', label: t('models.filterAttention') },
    { value: 'used', label: t('models.filterUsed') },
  ];

  function getActiveFamilyProvider(famDef: ProviderFamily, members: Provider[]): Provider {
    const planLabel = familyPlan[famDef.family] || famDef.plans?.[0]?.label;
    if (planLabel && famDef.plans) {
      const plan = famDef.plans.find(p => p.label === planLabel);
      if (plan) {
        const found = members.find(p => p.id === plan.providerId);
        if (found) return found;
      }
    }
    // Fallback: first member (sorted order = plans[0])
    return members[0];
  }
  const modelStats = useMemo(() => {
    const endpoints = platforms.reduce((sum, platform) => sum + platform.endpoints.length, 0);
    const models = platforms.reduce((sum, platform) => sum + platform.models.length, 0);
    const offerings = platforms.reduce((sum, platform) => sum + platform.offerings.length, 0);
    const authed = platforms.filter(platform => platform.providerIds.some(providerId => {
      const provider = providers.find(item => item.id === providerId);
      return provider ? isAuthed(provider) : false;
    })).length;
    const used = providers.filter(p => isUsedBy(p)).length;
    const attention = platforms.filter(platform => platform.providerIds.some(providerId => {
      const provider = providers.find(item => item.id === providerId);
      return provider ? needsAuthVerification(provider) || needsAuthAttention(provider) : false;
    })).length;
    return { endpoints, models, offerings, authed, used, attention, total: platforms.length };
  }, [providers, platforms, authMap]);
  const comparisonModelCount = useMemo(() => Object.entries(crossData)
    .filter(([, entries]) => Array.isArray(entries) && entries.length > 0 && (!hideLegacy || !entries.some(entry => entry.legacy)))
    .length, [hideLegacy]);
  const modelVendorOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const [, entries] of Object.entries(crossData)) {
      if (!Array.isArray(entries) || entries.length === 0) continue;
      if (hideLegacy && entries.some(entry => entry.legacy)) continue;
      const vendor = entries[0]?.primary_provider || 'unknown';
      counts.set(vendor, (counts.get(vendor) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [hideLegacy]);
  const filteredComparisonCount = useMemo(() => filterModelEntries(
    Object.entries(crossData).filter(([, entries]) => Array.isArray(entries) && entries.length > 0),
    {
      hideLegacy,
      activeProtocol,
      activeModality,
      searchQuery,
      providers,
      activeProvider: activeModelProvider,
    },
  ).length, [hideLegacy, activeProtocol, activeModality, searchQuery, providers, activeModelProvider]);
  const hasComparisonFilters = Boolean(searchQuery || activeModelProvider || activeModality || activeProtocol || !hideLegacy);

  // 分组 chips：跟随视角动态生成（分段结构，每段独立一行）
  // 返回: [{ label, chips: [...] }, ...]
  const groupChips = useMemo(() => {
    if (view === 'model') {
      // 模型视角：厂商 + 模态 + 协议（chip 区不再罗列具体模型本体，因为 ModelGrid 内部已按厂商分组）
      // 厂商 chip 计数：应用除「厂商自身」外的所有过滤（含模态），保证数量=点进去实际渲染数
      const filteredForProvider = filterModelEntries(
        Object.entries(crossData).filter(([, e]) => Array.isArray(e) && e.length > 0),
        { hideLegacy, activeProtocol, activeModality, searchQuery, providers }
      );
      // 模态 chip 计数：应用除「模态自身」外的所有过滤（含厂商）
      const filteredForMod = filterModelEntries(
        Object.entries(crossData).filter(([, e]) => Array.isArray(e) && e.length > 0),
        { hideLegacy, activeProtocol, searchQuery, providers, activeProvider: activeModelProvider }
      );
      const ppCounts: Record<string, number> = {};
      for (const [, e] of filteredForProvider) {
        const pp = e[0]?.primary_provider || 'unknown';
        ppCounts[pp] = (ppCounts[pp] || 0) + 1;
      }
      const providerChips = [
        { key: '__all_pp__', label: t('models.filterAll'), active: !activeModelProvider, onClick: () => setActiveModelProvider(null) },
        ...Object.entries(ppCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([pp, n]) => ({
            key: pp,
            label: PROVIDER_LABELS[pp] || pp,
            extra: `${n}`,
            active: activeModelProvider === pp,
            onClick: () => setActiveModelProvider(activeModelProvider === pp ? null : pp),
          })),
      ];
      const protocolChips = [
        { key: '__all_proto__', label: t('models.filterAll'), active: !activeProtocol, onClick: () => setActiveProtocol(null) },
        ...PROTOCOLS.filter(pc => providers.some(p => providerProtocols(p).includes(pc.key))).map(pc => ({
          key: pc.key,
          label: t(pc.labelKey),
          active: activeProtocol === pc.key,
          onClick: () => setActiveProtocol(activeProtocol === pc.key ? null : pc.key),
        })),
      ];
      // 模态 chips（text/image/video/audio/3d/omni）——数量统计基于 filteredForMod
      const modCounts: Record<string, number> = {};
      for (const [, e] of filteredForMod) {
        const m = e[0]?.modality || 'text';
        modCounts[m] = (modCounts[m] || 0) + 1;
      }
      const MODALITIES: { key: string; label: string }[] = [
        { key: 'text', label: t('models.modText') },
        { key: 'image', label: t('models.modImage') },
        { key: 'video', label: t('models.modVideo') },
        { key: 'audio', label: t('models.modAudio') },
        { key: '3d', label: t('models.mod3d') },
        { key: 'omni', label: t('models.modOmni') },
      ];
      const modalityChips = [
        { key: '__all_mod__', label: t('models.filterAll'), active: !activeModality, onClick: () => setActiveModality(null) },
        ...MODALITIES.map(md => ({
          key: md.key,
          label: md.label,
          extra: `${modCounts[md.key] || 0}`,
          active: activeModality === md.key,
          onClick: () => setActiveModality(activeModality === md.key ? null : md.key),
        })),
      ];
      return [
        { label: t('models.dimModelProvider'), chips: providerChips },
        { label: t('models.dimModality'), chips: modalityChips },
        { label: t('models.dimProtocol'), chips: protocolChips },
      ];
    }

    // 平台首页不暴露底层接口格式。兼容层往往只实现协议子集，
    // 将它作为一级筛选会暗示并不存在的等价性；具体格式仍在平台配置中维护。
    return [];
  }, [view, providers, activeProtocol, activePlanFilter, activeGroup, activeProvider, activeModel, activeModelProvider, activeModality, t]);

  if (loading) {
    return (
      <div className="provider-list">
        {Array.from({ length: 10 }).map((_, i) => (
          <article key={i} className="provider-card provider-card--skeleton" aria-hidden="true">
            <div className="provider-card-header">
              <div className="skeleton-shape skeleton-shape--icon" />
              <div className="skeleton-line skeleton-line--title" />
            </div>
            <div className="skeleton-line" />
            <div className="skeleton-line skeleton-line--short" />
          </article>
        ))}
      </div>
    );
  }

  return (
    <>
    <div className="access-workspace models-workspace models-page-full">

        {!activePlatform && !activeModel && (
          <header className="models-page-heading">
            <div className="models-page-heading-copy">
              <span className="models-page-eyebrow">{t('models.pageEyebrow')}</span>
              <h1 className="sr-only">{t('models.pageTitle')}</h1>
              <p>{t('models.pageSubtitle')}</p>
            </div>
            <div className="models-page-summary" aria-label={t('models.pageSummary')}>
              <span><strong>{modelStats.total}</strong>{t('models.summaryPlatforms')}</span>
              <span><strong>{modelStats.models}</strong>{t('models.summaryModels')}</span>
              <span className={authLoaded && modelStats.attention > 0 ? 'is-attention' : ''}>
                <strong>{authLoaded ? modelStats.attention : '—'}</strong>{t('models.summaryAttention')}
              </span>
            </div>
          </header>
        )}

        {/* 平台使用分组筛选；模型对比使用单行紧凑筛选。 */}
        {MODEL_COMPARISON_ENABLED && !activePlatform && view === 'model' && !activeModel && (
          <div className="model-compare-filterbar">
            <label className="model-compare-search">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
              <input
                type="search"
                value={searchQuery}
                onChange={event => setSearchQuery(event.target.value)}
                placeholder={t('models.searchModels')}
              />
            </label>
            <label className="model-compare-select">
              <span>{t('models.dimModelProvider')}</span>
              <select value={activeModelProvider || ''} onChange={event => setActiveModelProvider(event.target.value || null)}>
                <option value="">{t('models.filterAll')}</option>
                {modelVendorOptions.map(([vendor, count]) => (
                  <option key={vendor} value={vendor}>{PROVIDER_LABELS[vendor] || vendor} · {count}</option>
                ))}
              </select>
            </label>
            <label className="model-compare-select">
              <span>{t('models.dimModality')}</span>
              <select value={activeModality || ''} onChange={event => setActiveModality(event.target.value || null)}>
                <option value="">{t('models.filterAll')}</option>
                <option value="text">{t('models.modText')}</option>
                <option value="image">{t('models.modImage')}</option>
                <option value="video">{t('models.modVideo')}</option>
                <option value="audio">{t('models.modAudio')}</option>
                <option value="3d">{t('models.mod3d')}</option>
                <option value="omni">{t('models.modOmni')}</option>
              </select>
            </label>
            <label className="model-compare-select">
              <span>{t('models.dimProtocol')}</span>
              <select value={activeProtocol || ''} onChange={event => setActiveProtocol(event.target.value || null)}>
                <option value="">{t('models.filterAll')}</option>
                {PROTOCOLS.filter(protocol => providers.some(provider => providerProtocols(provider).includes(protocol.key))).map(protocol => (
                  <option key={protocol.key} value={protocol.key}>{t(protocol.labelKey)}</option>
                ))}
              </select>
            </label>
            <label className="model-compare-latest">
              <input type="checkbox" checked={hideLegacy} onChange={event => setHideLegacy(event.target.checked)} />
              <span>{t('models.onlyLatest')}</span>
            </label>
            <span className="model-compare-result-count">{filteredComparisonCount}</span>
            {hasComparisonFilters && (
              <button
                type="button"
                className="model-compare-clear"
                onClick={() => {
                  setSearchQuery('');
                  setActiveModelProvider(null);
                  setActiveModality(null);
                  setActiveProtocol(null);
                  setHideLegacy(true);
                }}
              >
                {t('models.clearFilters')}
              </button>
            )}
          </div>
        )}
        {!activePlatform && view === 'platform' && <div className="models-toolbar">
          <div className="models-platform-search-row">
            <label className="models-platform-search">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
              <input
                type="search"
                value={searchQuery}
                onChange={event => setSearchQuery(event.target.value)}
                placeholder={t('models.searchPlaceholder')}
                aria-label={t('models.searchPlaceholder')}
              />
              <span aria-hidden="true">{sortedFamilies.length}</span>
            </label>
            <button className="models-add-inline" onClick={handleAdd}>{t('models.addPlatform')}</button>
          </div>
          <div className="models-filter-select-row" aria-label={t('models.filterConditions')}>
            <div className={`models-filter-select-field${activePlanFilter ? ' is-active' : ''}`}>
              <span>{t('models.dimPlan')}</span>
              <CustomSelect
                className="models-filter-select"
                value={activePlanFilter || 'all'}
                options={platformPlanOptions}
                onChange={value => {
                  setActivePlanFilter(value === 'all' ? null : value as PlanFilter);
                  setFamilyPlan({});
                }}
              />
            </div>
            <div className={`models-filter-select-field${statusFilter !== 'all' ? ' is-active' : ''}`}>
              <span>{t('models.dimStatus')}</span>
              <CustomSelect
                className="models-filter-select"
                value={statusFilter}
                options={platformStatusOptions}
                onChange={value => setStatusFilter(value as StatusFilter)}
              />
            </div>
          </div>
        </div>}

        {MODEL_COMPARISON_ENABLED && view === 'model' && activeModel && crossData[activeModel] && (
          <ModelDetailPanel modelKey={activeModel} entries={crossData[activeModel]} providers={providers} authMap={authMap} t={t} onBack={() => setActiveModel(null)} />
        )}
        {MODEL_COMPARISON_ENABLED && view === 'model' && !activeModel && (
          <ModelGrid
            models={Object.entries(crossData).filter(([, e]) => Array.isArray(e) && e.length > 0)}
            providers={providers}
            authMap={authMap}
            activeModel={activeModel}
            searchQuery={searchQuery}
            onSelect={(k) => setActiveModel(k)}
            t={t}
            activeProvider={activeModelProvider}
            hideLegacy={hideLegacy}
            activeProtocol={activeProtocol}
            activeModality={activeModality}
          />
        )}
        {view === 'platform' && !activePlatform && (
          <div>
            {sortedProviders.length === 0 && (
              <div className="empty-state"><p>{t('models.noMatch')}</p></div>
            )}

            <div className="provider-list">
          {sortedFamilies.map(fam => {
            const isMulti = fam.isMulti;
            const famDef = fam.familyDef;
            // 内联计算当前选中的 provider,不依赖外部函数
            let p: Provider;
            if (isMulti && famDef && famDef.plans) {
              // A plan filter should open each family card on the matching
              // variant. Otherwise a Coding Plan result can still look like
              // its default API-platform variant even though it matched.
              const filteredPlan = activePlanFilter
                ? famDef.plans.find(plan => {
                    const member = fam.providers.find(provider => provider.id === plan.providerId);
                    return member && providerPlans(member).includes(activePlanFilter);
                  })
                : undefined;
              // A global filter chooses the initial variant. A manual switch
              // on this card overrides only this family and must not mutate
              // the global filter; changing the global filter clears these
              // local overrides above.
              const selectedLabel = familyPlan[famDef.family] || filteredPlan?.label || famDef.plans[0]?.label;
              const selectedPlan = famDef.plans.find(pl => pl.label === selectedLabel) || famDef.plans[0];
              p = fam.providers.find(mp => mp.id === selectedPlan.providerId) || fam.providers[0];
            } else {
              p = fam.providers[0];
            }
            const platform = platforms.find(item => famDef
              ? item.name === famDef.family
              : item.providerIds.includes(p.id));
            const auth = authMap[p.id];
            const authed = isAuthed(p);
            const selectedAuthMethod = getCardAuthMethod(p);
            // A platform card can represent several offerings. The default
            // OpenAI variant is API Key, but its Agent Subscription offering
            // is the separate openai-codex provider, so derive OAuth actions
            // from the whole family rather than only the selected variant.
            const oauthProvider = p.authMode === 'oauth' || p.authMode === 'both'
              ? p
              : famDef
                ? providers.find(candidate => famDef.ids.includes(candidate.id)
                  && (candidate.authMode === 'oauth' || candidate.authMode === 'both'))
                : undefined;
            const needsVerification = selectedAuthMethod === 'api_key'
              && Boolean(p.vaultKey && auth?.hasApiKey && (auth.authState === 'needs_verification' || auth.authState === 'invalid'));
            const used = isUsedBy(p);
            // 状态反映当前选中的变体(不是整个家族的并集)
            const familyAuthed = isMulti ? authed : isAuthMethodAuthed(p, selectedAuthMethod);
            const authWarning = selectedAuthMethod === 'api_key' && (auth?.authState === 'stale' || auth?.authState === 'partial');
            const statusLabel = !authLoaded
              ? authLoadFailed ? t('models.statusUnavailable') : t('models.statusChecking')
              : authWarning
              ? auth?.authState === 'partial' ? t('models.statusPartial') : t('models.statusStale')
              : p.authMode === 'none' ? t('models.statusNoAuth')
              : familyAuthed ? t('models.statusAuthed') : needsVerification ? t('models.statusNeedsVerification') : t('models.statusUnauthed');
            const authDetail = !authLoaded
              ? authLoadFailed ? t('models.authStatusUnavailable') : t('models.statusChecking')
              : authWarning
              ? `${auth?.authLastError || t('models.authNeedsRecheck')}${auth?.authLastCheckedAt ? ` · ${new Date(auth.authLastCheckedAt).toLocaleString()}` : ''}`
              : familyAuthed
                ? selectedAuthMethod === 'oauth' ? t('models.authenticatedViaOAuth') : p.authMode === 'none' ? t('models.authModeNone') : t('models.authenticatedViaApiKey')
                : needsVerification
                  ? t('models.apiKeyPendingVerification')
                  : selectedAuthMethod === 'oauth' ? t('models.oauthNotCompleted') : t('models.apiKeyNotConfigured');

            return (
              <article
                key={platform?.id || famDef?.family || p.id}
                className={`provider-card${PLATFORM_DETAIL_ENABLED ? ' provider-card--clickable' : ''}${familyAuthed ? ' provider-card--authed' : ''}${testingConn === p.id ? ' provider-card--testing' : ''}`}
                onClick={PLATFORM_DETAIL_ENABLED ? () => setActivePlatform(platform?.id || p.id) : undefined}
                aria-busy={testingConn === p.id}
              >
                <div className="provider-card-header">
                  <div className="provider-card-title">
                    {(() => { const icon = getProviderIcon(p.id); return icon ? <img src={icon} alt="" className={['provider-card-brand-icon', getProviderIconClass(p.id)].filter(Boolean).join(' ')} /> : null; })()}
                    <h3>{providerName(p.id, platform?.name || (isMulti && famDef ? famDef.family : p.name))}</h3>
                  </div>
                  <div className="provider-card-status">
                    {testingConn === p.id && (
                      <span className="provider-status provider-status--testing">
                        <span className="provider-status-spinner" aria-hidden="true" />
                        {t('models.testingConn')}
                      </span>
                    )}
                    <span
                      className={`provider-status provider-status--${!authLoaded ? 'pending' : authWarning ? 'warning' : familyAuthed ? 'authed' : 'unauthed'} provider-status--with-auth-tooltip`}
                      tabIndex={0}
                      data-auth-detail={authDetail}
                    >
                      {statusLabel}
                    </span>
                  </div>
                  <div className="provider-card-actions">
                    <button
                      className="btn-icon"
                      onClick={e => { e.stopPropagation(); setActionMenuId(actionMenuId === p.id ? null : p.id); }}
                      title={t('models.moreActions')}
                      aria-haspopup="menu"
                      aria-expanded={actionMenuId === p.id}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
                    </button>
                    {actionMenuId === p.id && (
                      <ActionMenu
                        onClose={() => setActionMenuId(null)}
                        actions={[
                          ...(oauthProvider ? [{
                            label: loggingIn === oauthProvider.id ? t('models.testingConn') : t('models.authModeOAuth'),
                            onClick: () => { setActionMenuId(null); handleOAuthLogin(oauthProvider.id); },
                            disabled: loggingIn === oauthProvider.id,
                          }] : []),
                          ...(selectedAuthMethod !== 'oauth' ? [{ label: p.authMode === 'none' ? t('models.syncModels') : `${t('models.authModeApiKey')} ${t('models.menuConnect')}`, onClick: () => handleConnect(p), disabled: testingConn === p.id || syncingModels === p.id }] : []),
                          { label: t('models.menuEdit'), onClick: () => handleEdit(p) },
                          { label: t('models.menuDelete'), onClick: () => handleDelete(p), danger: true },
                        ]}
                      />
                    )}
                  </div>
                </div>

              </article>
            );
          })}
        </div>
          </div>
        )}

        {PLATFORM_DETAIL_ENABLED && view === 'platform' && activePlatform && (
          (() => {
            const platform = platforms.find(item => item.id === activePlatform)
              || platforms.find(item => item.providerIds.includes(activePlatform));
            if (!platform) return <div className="empty-state"><p>{t('models.noMatch')}</p></div>;
            return (
              <PlatformDetailPanel
                key={platform.id}
                platform={platform}
                providers={providers}
                authMap={authMap}
                crossData={crossData}
                onBack={() => setActivePlatform(null)}
              />
            );
          })()
        )}

      {showForm && (
        <ProviderForm
          key={editProvider?.id || 'new-platform'}
          provider={editProvider}
          platform={platforms.find(platform => editProvider ? platform.providerIds.includes(editProvider.id) : false) || null}
          onOAuthLogin={handleOAuthLogin}
          oauthLoggedIn={editProvider ? authMap[editProvider.id]?.oauthLoggedIn === true : false}
          oauthLoggingIn={editProvider ? loggingIn === editProvider.id : false}
          onSelectOffering={providerId => {
            const next = providers.find(provider => provider.id === providerId);
            if (next) setEditProvider(next);
          }}
          onSave={handleFormSave}
          onClose={() => { setShowForm(false); setEditProvider(null); }}
        />
      )}
      </div>
    </>
  );
}
function StatChip({ label, value, tone }: { label: string; value: number | string; tone?: 'muted' | 'success' | 'warn' }) {
  return (
    <div className={`stat-chip stat-chip--${tone || 'default'}`}>
      <span className="stat-chip-value">{value}</span>
      <span className="stat-chip-label">{label}</span>
    </div>
  );
}

function ModelDetailPanel({ modelKey, entries, providers, authMap, t, onBack }: { modelKey: string; entries: any[]; providers: Provider[]; authMap: Record<string, AuthState>; t: (k: string, ...args: any[]) => string; onBack: () => void }) {
  const platforms = [...new Set(entries.map((e: any) => e.platform))];
  const fmtPrice = (raw: string | undefined): number => {
    if (!raw || raw === '0') return 0;
    const n = parseFloat(raw);
    return isNaN(n) ? 0 : n * 1e6;
  };
  const allPrices = entries.flatMap(e => [fmtPrice(e.pricing?.prompt), fmtPrice(e.pricing?.completion)]);
  const maxPrice = Math.max(...allPrices, 0.01);

  // 模型基本信息聚合（取有数据的第一个）
  const sample = entries.find((e: any) => e.context || e.architecture) || entries[0];
  const arch = sample?.architecture || {};
  const inputModes: string[] = arch.input_modalities || arch.inputModes || [];
  const outputModes: string[] = arch.output_modalities || arch.outputModes || [];
  const ctx = sample?.context || sample?.context_length;
  const sampleEntry = entries.find((e: any) => e.context) || entries[0];
  const allPlatformsWithCtx = entries.filter((e: any) => e.context).map((e: any) => e.context);
  const minInputPrice = Math.min(...entries.map((e: any) => fmtPrice(e.pricing?.prompt)).filter(n => n > 0), Infinity);
  const minOutputPrice = Math.min(...entries.map((e: any) => fmtPrice(e.pricing?.completion)).filter(n => n > 0), Infinity);

  return (
    <div className="model-cross-view">
      <div className="model-detail-header">
        <button className="model-detail-back" onClick={onBack}>← {t('models.back')}</button>
        <div className="model-detail-title">
          <h3>{modelKey}</h3>
          <p>{t('models.modelAvailableIn', { n: platforms.length })}</p>
        </div>
      </div>

      {/* 模型基本信息 */}
      <div className="model-info-grid">
        <div className="model-info-card">
          <div className="model-info-label">{t('models.infoContext')}</div>
          <div className="model-info-value">
            {ctx ? `${Math.round(ctx / 1024)}K` : '—'}
            {allPlatformsWithCtx.length > 1 && (
              <span className="model-info-hint"> · {t('models.infoContextHint', { n: allPlatformsWithCtx.length })}</span>
            )}
          </div>
        </div>
        <div className="model-info-card">
          <div className="model-info-label">{t('models.infoInputModes')}</div>
          <div className="model-info-value">
            {inputModes.length ? inputModes.map((m: string) => (
              <span key={m} className="model-info-mode">{m}</span>
            )) : <span className="model-info-muted">—</span>}
          </div>
        </div>
        <div className="model-info-card">
          <div className="model-info-label">{t('models.infoOutputModes')}</div>
          <div className="model-info-value">
            {outputModes.length ? outputModes.map((m: string) => (
              <span key={m} className="model-info-mode">{m}</span>
            )) : <span className="model-info-muted">—</span>}
          </div>
        </div>
        <div className="model-info-card">
          <div className="model-info-label">{t('models.infoMinPrice')}</div>
          <div className="model-info-value">
            {isFinite(minInputPrice) ? <span className="model-info-price">${minInputPrice.toFixed(2)}<span className="model-info-unit">/M in</span></span> : '—'}
            {isFinite(minOutputPrice) && <span className="model-info-price"> · ${minOutputPrice.toFixed(2)}<span className="model-info-unit">/M out</span></span>}
          </div>
        </div>
        <div className="model-info-card">
          <div className="model-info-label">{t('models.infoAuthed')}</div>
          <div className="model-info-value">
            {(() => {
              const authedCount = platforms.filter((pid: any) => {
                const provider = providers.find(p => p.id === pid);
                return runtimeAuthReady(provider, provider ? authMap[provider.id] : undefined);
              }).length;
              return <span className={authedCount === platforms.length ? 'model-info-ok' : authedCount > 0 ? 'model-info-warn' : 'model-info-muted'}>{authedCount}/{platforms.length}</span>;
            })()}
          </div>
        </div>
      </div>

      {/* 跨平台对照表 */}
      <div className="model-cross-table-wrap">
        <table className="model-cross-table">
          <thead>
            <tr>
              <th>{t('models.platform')}</th>
              <th>{t('models.modelId')}</th>
              <th>{t('models.contextLabel')}</th>
              <th>{t('models.inputPrice')}</th>
              <th>{t('models.outputPrice')}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e: any, i: number) => {
              const pr = providers.find(p => p.id === e.platform);
              const ec = e.context ? `${Math.round(e.context / 1024)}K` : '?';
              const pi = fmtPrice(e.pricing?.prompt);
              const po = fmtPrice(e.pricing?.completion);
              const hasInputPrice = Object.prototype.hasOwnProperty.call(e.pricing || {}, 'prompt');
              const hasOutputPrice = Object.prototype.hasOwnProperty.call(e.pricing || {}, 'completion');
              const piPct = maxPrice > 0 ? (pi / maxPrice) * 100 : 0;
              const poPct = maxPrice > 0 ? (po / maxPrice) * 100 : 0;
              return (
                <tr key={i} className={runtimeAuthReady(pr, pr ? authMap[pr.id] : undefined) ? 'model-cross-row--authed' : ''}>
                  <td className="model-cross-platform">
                    {pr ? (
                      <span className="platform-chip">
                        <span className={`type-badge type-badge--${pr.type}`}>{pr.type}</span>
                        {pr.name}
                      </span>
                    ) : e.platform}
                  </td>
                  <td className="model-cross-id"><code>{e.model_id}</code></td>
                  <td className="model-cross-ctx">{ec}</td>
                  <td className="model-cross-price">
                    <span className="price-bar-wrap">
                      <span className="price-bar" style={{ width: `${Math.max(piPct, 3)}%` }} />
                      <span className="price-bar-label">{!hasInputPrice ? '—' : pi > 0 ? `$${pi.toFixed(2)}/M` : t('common.free')}</span>
                    </span>
                  </td>
                  <td className="model-cross-price">
                    <span className="price-bar-wrap">
                      <span className="price-bar price-bar--output" style={{ width: `${Math.max(poPct, 3)}%` }} />
                      <span className="price-bar-label">{!hasOutputPrice ? '—' : po > 0 ? `$${po.toFixed(2)}/M` : t('common.free')}</span>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ============ 平台详情视图：完整模型列表 + 可展开模型参数 ============ */
function PlatformDetailPanel({ platform, providers, authMap, crossData, onBack }: {
  platform: Platform;
  providers: Provider[];
  authMap: Record<string, AuthState>;
  crossData: Record<string, any[]>;
  onBack: () => void;
}) {
  const { t, providerName } = useI18n();
  const [activeOfferingId, setActiveOfferingId] = useState(platform.offerings[0]?.providerId || platform.providerIds[0]);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const offering = platform.offerings.find(item => item.providerId === activeOfferingId) || platform.offerings[0];
  const provider = providers.find(item => item.id === offering?.providerId)
    || providers.find(item => platform.providerIds.includes(item.id))!;
  const authed = runtimeAuthReady(provider, provider ? authMap[provider.id] : undefined);
  const fmtPrice = (raw: string | undefined): number => {
    if (!raw || raw === '0') return 0;
    const n = parseFloat(raw);
    return isNaN(n) ? 0 : n * 1e6;
  };
  const MOD_LABEL: Record<string, string> = {
    text: t('models.modText'), image: t('models.modImage'), video: t('models.modVideo'),
    audio: t('models.modAudio'), '3d': t('models.mod3d'), omni: t('models.modOmni'),
  };

  // 为每个实际配置的模型匹配参数清单（大小写/前缀归一化后查找）
  const rows = useMemo(() => {
    const lowerMap: Record<string, string> = {};
    for (const k of Object.keys(crossData)) lowerMap[k.toLowerCase()] = k;
    return (provider.models || [])
      .filter(m => m.id && m.id.trim())
      .map(m => {
        const id = m.id.trim();
        const norm = id.split('/').pop()?.toLowerCase() || '';
        const key = crossData[id] ? id : (lowerMap[norm] || lowerMap[id.toLowerCase()] || '');
        const entries = key ? (crossData[key] || []) : [];
        const entry = entries.find((e: any) => e.platform === provider.id);
        const platformAvailability = platform.models
          .find(platformModel => platformModel.id === id)
          ?.availability.filter(item => item.offeringId === offering?.id) || [];
        return {
          m,
          id,
          key,
          entries,
          entry,
          ctx: entry?.context || null,
          pricing: entry?.pricing || {},
          modality: entry?.modality || 'text',
          vendorFamily: entry?.vendor_family || '',
          isFlagship: Boolean(entry?.is_flagship),
          created: entry?.created || 0,
          legacy: Boolean(entry?.legacy),
          availability: platformAvailability.length ? platformAvailability : (m.availability || []),
          otherPlatforms: key ? [...new Set((entries || []).map((e: any) => e.platform))].filter((pl: string) => pl !== provider.id) : [],
        };
      });
  }, [provider, platform, offering, crossData]);

  const filtered = useMemo(() => {
    if (!q.trim()) return rows;
    const s = q.toLowerCase();
    return rows.filter(r =>
      r.id.toLowerCase().includes(s) ||
      (r.m.name || '').toLowerCase().includes(s) ||
      r.vendorFamily.toLowerCase().includes(s)
    );
  }, [rows, q]);

  const withParams = rows.filter(r => r.key).length;
  const usedCount = provider.usedBy?.length || 0;
  const eps = provider.executionMode === 'agent_native'
    ? []
    : (provider.endpoints || [{ type: provider.type, baseUrl: provider.baseUrl }]).map(normalizeEndpoint);
  const endpointById = new Map(platform.endpoints.map(endpoint => [endpoint.id, endpoint]));

  return (
    <div className="model-cross-view platform-detail-view">
      <div className="model-detail-header">
        <button className="model-detail-back" onClick={onBack}>← {t('models.backPlatforms')}</button>
        <div className="model-detail-title">
          <h3>{platform.name}</h3>
          <p>{t('models.platformSummary', { models: platform.models.length, offerings: platform.offerings.length })}</p>
        </div>
      </div>

      <div className="platform-offering-switcher" role="tablist" aria-label={t('models.totalOfferings')}>
        {platform.offerings.map(item => {
          const itemProvider = providers.find(candidate => candidate.id === item.providerId);
          const ready = runtimeAuthReady(itemProvider, itemProvider ? authMap[itemProvider.id] : undefined);
          return (
            <button
              key={item.id}
              role="tab"
              aria-selected={item.providerId === provider.id}
              className={`models-filter-chip${item.providerId === provider.id ? ' models-filter-chip--active' : ''}`}
              onClick={() => {
                setActiveOfferingId(item.providerId);
                setExpanded(new Set());
                setQ('');
              }}
            >
              {item.label}
              <span className="models-chip-extra">{item.executionMode === 'agent_native' ? 'Agent native' : `${item.endpointIds.length} endpoint`}</span>
              <span aria-label={ready ? t('models.statusAuthed') : t('models.statusUnauthed')}>{ready ? '✓' : '○'}</span>
            </button>
          );
        })}
      </div>

      <div className="platform-active-offering">
        <span className={`type-badge type-badge--${provider.type}`}>{provider.type}</span>
        <strong>{providerName(provider.id, provider.name)}</strong>
      </div>

      {/* 平台概览信息卡 */}
      <div className="model-info-grid">
        <div className="model-info-card">
          <div className="model-info-label">{t('models.totalModels')}</div>
          <div className="model-info-value">{provider.models.length}</div>
        </div>
        <div className="model-info-card">
          <div className="model-info-label">{t('models.withParams')}</div>
          <div className="model-info-value">{withParams}<span className="model-info-muted"> / {provider.models.length}</span></div>
        </div>
        <div className="model-info-card">
          <div className="model-info-label">{t('models.infoAuthed')}</div>
          <div className="model-info-value">
            {authed ? <span className="model-info-ok">✓</span> : <span className="model-info-muted">—</span>}
          </div>
        </div>
        <div className="model-info-card">
          <div className="model-info-label">{t('models.usedCount')}</div>
          <div className="model-info-value">{usedCount}</div>
        </div>
        <div className="model-info-card platform-detail-endpoint-card">
          <div className="model-info-label">{t('models.endpoint')}</div>
          <div className="model-info-value platform-detail-endpoints">
            {provider.executionMode === 'agent_native' && (
              <span className="model-info-mode">Agent native · {provider.nativeAgentIds?.join(', ') || '—'}</span>
            )}
            {eps.map((ep, i) => (
              <span key={i} className="model-info-mode">
                {ep.type}{ep.type === 'openai' ? `/${ep.protocol || 'chat'}` : ''} · {ep.baseUrl}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* 模型搜索 */}
      <input
        className="vault-input platform-detail-search"
        type="search"
        placeholder={t('models.searchModels')}
        value={q}
        onChange={e => setQ(e.target.value)}
      />

      {/* 完整模型列表（不做截断） */}
      <div className="platform-model-list">
        {filtered.length === 0 && (
          <div className="empty-state"><p>{t('models.noMatch')}</p></div>
        )}
        {filtered.map(r => {
          const pi = fmtPrice(r.pricing?.prompt);
          const po = fmtPrice(r.pricing?.completion);
          const isOpen = expanded.has(r.id);
          return (
            <div
              key={r.id}
              className={`platform-model-row${isOpen ? ' platform-model-row--open' : ''}`}
              onClick={() => setExpanded(prev => {
                const n = new Set(prev);
                n.has(r.id) ? n.delete(r.id) : n.add(r.id);
                return n;
              })}
            >
              <div className="platform-model-row-head">
                <span className={`model-card-mod model-card-mod--${r.modality}`}>{MOD_LABEL[r.modality] || r.modality}</span>
                <span className="platform-model-id"><code>{r.id}</code></span>
                {r.isFlagship && <span className="platform-model-flag">{t('models.isFlagship')}</span>}
                {r.ctx && <span className="platform-model-ctx">{Math.round(r.ctx / 1024)}K</span>}
                <span className="platform-model-price">
                  {pi > 0 ? `$${pi.toFixed(2)}/M in` : ''}
                  {po > 0 ? ` · $${po.toFixed(2)}/M out` : ''}
                </span>
                {!r.key && <span className="platform-model-nodata-tag">{t('models.noParamData')}</span>}
                {r.availability.length > 0 && (
                  <span className="platform-model-nodata-tag">
                    {r.availability.some((item: any) => item.executionMode === 'agent_native')
                      ? t('models.sourceAgentNative')
                      : r.availability.flatMap((item: any) => item.endpointIds || (item.endpointId ? [item.endpointId] : []))
                          .map((endpointId: string) => endpointById.get(endpointId))
                          .filter(Boolean)
                          .map((endpoint: any) => `${endpoint.protocol.family} · ${endpoint.baseUrl}`)
                          .join(', ') || t('models.sourceUnknown')}
                  </span>
                )}
                <span className="platform-model-chevron">▾</span>
              </div>
              {isOpen && (
                <div className="platform-model-detail">
                  <div className="model-info-grid platform-model-params">
                    <div className="model-info-card">
                      <div className="model-info-label">{t('models.infoContext')}</div>
                      <div className="model-info-value">{r.ctx ? `${Math.round(r.ctx / 1024)}K` : '—'}</div>
                    </div>
                    <div className="model-info-card">
                      <div className="model-info-label">{t('models.inputPrice')}</div>
                      <div className="model-info-value">{!Object.prototype.hasOwnProperty.call(r.pricing || {}, 'prompt') ? '—' : pi > 0 ? <span className="model-info-price">${pi.toFixed(2)}<span className="model-info-unit">/M</span></span> : t('common.free')}</div>
                    </div>
                    <div className="model-info-card">
                      <div className="model-info-label">{t('models.outputPrice')}</div>
                      <div className="model-info-value">{!Object.prototype.hasOwnProperty.call(r.pricing || {}, 'completion') ? '—' : po > 0 ? <span className="model-info-price">${po.toFixed(2)}<span className="model-info-unit">/M</span></span> : t('common.free')}</div>
                    </div>
                    <div className="model-info-card">
                      <div className="model-info-label">{t('models.modality')}</div>
                      <div className="model-info-value">{MOD_LABEL[r.modality] || r.modality}</div>
                    </div>
                    <div className="model-info-card">
                      <div className="model-info-label">{t('models.vendorFamily')}</div>
                      <div className="model-info-value">{r.vendorFamily || '—'}</div>
                    </div>
                    <div className="model-info-card">
                      <div className="model-info-label">{t('models.isFlagship')}</div>
                      <div className="model-info-value">{r.isFlagship ? '✓' : '—'}</div>
                    </div>
                    <div className="model-info-card">
                      <div className="model-info-label">{t('models.released')}</div>
                      <div className="model-info-value">{r.created ? fmtTimeAgo(r.created) : '—'}</div>
                    </div>
                    <div className="model-info-card">
                      <div className="model-info-label">{t('models.otherPlatforms')}</div>
                      <div className="model-info-value">{r.otherPlatforms.length ? r.otherPlatforms.join(' · ') : '—'}</div>
                    </div>
                  </div>
                  {!r.key && (
                    <div className="platform-model-nodata">
                      {t('models.noParamDataHint')}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// 模型本体卡片网格（模型视角默认）：按主厂商分组 + 按发布时间倒序 + 隐藏老旧
const PROVIDER_LABELS: Record<string, string> = {
  'openai': 'OpenAI',
  'anthropic': 'Anthropic',
  'x-ai': 'xAI',
  'mistralai': 'Mistral',
  'meta-llama': 'Meta',
  'qwen': 'Qwen · 阿里',
  'deepseek': 'DeepSeek',
  'moonshotai': 'Moonshot · 月之暗面',
  'minimax': 'MiniMax · 稀宇科技',
  'z-ai': '智谱 Z.AI',
  'stepfun': '阶跃星辰',
  'tencent': '腾讯混元',
  'baidu': '百度文心',
  'siliconflow': '硅基流动',
  'xiaomi': '小米 MiMo',
  'meituan': '美团 LongCat',
  'inclusionai': '阿里云',
  'nex-agi': 'Nex AGI',
  'cohere': 'Cohere',
  'perplexity': 'Perplexity',
  'amazon': 'Amazon',
  'microsoft': 'Microsoft',
  'nvidia': 'NVIDIA',
  'kwaipilot': '快手 Kwai',
  'bytedance': '字节 Seed',
  'sao10k': 'Sao10K',
  'unknown': '其他',
};

// 模型视角共享过滤：groupChips 的数量统计与 ModelGrid 渲染必须用同一套条件，否则 chip 数量与实际渲染对不上
function filterModelEntries(
  entries: [string, any[]][],
  opts: {
    hideLegacy: boolean;
    activeProtocol: string | null;
    activeModality?: string | null;
    searchQuery: string;
    providers: Provider[];
    activeProvider?: string | null;
  }
): [string, any[]][] {
  let res = entries;
  if (opts.hideLegacy) {
    res = res.filter(([, e]) => !e.some((x: any) => x.legacy));
  }
  if (opts.activeModality) {
    res = res.filter(([, e]) => e.some((x: any) => (x.modality || 'text') === opts.activeModality));
  }
  if (opts.activeProtocol) {
    res = res.filter(([, e]) => e.some((x: any) => {
      const pr = opts.providers.find((p) => p.id === x.platform);
      return pr && providerProtocols(pr).includes(opts.activeProtocol as string);
    }));
  }
  if (opts.searchQuery.trim()) {
    const q = opts.searchQuery.toLowerCase();
    res = res.filter(([k]) => k.toLowerCase().includes(q));
  }
  if (opts.activeProvider) {
    res = res.filter(([, e]) => (e[0]?.primary_provider || 'unknown') === opts.activeProvider);
  }
  return res;
}

function fmtTimeAgo(ts: number): string {
  if (!ts) return '';
  const now = Date.now() / 1000;
  const diff = now - ts;
  if (diff < 0) return 'future';
  if (diff < 60 * 60 * 24 * 30) return `${Math.floor(diff / 86400)}d`;
  if (diff < 60 * 60 * 24 * 365) return `${Math.floor(diff / 2592000)}mo`;
  return `${Math.floor(diff / 31536000)}y`;
}

function ModelGrid({ models, providers, authMap, activeModel: _activeModel, searchQuery: _sq, onSelect, t, activeProvider, hideLegacy, activeProtocol, activeModality }: {
  models: [string, any[]][];
  providers: Provider[];
  authMap: Record<string, AuthState>;
  activeModel: string | null;
  searchQuery: string;
  onSelect: (k: string) => void;
  t: (k: string, ...args: any[]) => string;
  activeProvider: string | null;
  hideLegacy: boolean;
  activeProtocol: string | null;
  activeModality: string | null;
}) {
  // 与厂商 chip 数量统计用同一套过滤条件，保证数量一致
  const filtered = filterModelEntries(models, { hideLegacy, activeProtocol, activeModality, searchQuery: _sq, providers, activeProvider });
  if (filtered.length === 0) {
    return <div className="empty-state"><p>{t('models.noMatch')}</p></div>;
  }
  const fmtPrice = (raw: string | undefined): number => {
    if (!raw || raw === '0') return 0;
    const n = parseFloat(raw);
    return isNaN(n) ? 0 : n * 1e6;
  };

  // 按厂商分组
  const grouped: Record<string, [string, any[]][]> = {};
  for (const [key, entries] of filtered) {
    const pp = entries[0]?.primary_provider || 'unknown';
    if (!grouped[pp]) grouped[pp] = [];
    grouped[pp].push([key, entries]);
  }

  // 每组内按 created 倒序
  for (const pp of Object.keys(grouped)) {
    grouped[pp].sort((a, b) => (b[1][0]?.created || 0) - (a[1][0]?.created || 0));
  }

  // 厂商排序（按模型数量）
  const sortedGroups = Object.entries(grouped).sort((a, b) => b[1].length - a[1].length);

  return (
    <div className="model-compare-list">
      {sortedGroups.map(([pp, items]) => (
        <section key={pp} className="model-compare-group">
          <div className="model-compare-group-head">
            <h3>{PROVIDER_LABELS[pp] || pp}</h3>
            <span>{items.length}</span>
          </div>
          <div className="model-compare-columns" aria-hidden="true">
            <span>{t('models.modelId')}</span>
            <span>{t('models.modality')}</span>
            <span>{t('models.contextLabel')}</span>
            <span>{t('models.platforms')}</span>
            <span>{t('models.price')}</span>
            <span>{t('models.authReady')}</span>
            <span />
          </div>
          <div className="model-compare-rows">
            {items.map(([key, entries]) => {
              const platforms = [...new Set(entries.map((e: any) => e.platform))];
              const ctxEntry = entries.find((e: any) => e.context);
              const ctx = ctxEntry?.context;
              const minIn = Math.min(...entries.map((e: any) => fmtPrice(e.pricing?.prompt)).filter(n => n > 0), Infinity);
              const minOut = Math.min(...entries.map((e: any) => fmtPrice(e.pricing?.completion)).filter(n => n > 0), Infinity);
              const authedCount = platforms.filter((pid: any) => {
                const provider = providers.find(p => p.id === pid);
                return runtimeAuthReady(provider, provider ? authMap[provider.id] : undefined);
              }).length;
              const created = entries[0]?.created || 0;
              const isLegacy = entries.some((e: any) => e.legacy);
              const mod = entries[0]?.modality || 'text';
              const MOD_LABEL: Record<string, string> = {
                text: t('models.modText'), image: t('models.modImage'), video: t('models.modVideo'),
                audio: t('models.modAudio'), '3d': t('models.mod3d'), omni: t('models.modOmni'),
              };
              return (
                <article
                  key={key}
                  className={`model-compare-row${isLegacy ? ' model-compare-row--legacy' : ''}`}
                  onClick={() => onSelect(key)}
                >
                  <div className="model-compare-name">
                    <strong>{key}</strong>
                    {created > 0 && (
                      <span className="model-compare-age">
                        {fmtTimeAgo(created)}
                      </span>
                    )}
                  </div>
                  <span className="model-compare-modality">{MOD_LABEL[mod] || mod}</span>
                  <span className="model-compare-context">{ctx ? `${Math.round(ctx / 1024)}K` : '—'}</span>
                  <span className="model-compare-platform-count">{platforms.length}</span>
                  <span className="model-compare-price">
                    {isFinite(minIn) ? `$${minIn.toFixed(2)} in` : '—'}
                    {isFinite(minOut) && <small>${minOut.toFixed(2)} out</small>}
                  </span>
                  <span className={`model-compare-auth model-compare-auth--${authedCount === platforms.length ? 'all' : authedCount > 0 ? 'part' : 'none'}`}>
                    <i />{authedCount}/{platforms.length}
                  </span>
                  <span className="model-compare-open">›</span>
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function ActionMenu({ actions, onClose }: { actions: { label: string; onClick: () => void; danger?: boolean; disabled?: boolean }[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [onClose]);
  return (
    <div ref={ref} className="action-menu" role="menu" onClick={e => e.stopPropagation()}>
      {actions.map((a, i) => (
        <button
          key={i}
          className={`action-menu-item${a.danger ? ' action-menu-item--danger' : ''}`}
          onClick={a.onClick}
          disabled={a.disabled}
          role="menuitem"
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

/* --- Provider Form Modal --- */
function ProviderForm({ provider, platform, onSelectOffering, onOAuthLogin, oauthLoggedIn, oauthLoggingIn, onSave, onClose }: {
  provider: Provider | null;
  platform: Platform | null;
  onSelectOffering: (providerId: string) => void;
  onOAuthLogin: (providerId: string) => void;
  oauthLoggedIn: boolean;
  oauthLoggingIn: boolean;
  onSave: (data: any) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const isAgentNative = provider?.executionMode === 'agent_native';
  const isCustomProvider = !provider || !PRESET_PROVIDER_IDS.has(provider.id);
  const [editorPane, setEditorPane] = useState<'connection' | 'models'>('connection');
  const [modelQuery, setModelQuery] = useState('');
  const [name, setName] = useState(provider?.name || '');
  const [endpoints, setEndpoints] = useState<ProviderEndpoint[]>(
    (isAgentNative ? [] : (provider?.endpoints || (provider ? [{ type: provider.type, baseUrl: provider.baseUrl }] : [createOpenAIEndpoint()]))).map(normalizeEndpoint)
  );
  const [models, setModels] = useState<ProviderModel[]>(
    provider?.models?.map(m => ({ ...m })) || []
  );
  const [vaultKey, setVaultKey] = useState(provider?.vaultKey || '');

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusable = () => Array.from(panel?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [href]') || []);
    const frame = requestAnimationFrame(() => focusable()[0]?.focus());
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (panel?.querySelector('.vault-picker')) return;
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      previousFocusRef.current?.focus();
    };
  }, []);
  const [authMode, setAuthMode] = useState<'api_key' | 'oauth' | 'both' | 'none'>(
    (provider?.authMode as any) || 'api_key'
  );
  const [showVaultPicker, setShowVaultPicker] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionResults, setConnectionResults] = useState<{ success: boolean; message: string }[] | null>(null);
  type ConnectionState = 'idle' | 'testing' | 'success' | 'failure';
  const [connectionState, setConnectionState] = useState<ConnectionState>(
    provider?.authVerified === true ? 'success' : provider?.authVerified === false ? 'failure' : 'idle'
  );
  const [pulledModelCount, setPulledModelCount] = useState(0);
  // A new provider must be explicitly tested. Existing providers keep their
  // historical status until the key or endpoint configuration is changed.
  const [editorDirty, setEditorDirty] = useState(!provider);

  function markConnectionDirty() {
    setEditorDirty(true);
    setConnectionState('idle');
    setConnectionResults(null);
    setPulledModelCount(0);
  }

  function currentOfferingPlan(): ProviderEndpoint['plan'] {
    const endpointPlan = endpoints.find(endpoint => endpoint.plan)?.plan;
    if (endpointPlan) return endpointPlan;
    const offering = platform?.offerings.find(item => item.providerId === provider?.id);
    if (offering?.type === 'coding_plan') return 'coding';
    if (offering?.type === 'token_plan') return 'token';
    if (offering?.type === 'agent_plan') return 'agent';
    if (offering?.type === 'go_plan') return 'go';
    return undefined;
  }

  function addEndpoint() {
    const endpoint = createOpenAIEndpoint();
    const plan = currentOfferingPlan();
    setEndpoints([...endpoints, plan ? { ...endpoint, plan } : endpoint]);
    markConnectionDirty();
  }

  function removeEndpoint(i: number) {
    if (endpoints.length <= 1) return;
    setEndpoints(endpoints.filter((_, idx) => idx !== i));
    markConnectionDirty();
  }

  function withEndpointField(endpoint: ProviderEndpoint, field: keyof ProviderEndpoint, value: string) {
    const updated = { ...endpoint, [field]: value };
    if (field === 'type') {
      if (value === 'openai') updated.protocol = updated.protocol || 'chat';
      else delete updated.protocol;
    }
    return normalizeEndpoint(updated as ProviderEndpoint);
  }

  function updateEndpoint(i: number, field: keyof ProviderEndpoint, value: string) {
    const next = [...endpoints];
    next[i] = withEndpointField(next[i], field, value);
    setEndpoints(next);
    markConnectionDirty();
  }

  function updateEndpointGroup(indexes: number[], field: keyof ProviderEndpoint, value: string) {
    const indexSet = new Set(indexes);
    setEndpoints(endpoints.map((endpoint, index) =>
      indexSet.has(index) ? withEndpointField(endpoint, field, value) : endpoint
    ));
    markConnectionDirty();
  }

  function removeEndpointGroup(indexes: number[]) {
    if (endpoints.length <= indexes.length) return;
    const indexSet = new Set(indexes);
    setEndpoints(endpoints.filter((_, index) => !indexSet.has(index)));
    markConnectionDirty();
  }

  function addModel() {
    setModels([...models, { id: '' }]);
    setEditorDirty(true);
  }

  function removeModel(i: number) {
    setModels(models.filter((_, idx) => idx !== i));
    setEditorDirty(true);
  }

  function updateModelParameter(i: number, value: string) {
    const next = [...models];
    const current = next[i];
    next[i] = {
      ...current,
      id: value,
      // Synced records often use the request parameter as their display name.
      // Keep those values aligned, while preserving a real custom display name.
      name: !current.name || current.name === current.id ? (value || undefined) : current.name,
    };
    setModels(next);
    setEditorDirty(true);
  }

  async function handleTestConnection() {
    const validEndpoints = endpoints.map(normalizeEndpoint).filter(ep => ep.baseUrl.trim());
    if (validEndpoints.length === 0 || !vaultKey.trim()) {
      setConnectionState('failure');
      setConnectionResults([{ success: false, message: t('models.testConnRequired') }]);
      return;
    }

    setTestingConnection(true);
    setConnectionState('testing');
    setConnectionResults([]);
    const results: { success: boolean; message: string }[] = [];
    try {
      for (const ep of validEndpoints) {
        try {
          const result = await api('/api/vault/test-key', {
            method: 'POST',
            body: JSON.stringify({
              baseUrl: ep.baseUrl,
              type: ep.type,
              protocol: ep.protocol,
              vaultKey: vaultKey.trim(),
            }),
          }) as { success: boolean; message: string };
          results.push({ success: Boolean(result.success), message: result.message });
        } catch (err: any) {
          results.push({ success: false, message: err.message || t('models.testFailed') });
        }
        setConnectionResults([...results]);
      }

      const allOk = results.length === validEndpoints.length && results.every(result => result.success);
      let pulledCount = 0;
      if (allOk) {
        try {
          const modelResult = await fetchModels(provider?.id, {
            endpoints: validEndpoints,
            vaultKey: vaultKey.trim(),
          });
          if (modelResult.success && modelResult.models?.length) {
            pulledCount = modelResult.models.length;
            setModels(modelResult.models.map(m => ({ id: m.id, name: m.name || m.id })));
            setEditorDirty(true);
          }
        } catch {
          // Connection state remains green; model discovery is best effort.
        }
      }
      setPulledModelCount(pulledCount);
      setConnectionState(allOk ? 'success' : 'failure');
    } finally {
      setTestingConnection(false);
    }
  }

  const connectionTitle = connectionState === 'testing'
    ? t('models.connectionTesting')
    : connectionState === 'success'
      ? (pulledModelCount > 0 ? t('models.connectionModelsPulled', { n: pulledModelCount }) : t('models.connectionSuccess'))
      : connectionState === 'failure'
        ? `${t('models.connectionFailure')}: ${connectionResults?.find(result => !result.success)?.message || t('models.testFailed')}`
        : t('models.connectionIdle');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const validModels = models.filter(m => m.id.trim());
    const validEndpoints = endpoints.map(normalizeEndpoint).filter(ep => ep.baseUrl.trim());
    const primary = validEndpoints[0] || (provider
      ? { type: provider.type, baseUrl: provider.baseUrl }
      : normalizeEndpoint(endpoints[0]));
    onSave({
      id: provider?.id || name.toLowerCase().replace(/\s+/g, '-'),
      name,
      type: primary.type,
      baseUrl: primary.baseUrl,
      endpoints: validEndpoints,
      models: validModels,
      vaultKey: vaultKey.trim() || undefined,
      authMode,
      executionMode: provider?.executionMode || 'http_endpoint',
      nativeAgentIds: provider?.nativeAgentIds,
    });
  }

  const providerDocs = provider ? getProviderDocs(provider.id) : null;
  const providerDocsLabelKeys: Record<ProviderDocsKind, string> = {
    api: 'models.providerDocsApi',
    coding_plan: 'models.providerDocsCodingPlan',
    token_plan: 'models.providerDocsTokenPlan',
    agent_plan: 'models.providerDocsAgentPlan',
    agent_subscription: 'models.providerDocsAgentSubscription',
    go_plan: 'models.providerDocsGoPlan',
    local: 'models.providerDocsLocal',
  };
  const visibleModels = models
    .map((model, index) => ({ model, index }))
    .filter(({ model }) => {
      const query = modelQuery.trim().toLowerCase();
      return !query || model.id.toLowerCase().includes(query) || (model.name || '').toLowerCase().includes(query);
    });
  const endpointEditorGroups = (() => {
    if (isCustomProvider) return endpoints.map((endpoint, index) => ({ endpoint, indexes: [index] }));
    const groups: { endpoint: ProviderEndpoint; indexes: number[] }[] = [];
    const groupByAddress = new Map<string, number>();
    endpoints.forEach((endpoint, index) => {
      // Built-in platforms may support Chat and Responses through the same
      // OpenAI-compatible base URL. They are one connection in the editor,
      // while the underlying protocol-specific routes remain intact.
      const normalizedBaseUrl = endpoint.baseUrl.trim();
      const key = normalizedBaseUrl
        ? `${endpoint.type}\u0000${normalizedBaseUrl}\u0000${endpoint.plan || ''}`
        : `new-endpoint\u0000${index}`;
      const groupIndex = groupByAddress.get(key);
      if (groupIndex === undefined) {
        groupByAddress.set(key, groups.length);
        groups.push({ endpoint, indexes: [index] });
      } else {
        groups[groupIndex].indexes.push(index);
      }
    });
    return groups;
  })();

  return (
    <>
    <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={panelRef}
        className={`modal-panel modal-panel--wide provider-form-panel provider-form-panel--${editorPane}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-editor-title"
      >
        <form onSubmit={handleSubmit}>
          <div className="provider-editor-layout">
            <section className="provider-editor-main">
              <div className="provider-editor-header">
                <div>
                  <div className="provider-editor-context">
                    {provider && getProviderIcon(provider.id) && <img src={getProviderIcon(provider.id)} alt="" className={getProviderIconClass(provider.id)} />}
                    <strong>{platform?.name || provider?.name || t('models.newPlatform')}</strong>
                    {platform && platform.offerings.length > 1 && (
                      <div className="provider-editor-offering-switch" aria-label={t('models.totalOfferings')}>
                        {platform.offerings.map(offering => (
                          <button
                            type="button"
                            key={offering.id}
                            className={offering.providerId === provider?.id ? 'active' : ''}
                            onClick={() => onSelectOffering(offering.providerId)}
                          >
                            {offering.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <h2 id="provider-editor-title">{editorPane === 'connection' ? t('models.editorConnection') : t('models.modelsSection')}</h2>
                  <p>{editorPane === 'connection' ? t('models.editorConnectionHint') : t('models.editorModelsHint')}</p>
                </div>
                <div className="provider-editor-header-actions">
                  {providerDocs && (
                    <div className="provider-docs-actions">
                      <a href={providerDocs.url} target="_blank" rel="noopener noreferrer" className="provider-docs-link">
                        {t(providerDocsLabelKeys[providerDocs.kind])} ↗
                      </a>
                      {providerDocs.consoleUrl && (
                        <a href={providerDocs.consoleUrl} target="_blank" rel="noopener noreferrer" className="provider-docs-link provider-console-link">
                          {providerDocs.consoleLabelKey ? t(providerDocs.consoleLabelKey) : t('models.providerConsole')} ↗
                        </a>
                      )}
                    </div>
                  )}
                  <button type="button" className="provider-editor-close" onClick={onClose} aria-label={t('common.close')}>×</button>
                </div>
              </div>

              <nav className="provider-editor-nav" aria-label={t('models.editorSections')}>
                <button type="button" className={editorPane === 'connection' ? 'active' : ''} onClick={() => setEditorPane('connection')}>
                  <span className="provider-editor-nav-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 12h8M12 8v8"/><circle cx="12" cy="12" r="8"/></svg></span>
                  <span className="provider-editor-nav-copy"><strong>{t('models.editorConnection')}</strong><small>{t('models.editorConnectionHint')}</small></span>
                </button>
                <button type="button" className={editorPane === 'models' ? 'active' : ''} onClick={() => setEditorPane('models')}>
                  <span className="provider-editor-nav-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v5H4zM4 14h16v5H4z"/></svg></span>
                  <span className="provider-editor-nav-copy"><strong>{t('models.modelsSection')}</strong><small>{models.length} {t('models.totalModels')}</small></span>
                </button>
              </nav>

              {providerDocs?.setupHintKey && (
                <div className="provider-setup-hint">
                  <span className="provider-setup-hint-mark" aria-hidden="true">i</span>
                  <span>{t(providerDocs.setupHintKey)}</span>
                </div>
              )}

              <main className="provider-editor-content">
              {editorPane === 'connection' && (
                <>
                  {!provider && !isAgentNative && (
                    <label className="provider-editor-field">
                      <span>{t('common.name')}</span>
                      <input className="vault-input" value={name} onChange={event => setName(event.target.value)} required autoFocus />
                    </label>
                  )}

                  {isAgentNative ? (
                    <div className="provider-editor-native-note">
                      <span>OAuth</span>
                      <div>
                        <strong>{t('models.agentNativeTitle')}</strong>
                        <p>{t('models.agentNativeEditorHint', { agents: provider?.nativeAgentIds?.join(', ') || '—' })}</p>
                        <div className="provider-editor-native-actions">
                          <span className={`provider-editor-native-status${oauthLoggedIn ? ' is-authed' : ''}`}>
                            {oauthLoggedIn ? t('models.statusAuthed') : t('models.statusUnauthed')}
                          </span>
                          <button
                            type="button"
                            className="provider-editor-native-login"
                            onClick={() => provider && onOAuthLogin(provider.id)}
                            disabled={!provider || oauthLoggingIn}
                          >
                            {oauthLoggingIn ? t('models.testingConn') : t('models.authModeOAuth')}
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      <section className="provider-editor-block">
                        <div className="provider-editor-block-title">
                          <div><strong>{t('models.endpoint')}</strong><span>{t('models.editorEndpointHint')}</span></div>
                          <button type="button" onClick={addEndpoint}>＋ {t('models.addEndpoint')}</button>
                        </div>
                        <div className="endpoint-list">
                          {endpointEditorGroups.map(({ endpoint, indexes }, groupIndex) => (
                            <div key={indexes.map((index) => endpoints[index].id ?? `endpoint-${index}`).join(':')} className={`endpoint-row endpoint-row--${endpoint.type}`}>
                              <span className="provider-editor-row-index">{String(groupIndex + 1).padStart(2, '0')}</span>
                              <CustomSelect className="endpoint-type-select" dropdownMode="local" value={endpoint.type} onChange={value => updateEndpointGroup(indexes, 'type', value)} options={TYPE_OPTIONS} />
                              <input className="vault-input endpoint-url-input" value={endpoint.baseUrl} onChange={event => updateEndpointGroup(indexes, 'baseUrl', event.target.value)} placeholder="https://api.example.com" aria-label={`${t('models.endpoint')} ${groupIndex + 1}`} required />
                              {endpointEditorGroups.length > 1 && <button type="button" className="endpoint-remove-btn" onClick={() => removeEndpointGroup(indexes)}>×</button>}
                            </div>
                          ))}
                        </div>
                        {isCustomProvider && endpoints.some(endpoint => endpoint.type === 'openai') && (
                          <details className="provider-editor-advanced">
                            <summary>
                              <span>{t('models.advancedProtocol')}</span>
                              <small>{t('models.advancedProtocolHint')}</small>
                            </summary>
                            <div className="provider-editor-advanced-list">
                              {endpoints.map((endpoint, index) => endpoint.type === 'openai' && (
                                <label key={endpoint.id || index} className="provider-editor-advanced-row">
                                  <span>{t('models.endpoint')} {String(index + 1).padStart(2, '0')}</span>
                                  <CustomSelect dropdownMode="local" value={endpoint.protocol || 'chat'} onChange={value => updateEndpoint(index, 'protocol', value)} options={OPENAI_PROTOCOL_OPTIONS} />
                                </label>
                              ))}
                            </div>
                          </details>
                        )}
                      </section>

                      <section className="provider-editor-block">
                        <div className="provider-editor-block-title">
                          <div><strong>{t('models.authSection')}</strong><span>{t('models.editorAuthHint')}</span></div>
                          <div className="provider-editor-auth-toggle">
                            {isCustomProvider ? (
                              <>
                                <button type="button" className={authMode !== 'none' ? 'active' : ''} onClick={() => { setAuthMode('api_key'); markConnectionDirty(); }}>API Key</button>
                                <button type="button" className={authMode === 'none' ? 'active' : ''} onClick={() => { setAuthMode('none'); markConnectionDirty(); }}>{t('models.authModeNone')}</button>
                              </>
                            ) : (
                              <span className={`provider-editor-auth-method${authMode === 'none' ? ' provider-editor-auth-method--none' : ''}`}>
                                {authMode === 'none' ? t('models.authModeNone') : 'API Key'}
                              </span>
                            )}
                          </div>
                        </div>
                        {authMode !== 'none' && (
                          <div className="provider-secret-field settings-workspace settings-workspace--light">
                            <div className="settings-field--secret">
                              <label>{t('models.keyReference')}</label>
                              <div className="vault-ref-field">
                                {vaultKey ? (
                                  <div className="vault-ref-selected">
                                    <span className="vault-ref-key">{vaultKey}</span>
                                    <button type="button" className="vault-ref-clear" onClick={() => { setVaultKey(''); markConnectionDirty(); }}>×</button>
                                    <button type="button" className="vault-ref-change" onClick={() => setShowVaultPicker(true)}>{t('common.replace')}</button>
                                    <button type="button" className={`provider-auth-connection-btn provider-auth-connection-btn--${connectionState}`} onClick={handleTestConnection} disabled={testingConnection || !endpoints.some(ep => ep.baseUrl.trim())} title={connectionTitle} aria-label={connectionTitle}>
                                      {testingConnection ? <span className="provider-auth-connection-spinner" aria-hidden="true">↻</span> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.07.07l2-2a5 5 0 0 0-7.07-7.07l-1.14 1.14"/><path d="M14 11a5 5 0 0 0-7.07-.07l-2 2A5 5 0 0 0 7 20l1.14-1.14"/></svg>}
                                    </button>
                                  </div>
                                ) : (
                                  <button type="button" className="vault-ref-trigger" onClick={() => setShowVaultPicker(true)}>{t('models.selectFromVault')}</button>
                                )}
                              </div>
                            </div>
                            <p className="provider-auth-hint">{provider?.id === 'qianfan-coding' ? t('models.qianfanCodingKeyHint') : connectionTitle}</p>
                          </div>
                        )}
                        {authMode === 'none' && (
                          <p className="provider-editor-no-auth-hint">
                            {isCustomProvider ? t('models.noAuthCustomHint') : t('models.noAuthPresetHint')}
                          </p>
                        )}
                      </section>
                    </>
                  )}
                </>
              )}

              {editorPane === 'models' && (
                <>
                  <div className="provider-editor-model-toolbar">
                    <input className="vault-input" type="search" value={modelQuery} onChange={event => setModelQuery(event.target.value)} placeholder={t('models.searchModels')} />
                    <button type="button" onClick={addModel}>＋ {t('models.addModel')}</button>
                  </div>
                  <div className="provider-editor-model-head" aria-hidden="true">
                    <span />
                    <div><strong>{t('models.modelParameterName')}</strong><small>{t('models.modelParameterHint')}</small></div>
                    <span />
                  </div>
                  <div className="model-form-list provider-editor-model-list">
                    {visibleModels.length === 0 ? (
                      <div className="model-form-empty">{models.length === 0 ? t('common.notConfigured') : t('models.noMatch')}</div>
                    ) : visibleModels.map(({ model, index }) => (
                      <div key={`${model.id}-${index}`} className="model-form-row">
                        <span className="provider-editor-row-index">{String(index + 1).padStart(2, '0')}</span>
                        <input className="vault-input model-form-id" value={model.id} onChange={event => updateModelParameter(index, event.target.value)} placeholder={t('models.modelParameterExample')} aria-label={t('models.modelParameterName')} />
                        <button type="button" className="endpoint-remove-btn" onClick={() => removeModel(index)}>×</button>
                      </div>
                    ))}
                  </div>
                </>
              )}
              </main>

              <div className="modal-actions">
                <span className="provider-editor-save-hint">{editorDirty ? t('models.editorUnsaved') : t('models.editorSavedState')}</span>
                <button type="button" className="btn-cancel" onClick={onClose}>{t('common.cancel')}</button>
                <button type="submit" className="btn-save">{t('common.save')}</button>
              </div>
            </section>
          </div>
        </form>
      </div>
    </div>

    {showVaultPicker && (
      <div className="settings-workspace settings-workspace--light">
      <VaultPickerModal
        selected={vaultKey}
        onSelect={key => { setVaultKey(key); markConnectionDirty(); setShowVaultPicker(false); }}
        onClose={() => setShowVaultPicker(false)}
        testEndpoint={endpoints[0]?.baseUrl ? { baseUrl: endpoints[0].baseUrl, type: endpoints[0].type, protocol: endpointProtocol(endpoints[0]) } : undefined}
      />
      </div>
    )}
    </>
  );
}
