const { codexEndpointSupport } = (() => {
  try { return require("../providers/mappings/codex-mapping"); }
  catch { return require("../../dist/providers/mappings/codex-mapping"); }
})();

function createProviderStatusService(deps) { const { _store, loadProviders, loadUserConfig, ADAPTERS, ADDITIVE_AGENTS, adapterSupportsProvider, _getAdapter, providerExecutionMode, providerEndpointEntries, buildPlatforms, sortModels, sortProviders, tagRecentModels, enrichCodexOfficialModels, readCodexCachedModels, getAgentState, findCommand, publishDataChanged } = deps;

// Codex requires the OpenAI-Responses wire protocol; surface per-provider
// support so the dashboard can filter the add-site picker and show the
// effective endpoint address.
function codexSiteFields(adapterId, provider) {
  if (adapterId !== 'codex') return {};
  const responsesEp = (provider.endpoints || []).find(ep => ep.type === 'responses');
  if (responsesEp?.baseUrl) return {};
  return codexEndpointSupport(provider.baseUrl).chatOnly ? { codexUnsupported: true } : {};
}
function modelDataSelections(config) {
  const selectedByProvider = new Map();
  for (const [agentId, state] of Object.entries(config.agentProviders || {})) {
    for (const [providerId, site] of Object.entries(state?.sites || {})) {
      const providerEntry = selectedByProvider.get(providerId) || new Map();
      for (const modelId of site?.modelIds || []) {
        const agents = providerEntry.get(modelId) || [];
        if (!agents.includes(agentId)) agents.push(agentId);
        providerEntry.set(modelId, agents);
      }
      selectedByProvider.set(providerId, providerEntry);
    }
  }
  return selectedByProvider;
}

function modelDataSummary(rows) {
  const allModels = rows.flatMap(provider => provider.models);
  return {
    providers: rows.length,
    models: allModels.length,
    withContext: allModels.filter(model => Number.isFinite(model.context)).length,
    withOutput: allModels.filter(model => Number.isFinite(model.output)).length,
    withReasoning: allModels.filter(model => typeof model.reasoning === 'boolean').length,
    withTool: allModels.filter(model => typeof model.tool === 'boolean').length,
    withModalities: allModels.filter(model => model.modalities && typeof model.modalities === 'object').length,
  };
}

function modelDataProviderRow(provider, models, selectedByProvider, catalog = null) {
  const selected = selectedByProvider.get(provider.id) || new Map();
  const decorated = models.map(model => ({ ...model, selectedBy: selected.get(model.id) || [] }));
  const sources = {};
  for (const model of decorated) sources[model.source || 'unknown'] = (sources[model.source || 'unknown'] || 0) + 1;
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type,
    executionMode: provider.executionMode || 'http_endpoint',
    catalog,
    endpoints: provider.executionMode === 'agent_native'
      ? []
      : providerEndpointEntries(provider).map(entry => ({
          id: entry.id,
          type: entry.endpoint.type,
          protocol: entry.endpoint.protocol,
          baseUrl: entry.endpoint.baseUrl,
        })),
    sources,
    models: decorated,
  };
}

function runtimeModelDataRecord(model) {
  const meta = model.meta || {};
  return {
    id: model.id,
    ...(model.name ? { name: model.name } : {}),
    ...(meta.description ? { description: meta.description } : {}),
    ...(meta.family ? { family: meta.family } : {}),
    ...(Number.isFinite(meta.context) ? { context: meta.context } : {}),
    ...(Number.isFinite(meta.input) ? { input: meta.input } : {}),
    ...(Number.isFinite(meta.output) ? { output: meta.output } : {}),
    ...(meta.modalities ? { modalities: meta.modalities } : {}),
    ...(meta.toolCall === undefined ? {} : { tool: meta.toolCall }),
    ...(meta.reasoning === undefined ? {} : { reasoning: meta.reasoning }),
    ...(meta.reasoningOptions ? { reasoningOptions: meta.reasoningOptions } : {}),
    ...(meta.structuredOutput === undefined ? {} : { structuredOutput: meta.structuredOutput }),
    ...(meta.temperature === undefined ? {} : { temperature: meta.temperature }),
    ...(meta.interleaved ? { interleaved: meta.interleaved } : {}),
    ...(meta.knowledge ? { knowledge: meta.knowledge } : {}),
    ...(meta.releaseDate ? { releaseDate: meta.releaseDate } : {}),
    ...(meta.lastUpdated ? { lastUpdated: meta.lastUpdated } : {}),
    ...(meta.openWeights === undefined ? {} : { openWeights: meta.openWeights }),
    ...(meta.status ? { status: meta.status } : {}),
    ...(meta.cost ? { cost: meta.cost } : {}),
    ...(meta.providerConfig ? { providerConfig: meta.providerConfig } : {}),
    ...(meta.experimental ? { experimental: meta.experimental } : {}),
    ...(model.availability ? { availability: model.availability } : {}),
    source: meta.source === 'remote' || model.availability?.some(item => item.source === 'cli')
      ? 'remote'
      : model.origin === 'user' ? 'manual' : 'modelsdev',
    confidence: meta.source === 'modelsdev' ? 'high' : 'medium',
  };
}

async function buildFreshModelDataSnapshot(catalog = null) {
  const [providers, config, modelCache] = await Promise.all([
    loadProviders(),
    loadUserConfig(),
    _store.loadModelsCache(),
  ]);
  const selectedByProvider = modelDataSelections(config);
  const rows = providers.map(provider => modelDataProviderRow(
    provider,
    (provider.models || []).map(runtimeModelDataRecord),
    selectedByProvider,
    catalog ? require('../web/api/models-dev').getFreshProviderMetadata(catalog, provider) : null,
  ));
  return {
    cache: {
      version: modelCache.version,
      source: modelCache.source,
      generation: modelCache.generation,
      sourceFetchedAt: modelCache.sourceFetchedAt,
      cachedAt: modelCache.cachedAt,
      fetchedAt: modelCache.sourceFetchedAt,
      sourceHash: modelCache.sourceHash,
      status: modelCache.status,
      lastError: modelCache.lastError,
      file: _store.providerStorePaths.modelsCache,
    },
    summary: modelDataSummary(rows),
    providers: rows,
  };
}

async function getModelData() {
  try {
    // This diagnostic is strictly read-only. The shared model cache is the
    // same materialized source used by /api/providers and agent pickers.
    return await buildFreshModelDataSnapshot();
  } catch (err) {
    throw Object.assign(new Error(`全新模型数据拉取失败：${err.message}`), { status: 502 });
  }
}

async function refreshModelData() {
  try {
    const catalog = await require('../web/api/models-dev').loadFreshCatalog();
    await _store.refreshModelsFromCatalog(catalog);
    publishDataChanged(['providers']);
    return await buildFreshModelDataSnapshot(catalog);
  } catch (err) {
    throw Object.assign(new Error(`全新模型数据拉取失败：${err.message}`), { status: 502 });
  }
}

async function fetchFreshEndpointModels(endpoint, apiKey) {
  const root = String(endpoint.baseUrl || '').replace(/\/+$/, '');
  if (endpoint.type === 'openai' || endpoint.type === 'responses') {
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const result = await httpReq(`${root}/models`, { method: 'GET', headers, timeout: 10000 });
    if (result.error) throw new Error(result.error);
    if (result.status !== 200) throw new Error(`HTTP ${result.status}`);
    const data = JSON.parse(result.body);
    const list = Array.isArray(data) ? data : data.data;
    return (Array.isArray(list) ? list : []).map(model => normalizeRemoteModel(model)).filter(model => model.id);
  }

  const headers = { 'anthropic-version': '2023-06-01' };
  if (getAnthropicAuthMode(endpoint.baseUrl) === 'bearer') {
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  } else if (/^https?:\/\/api\.minimax(?:i\.com|\.io)\/anthropic\/?$/i.test(String(endpoint.baseUrl || '').trim())) {
    if (apiKey) headers['X-Api-Key'] = apiKey;
  } else if (apiKey) {
    headers['x-api-key'] = apiKey;
  }
  const result = await httpReq(`${root}/v1/models`, { method: 'GET', headers, timeout: 10000 });
  if (result.error) throw new Error(result.error);
  if (result.status !== 200) throw new Error(`HTTP ${result.status}`);
  const data = JSON.parse(result.body);
  return (Array.isArray(data.data) ? data.data : []).map(model => normalizeRemoteModel(model)).filter(model => model.id);
}

function normalizeRemoteModel(model) {
  const context = Number.isFinite(model?.context_length) ? model.context_length
    : Number.isFinite(model?.limit?.context) ? model.limit.context
      : undefined;
  const output = Number.isFinite(model?.top_provider?.max_completion_tokens) ? model.top_provider.max_completion_tokens
    : Number.isFinite(model?.limit?.output) ? model.limit.output
      : undefined;
  const input = model?.architecture?.input_modalities || model?.modalities?.input;
  const outputModalities = model?.architecture?.output_modalities || model?.modalities?.output;
  return {
    id: model?.id,
    name: model?.name || model?.display_name || model?.id,
    ...(context !== undefined || output !== undefined || Array.isArray(input) || Array.isArray(outputModalities) ? {
      remote: {
        ...(context !== undefined ? { context } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(Array.isArray(input) || Array.isArray(outputModalities) ? {
          modalities: {
            ...(Array.isArray(input) ? { input } : {}),
            ...(Array.isArray(outputModalities) ? { output: outputModalities } : {}),
          },
        } : {}),
      },
    } : {}),
  };
}

async function refreshDemoProviderModels(id) {
  try {
    const providers = await _store.loadProviderSites();
    const provider = providers.find(item => item.id === id);
    if (!provider) throw Object.assign(new Error('Provider 不存在'), { status: 404 });
    if (provider.executionMode === 'agent_native') {
      throw Object.assign(new Error('该平台没有可直接调用的模型列表接口'), { status: 400 });
    }

    const apiKey = provider.vaultKey ? await resolveVaultKey(provider.vaultKey) : undefined;
    const discoveries = [];
    const errors = [];
    for (const { id: endpointId, endpoint } of providerEndpointEntries(provider)) {
      try {
        const pulled = await fetchFreshEndpointModels(endpoint, apiKey);
        for (const model of pulled) discoveries.push({ endpointId, model });
      } catch (error) {
        errors.push({ endpoint: endpoint.baseUrl, error: error.message });
      }
    }
    if (!discoveries.length) {
      throw Object.assign(new Error('平台没有返回模型列表'), { status: 502, errors });
    }

    const modelsDev = require('../web/api/models-dev');
    const catalog = await modelsDev.loadCatalog();
    const uniqueModels = [...new Map(discoveries.map(item => [item.model.id, item.model])).values()];
    const enriched = catalog ? await modelsDev.enrichModels(provider, uniqueModels) : uniqueModels;
    const enrichedById = new Map(enriched.map(model => [model.id, model]));
    const materialized = await loadProviders();
    const target = materialized.find(item => item.id === provider.id);
    if (!target) throw Object.assign(new Error('Provider 不存在'), { status: 404 });
    const userConfig = await loadUserConfig();
    const activeModelIds = new Set(Object.values(userConfig.agentProviders || {})
      .flatMap(state => state?.sites?.[provider.id]?.modelIds || []));
    const now = new Date().toISOString();
    const remoteById = new Map();
    for (const discovery of discoveries) {
      const model = enrichedById.get(discovery.model.id) || discovery.model;
      const entry = remoteById.get(model.id) || { ...model, id: model.id, origin: 'remote', availability: [] };
      entry.availability.push({ executionMode: 'http_endpoint', endpointId: discovery.endpointId, remoteModelId: model.id, status: 'available', source: 'remote', discoveredAt: now, lastSeenAt: now });
      remoteById.set(model.id, entry);
    }
    // Match the shared discovery policy: remote membership is replaced, while
    // explicit user rows and currently selected rows survive a refresh.
    const retained = (target.models || []).filter(model =>
      model.origin === 'user' || activeModelIds.has(model.id),
    ).filter(model => !remoteById.has(model.id));
    target.models = [...retained, ...remoteById.values()];
    await _store.saveDiscoveredModels(provider.id, target.models);
    publishDataChanged(['providers']);
    const snapshot = await buildFreshModelDataSnapshot();
    const row = snapshot.providers.find(item => item.id === provider.id);
    return { success: true, provider: row, errors: errors.length ? errors : undefined };
  } catch (err) {
    if (err.status) throw err;
    throw Object.assign(new Error(`平台模型拉取失败：${err.message}`), { status: 502 });
  }
}

async function getAdaptersList() {
  try {
    const providers = await loadProviders();
    const config = await loadUserConfig();

    const result = await Promise.all(ADAPTERS.map(async adapter => {
      const state = getAgentState(config, adapter.id);
      // All type-compatible providers that are configured (have a key / verified /
      // oauth-eligible). These are candidates for the site/model picker.
      const isProviderReady = (p) => {
        if (state.sites[p.id] || state.activeProviderId === p.id) return true;
        if (p.authMode === 'none') return true;
        if (p.authVerified) return true;
        if (p.vaultKey) return true;
        if (p.authMode === 'oauth' || p.authMode === 'both') return true;
        return false;
      };
      const allCompatible = providers.filter(p => adapterSupportsProvider(adapter, p) && isProviderReady(p));

      // A multi-site Agent may be able to report which site it is using at
      // this moment. This is display-only; the saved site/model list remains
      // the user-facing source of truth and is never reconstructed from agent
      // files (which can contain manual entries).
      let activeModel = null;
      if (ADDITIVE_AGENTS.has(adapter.id)) {
        const instance = _getAdapter(adapter.id);
        if (instance && typeof instance.getActiveModel === 'function') {
          try {
            const active = await instance.getActiveModel();
            if (active?.providerId && active?.modelId && state.sites[active.providerId]) {
              activeModel = active;
            }
          } catch (err) {
            console.warn(`[getAdaptersList] getActiveModel(${adapter.id}) failed: ${err.message}`);
          }
        }
      }
      const currentSel = activeModel || (state.activeProviderId && state.activeModelId
        ? { providerId: state.activeProviderId, modelId: state.activeModelId }
        : null);
      const currentProvider = currentSel?.providerId ? providers.find(p => p.id === currentSel.providerId) : null;
      const selectedProviders = allCompatible.filter(p => state.sites[p.id]);

      return {
        ...adapter,
        launchType: adapter.launchType || 'cli',
        canLaunch: !!adapter.command,
        installed: adapter.launchType === 'app' ? true : (adapter.command ? !!findCommand(adapter.command) : false),
        additive: ADDITIVE_AGENTS.has(adapter.id),
        current: currentSel
          ? { providerId: currentSel.providerId, providerName: currentProvider?.name || currentSel.providerId, modelId: currentSel.modelId }
          : null,
        // The home page renders exactly the saved site/model selection. The
        // full provider catalog is deliberately sent separately for the picker.
        compatibleProviders: sortProviders(selectedProviders).map(p => {
          const site = state.sites[p.id];
          const selectedIds = new Set(site.modelIds || []);
          const selectedModels = tagRecentModels(sortModels((p.models || []).filter(m => selectedIds.has(m.id))));
          return {
          id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl,
          models: selectedModels,
          allModels: tagRecentModels(sortModels(p.models || [])),
          enabled: site.enabled !== false,
        };
        }),
        // The picker gets the complete model directory, but only a site/model
        // save changes the state above. Official subscriptions are fallbacks,
        // not additional sites, so leave them out of the add-site list.
        availableProviders: sortProviders(allCompatible
          .filter(p => !['anthropic-agent', 'openai-codex'].includes(p.id))
        ).map(p => ({
            id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl,
            models: tagRecentModels(sortModels(p.models || [])),
            added: Boolean(state.sites[p.id]),
            ...codexSiteFields(adapter.id, p),
          })),
        externalSites: [],
      };
    }));

    return { adapters: result };
  } catch (err) {
    throw err;
  }
}





async function launchAgent({ agentId, cwd } = {}) {
  if (!agentId) throw Object.assign(new Error('agentId required'), { status: 400 });

  const adapter = ADAPTERS.find(a => a.id === agentId);
  if (!adapter) throw Object.assign(new Error(`Agent not found: ${agentId}`), { status: 404 });
  if (!adapter.command) throw Object.assign(new Error(`${adapter.name} 不支持一键打开`), { status: 400 });

  try {
    if (adapter.launchType === 'app') {
      const appName = adapter.appName || adapter.name;
      const { spawn } = require('child_process');
      if (os.platform() === 'darwin') {
        spawn('open', ['-a', appName], { detached: true, stdio: 'ignore' }).unref();
      } else if (os.platform() === 'win32') {
        spawn('cmd', ['/c', 'start', '', appName], { detached: true, stdio: 'ignore', shell: true }).unref();
      } else {
        spawn(adapter.command, [], { detached: true, stdio: 'ignore' }).unref();
      }
      return { success: true, agentId, launched: 'app', appName };
    }

    const commandPath = findCommand(adapter.command);
    if (!commandPath) {
      throw Object.assign(new Error(`${adapter.name} CLI 未安装或不在 PATH 中`), { status: 404 });
    }

    const launchDir = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : process.cwd();
    const command = `cd ${shellQuote(launchDir)} && ${shellQuote(commandPath)}`;

    await openTerminal(command);
    return { success: true, agentId, command: adapter.command };
  } catch (err) {
    throw err;
  }
}

function openTerminal(command) {
  // safe: command is internally generated, not from user input
  if (typeof command !== 'string') throw new Error('command must be a string');
  const { spawn } = require('child_process');
  const platform = os.platform();

  if (platform === 'darwin') {
    const script = [
      'tell application "Terminal"',
      'activate',
      `do script ${appleScriptQuote(command)}`,
      'end tell',
    ].join('\n');
    return spawnDetached('osascript', ['-e', script]);
  }

  if (platform === 'linux') {
    // safe: command is internally generated, not from user input. bash -lc is intentional
    // for terminal launch; the command is constructed from validated paths in launchAgent.
    const terminals = [
      ['gnome-terminal', ['--', 'bash', '-lc', `${command}; exec bash`]],
      ['konsole', ['-e', 'bash', '-lc', `${command}; exec bash`]],
      ['xterm', ['-e', 'bash', '-lc', `${command}; exec bash`]],
    ];
    const found = terminals.find(([cmd]) => findCommand(cmd));
    if (!found) throw new Error('未找到可用终端应用');
    return spawnDetached(found[0], found[1]);
  }

  if (platform === 'win32') {
    return spawnDetached('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', command]);
  }

  throw new Error(`Unsupported platform: ${platform}`);
}

function spawnDetached(command, args) {
  return new Promise((resolve, reject) => {
    const child = require('child_process').spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.unref();
    resolve();
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function appleScriptQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}


return { getModelData, refreshModelData, refreshDemoProviderModels, getAdaptersList, launchAgent, normalizeRemoteModel }; }
module.exports={createProviderStatusService};
