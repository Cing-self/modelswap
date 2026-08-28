import { useCallback, useEffect, useMemo, useState } from 'react';
import { createProvider, deleteProvider, fetchModels, getAuthStatus, listProviders, triggerOAuthLogin, updateProvider, verifyProviderAuth, Provider, Platform } from '../../api/providers';
import { useApp } from '../Layout/AppContext';
import { useI18n } from '../../i18n';
import { useDataChanged } from '../../hooks/useDataChanged';
import { useModelCacheWarmupPending } from '../../hooks/useModelCacheWarmup';
import { crossData, PLATFORM_DEFINITIONS, PROVIDER_FAMILIES, PROVIDER_FAMILY_MAP, PROVIDER_GROUPS, PLAN_FILTERS, providerPlans, providerProtocols, groupOf, filterModelEntries, MODEL_COMPARISON_ENABLED, PLATFORM_DETAIL_ENABLED } from './modelsCatalog';
import type { AuthState, PlanFilter, ProviderFamily, StatusFilter, ViewKey } from './modelsCatalog';
export function useModelsPageState() {
  const { showToast: toast, confirm } = useApp() as any;
  const { t, providerName } = useI18n();
  const warmupPending = useModelCacheWarmupPending();
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
  const [syncingModels, setSyncingModels] = useState<string | null>(null);
  const [actionMenuId, setActionMenuId] = useState<string | null>(null);

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
  useDataChanged(['providers', 'secrets'], load);

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
    try {
      const verification = await verifyProviderAuth(p.id);
      const results = verification.results || [];
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
    // 根据 provider 支持的方式决定默认值
    if (p.authMode === 'oauth') return 'oauth';
    if (p.authMode === 'both' && authMap[p.id]?.oauthLoggedIn === true && !p.vaultKey) return 'oauth';
    if (p.vaultKey) return 'api_key';
    if (p.authMode === 'both') return 'api_key';
    return 'api_key';
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
    for (const group of PROVIDER_GROUPS) {
      for (const id of group.ids) map.set(id, idx++);
    }
    return map;
  }, []);

  const sortedProviders = useMemo(() => [...filteredProviders].sort((a, b) =>
    (providerOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (providerOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER)
      || (a.name || a.id).localeCompare(b.name || b.id, 'zh-Hans-CN')
  ), [filteredProviders, providerOrder]);

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
  return { loading: loading || warmupPending, activePlatform, activeModel, t, providerName, modelStats, authLoaded, authLoadFailed, MODEL_COMPARISON_ENABLED, PLATFORM_DETAIL_ENABLED, view, searchQuery, setSearchQuery, activeModelProvider, setActiveModelProvider, modelVendorOptions, activeModality, setActiveModality, activeProtocol, setActiveProtocol, providers, providerProtocols, hideLegacy, setHideLegacy, filteredComparisonCount, hasComparisonFilters, sortedFamilies, handleAdd, activePlanFilter, setActivePlanFilter, setFamilyPlan, platformPlanOptions, statusFilter, setStatusFilter, platformStatusOptions, crossData, authMap, setActiveModel, sortedProviders, familyPlan, providerPlans, platforms, isAuthed, getCardAuthMethod, isUsedBy, isAuthMethodAuthed, testingConn, setActivePlatform, actionMenuId, setActionMenuId, loggingIn, handleOAuthLogin, handleConnect, syncingModels, handleEdit, handleDelete, showForm, editProvider, setEditProvider, setShowForm, handleFormSave };
}

export type ModelsPageState = ReturnType<typeof useModelsPageState>;
