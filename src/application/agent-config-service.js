// The one application boundary for Agent configuration changes.  Web handlers,
// the CLI and cloud sync deliberately provide only input/context and call this
// service; routing, authorization and native adapter writes never live in an
// entry point.

function getAgentState(config, agentId) {
  const state = config?.agentProviders?.[agentId];
  return state && typeof state === 'object' ? { ...state, sites: { ...(state.sites || {}) } } : { sites: {} };
}
function setSite(config, agentId, providerId, site) {
  config.agentProviders = config.agentProviders || {};
  const state = config.agentProviders[agentId] || (config.agentProviders[agentId] = { sites: {} });
  state.sites = state.sites || {};
  state.sites[providerId] = { modelIds: [...new Set((site?.modelIds || []).filter(id => typeof id === 'string'))], ...(site?.enabled === undefined ? {} : { enabled: !!site.enabled }), ...(site?.tierMap ? { tierMap: site.tierMap } : {}) };
  return state;
}
function replaceAgentState(config, agentId, state) {
  config.agentProviders = config.agentProviders || {};
  config.agentProviders[agentId] = { ...(state.activeProviderId ? { activeProviderId: state.activeProviderId } : {}), ...(state.activeModelId ? { activeModelId: state.activeModelId } : {}), sites: state.sites || {} };
  return config.agentProviders[agentId];
}
function removeSite(config, agentId, providerId) {
  const state = getAgentState(config, agentId);
  if (!config?.agentProviders?.[agentId]) return state;
  delete config.agentProviders[agentId].sites?.[providerId];
  if (config.agentProviders[agentId].activeProviderId === providerId) { delete config.agentProviders[agentId].activeProviderId; delete config.agentProviders[agentId].activeModelId; }
  if (!Object.keys(config.agentProviders[agentId].sites || {}).length && !config.agentProviders[agentId].activeProviderId) delete config.agentProviders[agentId];
  return state;
}

const ADDITIVE_AGENTS = new Set(['workbuddy', 'zcode', 'kimi-code', 'grok', 'mimo-code', 'opencode']);

function loadRuntime(module) {
  try { return require(`../providers/${module}`); } catch { return require(`../../dist/providers/${module}`); }
}

function defaultDependencies() {
  const routing = loadRuntime('routing');
  const registry = loadRuntime('registry');
  const agents = loadRuntime('agentsMeta');
  const store = loadRuntime('store');
  const snapshots = loadRuntime('snapshots');
  let user;
  try { user = require('../config/user'); } catch { user = require('../../dist/config/user'); }
  return {
    adapters: agents.AGENTS_META,
    getAdapter: registry.getAdapter,
    loadProviders: store.loadProviders,
    loadUserConfig: user.loadUserConfig,
    saveUserConfig: user.saveUserConfig,
    captureSnapshot: snapshots.capturePreSwitchSnapshot,
    restoreSnapshot: snapshots.restoreSnapshot,
    providerSupportsAdapter: routing.providerSupportsAdapter,
    resolveModelRoute: routing.resolveModelRoute,
    resolveModel: routing.resolveModel,
    appendLog: () => {},
    // CLI is intentionally permissive for providers that do not declare an
    // auth requirement. The dashboard injects its full vault verification.
    authorize: async provider => ({ ok: provider.authMode === 'none' || !provider.authMode }),
  };
}

function asError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function createAgentConfigurationService(overrides = {}) {
  // Entrypoints inject their runtime modules so tests and the compiled web
  // bundle share exactly the same seams. Standalone consumers still get a
  // fully functional default implementation.
  const d = { ...defaultDependencies(), ...overrides };
  const adapterMeta = id => (d.adapters || []).find(adapter => adapter.id === id);

  function prepareWrite(provider, agentId, modelId, selectedIds, config, { allowCataloglessModel = false, preserveProviderModels = false } = {}) {
    const meta = adapterMeta(agentId);
    if (!meta) throw asError(`Agent not found: ${agentId}`, 404);
    if (!(provider.models || []).some(model => model.id === modelId)) {
      if (!allowCataloglessModel) throw asError(`Model not found: ${modelId}`, 400, 'MODEL_ROUTE_UNAVAILABLE');
      return { route: { remoteModelId: modelId }, routes: [], provider: { ...provider, models: [] }, resolved: undefined, resolvedById: {} };
    }
    const tiers = agentId === 'claude'
      ? Object.values(getAgentState(config || {}, 'claude').sites?.[provider.id]?.tierMap || {})
      : [];
    const ids = [...new Set([...(selectedIds || []), ...tiers, modelId])]
      .filter(id => (provider.models || []).some(model => model.id === id));
    if (!ids.includes(modelId)) throw asError(`Model not found: ${modelId}`, 400, 'MODEL_ROUTE_UNAVAILABLE');
    const resolvedById = Object.fromEntries(ids.map(id => [
      id, d.resolveModel(provider, id, {}, config?.modelOverrides?.[provider.id]?.[id] || {}),
    ]));
    const routes = ids.map(id => ({ canonicalId: id, route: d.resolveModelRoute(provider, id, meta), resolved: resolvedById[id] }));
    const active = routes.find(item => item.canonicalId === modelId);
    const endpointIds = [...new Set(routes.map(item => item.route.endpointId || 'agent_native'))];
    if (endpointIds.length > 1) throw asError(`${meta.name} 选中的模型路由到不同端点（${endpointIds.join('、')}）；请分别配置站点`, 400, 'MODEL_ROUTE_UNAVAILABLE');
    const routedModels = routes.map(item => ({
      ...provider.models.find(model => model.id === item.canonicalId),
      id: item.route.remoteModelId,
      canonicalId: item.canonicalId,
      resolved: item.resolved,
    }));
    return { route: active.route, routes, provider: preserveProviderModels ? active.route.provider : { ...active.route.provider, models: routedModels }, resolved: resolvedById[modelId], resolvedById };
  }

  async function authorize(provider, providers, write) {
    for (const item of write.routes || []) {
      const result = await d.authorize(provider, providers, item.route.endpointId);
      if (!result?.ok) throw asError(result?.message || '请先完成认证', 401, result?.code || 'AUTH_REQUIRED');
    }
  }

  async function writeNative(agentId, provider, write, before, providerId) {
    const adapter = d.getAdapter(agentId);
    if (!adapter) throw asError(`Adapter not implemented: ${agentId}`, 404);
    if (ADDITIVE_AGENTS.has(agentId)) {
      const previous = getAgentState(before, agentId).sites[providerId];
      if (previous && typeof adapter.removeProvider === 'function') await adapter.removeProvider(providerId);
      if (typeof adapter.applyModels !== 'function') throw asError(`${adapterMeta(agentId).name} 不支持写入多个站点模型`, 400);
      const result = await adapter.applyModels(write.routes.map(({ route }) => ({ provider: write.provider, modelId: route.remoteModelId })));
      if (result?.skipped?.length) throw new Error(`以下模型未写入 ${adapterMeta(agentId).name}: ${result.skipped.join('、')}`);
      return;
    }
    await adapter.applyConfig(write.provider, write.route.remoteModelId, write.resolved, write.resolvedById);
  }

  async function applySelection(input) {
    const { agentId, providerId, source = 'agent-config', persist = true, allowCataloglessModel = false } = input;
    const meta = adapterMeta(agentId);
    if (!meta) throw asError(`Agent not found: ${agentId}`, 404);
    const providers = input.providers || await d.loadProviders();
    const provider = input.provider || providers.find(item => item.id === providerId);
    if (!provider) throw asError(`Provider 不存在: ${providerId}`, 404, 'PROVIDER_NOT_FOUND');
    if (!d.providerSupportsAdapter(provider, meta)) throw asError(`${meta.name} 不支持 ${provider.type} 协议的站点`, 400, 'UNSUPPORTED_PROVIDER');
    const before = input.config || await d.loadUserConfig();
    const requestedIds = Array.isArray(input.modelIds) ? input.modelIds : [];
    const selectedIds = [...new Set(requestedIds.filter(id => typeof id === 'string'))]
      .filter(id => allowCataloglessModel || (provider.models || []).some(model => model.id === id));
    const primaryModelId = selectedIds.includes(input.primaryModelId) ? input.primaryModelId : selectedIds[0];
    if (!primaryModelId) {
      if (requestedIds.length) throw asError(`Model not found: ${input.primaryModelId || requestedIds[0]}`, 400, 'MODEL_NOT_FOUND');
      throw asError('请至少选择一个模型再保存', 400);
    }
    const write = prepareWrite(provider, agentId, primaryModelId, selectedIds, before, { allowCataloglessModel, preserveProviderModels: input.preserveProviderModels });
    await authorize(provider, providers, write);
    let snapshotId = null;
    try { snapshotId = await d.captureSnapshot(agentId); } catch (error) { console.warn(`[${source}] snapshot failed: ${error.message}`); }
    try {
      await writeNative(agentId, provider, write, before, providerId);
      if (persist) {
        const config = await d.loadUserConfig();
        const state = getAgentState(config, agentId);
        setSite(config, agentId, providerId, {
          modelIds: selectedIds,
          enabled: input.enabled === undefined ? state.sites[providerId]?.enabled !== false : input.enabled,
          tierMap: input.tierMap === undefined ? state.sites[providerId]?.tierMap : input.tierMap,
        });
        const next = getAgentState(config, agentId);
        if (!ADDITIVE_AGENTS.has(agentId) || !next.activeProviderId || !next.activeModelId || input.activate) {
          next.activeProviderId = providerId;
          next.activeModelId = primaryModelId;
          replaceAgentState(config, agentId, next);
        }
        await d.saveUserConfig(config);
      }
    } catch (error) {
      if (snapshotId && typeof d.restoreSnapshot === 'function') {
        try { await d.restoreSnapshot(agentId, snapshotId); } catch (restoreError) { console.warn(`[${source}] restore failed: ${restoreError.message}`); }
      }
      throw error;
    }
    d.appendLog(source, `${agentId}:${providerId}`, true, `models=${selectedIds.length}`);
    return { success: true, agentId, providerId, modelIds: selectedIds, primaryModelId, snapshotAvailable: Boolean(snapshotId), route: write.route };
  }

  async function setClaudeTierMap({ providerId, tierMap, source = 'agent-tier-map' }) {
    const config = await d.loadUserConfig();
    const state = getAgentState(config, 'claude');
    const site = state.sites[providerId];
    if (!site) throw asError('请先添加该 Claude Code 站点', 404);
    const normalized = Object.fromEntries(Object.entries(tierMap || {}).filter(([, id]) => typeof id === 'string' && id));
    setSite(config, 'claude', providerId, { ...site, tierMap: Object.keys(normalized).length ? normalized : undefined });
    // Persist the desired map first. If native reconciliation fails it remains
    // explicit and may be retried by a later sync pull/manual selection.
    await d.saveUserConfig(config);
    if (state.activeProviderId !== providerId || !state.activeModelId) return { success: true, providerId, tierMap: normalized };
    return applySelection({ agentId: 'claude', providerId, modelIds: site.modelIds, primaryModelId: state.activeModelId, tierMap: normalized, source, activate: true });
  }

  function fallbackForAgent(agentId) {
    return { claude: { providerId: 'anthropic-agent', modelId: 'claude-sonnet-4-6' }, codex: { providerId: 'openai-codex', modelId: 'gpt-5.6-sol' } }[agentId] || null;
  }

  async function removeConfiguredSite({ agentId, providerId, source = 'agent-provider-remove', persist = true, config: suppliedConfig, providers: suppliedProviders, allowActiveWithoutFallback = false }) {
    const meta = adapterMeta(agentId);
    if (!meta) throw asError(`Agent not found: ${agentId}`, 404);
    const before = suppliedConfig || await d.loadUserConfig();
    const state = getAgentState(before, agentId);
    if (!state.sites[providerId]) return { success: true, agentId, providerId, unchanged: true };
    const isActive = state.activeProviderId === providerId;
    const fallback = !ADDITIVE_AGENTS.has(agentId) && isActive ? fallbackForAgent(agentId) : null;
    if (!ADDITIVE_AGENTS.has(agentId) && isActive && !fallback && !allowActiveWithoutFallback) throw asError('当前站点正在使用，请先切换到其他站点后再移除', 400);
    const adapter = d.getAdapter(agentId);
    let snapshotId = null;
    try { snapshotId = await d.captureSnapshot(agentId); } catch {}
    try {
      if (typeof adapter?.removeProvider === 'function') await adapter.removeProvider(providerId);
      removeSite(before, agentId, providerId);
      const providers = suppliedProviders || await d.loadProviders();
      const fallbackProvider = fallback && (providers.find(provider => provider.id === fallback.providerId)
        || { id: fallback.providerId, name: fallback.providerId, type: agentId === 'claude' ? 'anthropic' : 'openai', baseUrl: '', authMode: 'none', nativeAgentIds: [agentId], models: [] });
      if (fallbackProvider) {
        await applySelection({ agentId, providerId: fallback.providerId, provider: fallbackProvider, modelIds: [fallback.modelId], primaryModelId: fallback.modelId, config: before, providers, persist: false, allowCataloglessModel: true, source, activate: true });
        setSite(before, agentId, fallback.providerId, { modelIds: [fallback.modelId], enabled: true });
        const next = getAgentState(before, agentId);
        next.activeProviderId = fallback.providerId;
        next.activeModelId = fallback.modelId;
        replaceAgentState(before, agentId, next);
      }
      if (persist) await d.saveUserConfig(before, { removeSite: { agentId, providerId } });
    } catch (error) {
      if (snapshotId && typeof d.restoreSnapshot === 'function') await d.restoreSnapshot(agentId, snapshotId).catch(() => {});
      if (persist) await d.saveUserConfig(suppliedConfig || before).catch(() => {});
      throw error;
    }
    d.appendLog(source, `${agentId}:${providerId}`, true);
    return { success: true, agentId, providerId, snapshotAvailable: Boolean(snapshotId) };
  }

  async function disableConfiguredSite({ agentId, providerId, source = 'agent-provider-disable' }) {
    if (!ADDITIVE_AGENTS.has(agentId)) throw asError(`${agentId} 不支持按站点启停`, 400);
    const config = await d.loadUserConfig();
    const site = getAgentState(config, agentId).sites[providerId];
    if (!site) throw asError('站点未配置', 404);
    const adapter = d.getAdapter(agentId);
    let snapshotId = null;
    try { snapshotId = await d.captureSnapshot(agentId); } catch {}
    try {
      if (typeof adapter?.setProviderEnabled === 'function') await adapter.setProviderEnabled(providerId, false);
      else if (typeof adapter?.removeProvider === 'function') await adapter.removeProvider(providerId);
      else throw asError(`${agentId} adapter 不支持停用站点`, 400);
      setSite(config, agentId, providerId, { ...site, enabled: false });
      await d.saveUserConfig(config);
    } catch (error) {
      if (snapshotId && typeof d.restoreSnapshot === 'function') await d.restoreSnapshot(agentId, snapshotId).catch(() => {});
      throw error;
    }
    d.appendLog(source, `${agentId}:${providerId}`, true);
    return { success: true, agentId, providerId, enabled: false, snapshotAvailable: Boolean(snapshotId) };
  }

  async function reconcile(config) {
    const desired = config || await d.loadUserConfig();
    const results = [];
    for (const [agentId, raw] of Object.entries(desired.agentProviders || {})) {
      const state = getAgentState(desired, agentId);
      const sites = ADDITIVE_AGENTS.has(agentId)
        ? Object.entries(state.sites).filter(([, site]) => site?.enabled !== false)
        : state.activeProviderId && state.sites[state.activeProviderId]
          ? [[state.activeProviderId, state.sites[state.activeProviderId]]]
          : [];
      for (const [providerId, site] of sites) {
        try {
          const result = await applySelection({
            agentId, providerId, modelIds: site.modelIds, primaryModelId: state.activeProviderId === providerId ? state.activeModelId : site.modelIds?.[0],
            config: desired, persist: false, source: 'agent-config-reconcile', tierMap: site.tierMap,
          });
          results.push({ agentId, providerId, success: true, route: result.route });
        } catch (error) {
          // Desired state has already been committed by syncPull. Never roll it
          // back or mark it dirty for upload merely because this host lacks a
          // model/key/agent. A subsequent pull is the deliberate retry queue.
          d.appendLog('agent-config-reconcile', `${agentId}:${providerId}`, false, error.message);
          results.push({ agentId, providerId, success: false, error: error.message, code: error.code });
        }
      }
    }
    // Several legacy adapters still persist their own current-model field as
    // a side effect. Reassert the accepted canonical desired state without
    // scheduling a sync upload, so a remote wire ID can never replace the
    // canonical model ID in user.json on the receiving machine.
    if (typeof d.persistReconciledDesired === 'function') await d.persistReconciledDesired(desired);
    return results;
  }

  return { applySelection, setClaudeTierMap, removeConfiguredSite, disableConfiguredSite, reconcile, prepareWrite };
}

module.exports = { ADDITIVE_AGENTS, createAgentConfigurationService };
