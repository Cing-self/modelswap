// Provider model discovery is transport/cache orchestration, independent of HTTP.
const { describeRejection, modelDiscoveryFailure } = require('./error-normalization');

// Agent Plan's /api/plan gateway intentionally has no public /models route.
// This catalog mirrors the signed-in console's selectable model IDs. Kimi K3
// is displayed for larger plans but returned UnsupportedModel on Small plans,
// so it is deliberately excluded until plan-aware discovery exists.
const VOLCENGINE_AGENT_PLAN_MODEL_CATALOG = Object.freeze([
  { id: 'ark-code-latest', name: 'Ark Code Latest（自动路由）' },
  { id: 'doubao-seed-evolving', name: 'Doubao Seed Evolving' },
  { id: 'doubao-seed-2.1-turbo', name: 'Doubao Seed 2.1 Turbo' },
  { id: 'doubao-seed-2.0-lite', name: 'Doubao Seed 2.0 Lite' },
  { id: 'doubao-seed-2.0-mini', name: 'Doubao Seed 2.0 Mini' },
  { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' },
  { id: 'glm-5.3', name: 'GLM 5.3' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code' },
  { id: 'minimax-m3', name: 'MiniMax M3' },
]);

function volcengineAgentPlanModels(endpointEntries) {
  const discoveredAt = new Date().toISOString();
  return VOLCENGINE_AGENT_PLAN_MODEL_CATALOG.map(({ id, name }) => ({
    id,
    name,
    origin: 'remote',
    availability: endpointEntries.map(({ id: endpointId }) => ({
      executionMode: 'http_endpoint',
      endpointId,
      remoteModelId: id,
      status: 'available',
      source: 'remote',
      discoveredAt,
      lastSeenAt: discoveredAt,
    })),
  }));
}

function createModelDiscoveryService(deps) {
  const { fs, path, os, _store, loadProviders, saveProviders, loadUserConfig, providerEndpointEntries, providerExecutionMode, QIANFAN_CODING_PROBE_MODEL, isQianfanCodingEndpoint, isQianfanCodingAnthropicEndpoint, qianfanModelDirectoryUrl, qianfanCodingErrorCode, qianfanCodingErrorMessage, getAnthropicAuthMode, normalizeRemoteModel, detectOAuth, resolveVaultKey, findCommand } = deps;
  const warmupInflight = new Map();
async function readCodexCachedModels() {
  const cachePath = path.join(os.homedir(), '.codex', 'models_cache.json');
  if (!(await fs.pathExists(cachePath))) {
    throw new Error('未找到 Codex 模型缓存，请先完成 OAuth 登录并启动一次 Codex');
  }

  let cache;
  try {
    cache = JSON.parse(await fs.readFile(cachePath, 'utf-8'));
  } catch {
    throw new Error('Codex 模型缓存无法读取');
  }

  const entries = Array.isArray(cache) ? cache : cache.models;
  if (!Array.isArray(entries)) throw new Error('Codex 模型缓存格式无效');

  const models = [];
  const seen = new Set();
  for (const entry of entries) {
    const id = typeof entry === 'string' ? entry : (entry?.slug || entry?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: typeof entry === 'string' ? entry : (entry.display_name || entry.name || id),
    });
  }
  if (models.length === 0) throw new Error('Codex 模型缓存中没有可用模型');
  return models;
}

async function readGrokCliModels() {
  const cliPath = findCommand('grok');
  if (!cliPath) throw new Error('未检测到 Grok CLI，请先安装 Grok');
  const { spawnSync } = require('child_process');
  const result = spawnSync(cliPath, ['models'], {
    encoding: 'utf-8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error((result.stderr || '').trim() || 'Grok 模型列表读取失败');
  const marker = 'Available models:';
  const output = String(result.stdout || '');
  const lines = output.includes(marker) ? output.slice(output.indexOf(marker) + marker.length).split(/\r?\n/) : [];
  const models = lines.map(line => {
    const match = line.match(/^\s*[*-]\s+([^\s(]+)/);
    return match ? { id: match[1], name: match[1] } : null;
  }).filter(Boolean);
  if (!models.length) throw new Error('Grok CLI 没有返回可用模型，请先完成 grok login');
  return models;
}

async function readCopilotCliModels() {
  const cliPath = findCommand('copilot');
  if (!cliPath) throw new Error('未检测到 GitHub Copilot CLI，请先安装 Copilot CLI');

  const { CopilotClient, RuntimeConnection } = await import('@github/copilot-sdk');
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({ path: cliPath }),
    useLoggedInUser: true,
    workingDirectory: process.cwd(),
    logLevel: 'error',
  });

  try {
    await client.start();
    const entries = await client.listModels();
    const seen = new Set();
    const models = entries
      .filter(entry => entry?.id && !seen.has(entry.id) && seen.add(entry.id))
      .map(entry => ({ id: entry.id, name: entry.name || entry.label || entry.id }));
    if (models.length === 0) throw new Error('Copilot 当前账号没有返回可用模型');
    return models;
  } finally {
    await client.stop().catch(() => client.forceStop());
  }
}

function withNativeAvailability(provider, models, source = 'cli') {
  const now = new Date().toISOString();
  return models.map(model => ({
    ...model,
    availability: [{
      executionMode: 'agent_native',
      nativeAgentIds: provider.nativeAgentIds || [],
      remoteModelId: model.id,
      status: 'available',
      source,
      discoveredAt: now,
      lastSeenAt: now,
    }],
  }));
}

// A successful refresh replaces remote membership with the authenticated
// endpoint/CLI response. User-added and currently-selected entries survive by
// explicit product policy; a catalog never contributes a directory-only row.
const RETIRED_DEEPSEEK_DEFAULT_MODEL_IDS = new Set(['deepseek-chat', 'deepseek-reasoner']);

function replaceRemoteModels(provider, discoveries, activeModelIds) {
  const now = new Date().toISOString();
  const byId = new Map();
  for (const d of discoveries) {
    if (!byId.has(d.model.id)) byId.set(d.model.id, []);
    byId.get(d.model.id).push(d);
  }
  const next = [];
  const seen = new Set();
  for (const model of provider.models || []) {
    const fresh = byId.get(model.id);
    // DeepSeek retired these two aliases in favor of V4 Flash modes. They
    // used to be part of OKIT's default catalog, so an old agent selection
    // must not make a successful refresh reintroduce them as selectable
    // models. Explicit user-added models remain untouched.
    if (
      provider.id === 'deepseek'
      && RETIRED_DEEPSEEK_DEFAULT_MODEL_IDS.has(model.id)
      && model.origin !== 'user'
      && byId.has('deepseek-v4-flash')
    ) continue;
    const survives = model.origin === 'user' || activeModelIds.has(model.id);
    const entry = { ...model };
    if (fresh) {
      entry.origin = 'remote';
      entry.name = model.name || fresh[0].model.name || model.id;
      if (fresh[0].model.meta) entry.meta = fresh[0].model.meta;
      if (fresh[0].model.remote) entry.remote = fresh[0].model.remote;
      entry.availability = fresh.map(d => ({
        executionMode: 'http_endpoint',
        endpointId: d.endpointId,
        remoteModelId: d.model.id,
        status: 'available',
        source: 'remote',
        discoveredAt: now,
        lastSeenAt: now,
      }));
    }
    if (!fresh && !survives) continue;
    if (!Array.isArray(entry.availability) || entry.availability.length === 0) {
      entry.availability = [{
        executionMode: 'http_endpoint',
        remoteModelId: model.id,
        status: 'unknown',
        source: 'legacy_unknown',
      }];
    }
    next.push(entry);
    seen.add(model.id);
  }
  for (const [id, list] of byId) {
    if (seen.has(id)) continue;
    next.push({
      id,
      name: list[0].model.name || id,
      origin: 'remote',
      ...(list[0].model.meta ? { meta: list[0].model.meta } : {}),
      ...(list[0].model.remote ? { remote: list[0].model.remote } : {}),
      availability: list.map(d => ({
        executionMode: 'http_endpoint',
        endpointId: d.endpointId,
        remoteModelId: d.model.id,
        status: 'available',
        source: 'remote',
        discoveredAt: now,
        lastSeenAt: now,
      })),
    });
  }
  return next;
}

async function fetchModels(input = {}) {
  const { providerId, endpoints: requestedEndpoints, vaultKey: requestedVaultKey, persistConfig = false } = input;
  const hasRequestedConfig = Array.isArray(requestedEndpoints) || Object.prototype.hasOwnProperty.call(input, 'vaultKey');
  const previewConfig = hasRequestedConfig && !persistConfig;
  if (!providerId && !previewConfig) throw Object.assign(new Error('providerId required'), { status: 400 });

  try {
    const providers = await loadProviders();
    const p = providerId ? providers.find(x => x.id === providerId) : undefined;
    if (!p && !previewConfig) throw Object.assign(new Error('Provider 不存在'), { status: 404 });

    if (p?.id === 'openai-codex' && !previewConfig) {
      // The ChatGPT subscription exposes no list-models API — Codex's own
      // runtime cache is the only fresh source. Do not substitute a bundled
      // list when the CLI has not produced one yet.
      let cached = [];
      try {
        cached = await readCodexCachedModels();
      } catch { /* no CLI discovery yet */ }
      const source = cached;
      if (source.length) {
        p.models = withNativeAvailability(p, source, 'cli');
        await _store.saveDiscoveredModels(p.id, p.models);
      }
      return {
        success: source.length > 0,
        modelsDiscovered: source.length > 0,
        models: p.models || source,
        kept: source.length === 0 ? p.models : undefined,
      };
    }

    if (p?.id === 'xai-grok-build' && !previewConfig) {
      if (!(await detectOAuth(p.id))) throw new Error('请先完成 Grok 登录');
      const models = withNativeAvailability(p, await readGrokCliModels(), 'cli');
      p.models = models;
      await _store.saveDiscoveredModels(p.id, p.models);
      return { success: true, models, modelsDiscovered: true };
    }

    if (p?.id === 'github-copilot' && !previewConfig) {
      if (!(await detectOAuth(p.id))) throw new Error('请先完成 GitHub Copilot 登录');
      const models = withNativeAvailability(p, await readCopilotCliModels(), 'cli');
      p.models = models;
      await _store.saveDiscoveredModels(p.id, p.models);
      return { success: true, models, modelsDiscovered: true };
    }

    if (p?.id === 'volcengine-agent') {
      const discoveredProvider = p && hasRequestedConfig ? {
        ...p,
        ...(Array.isArray(requestedEndpoints) ? {
          endpoints: requestedEndpoints,
          ...(requestedEndpoints[0]?.baseUrl ? { baseUrl: requestedEndpoints[0].baseUrl } : {}),
        } : {}),
        ...(Object.prototype.hasOwnProperty.call(input, 'vaultKey') ? { vaultKey: requestedVaultKey || undefined } : {}),
      } : p;
      const endpointEntries = Array.isArray(requestedEndpoints) && requestedEndpoints.length
        ? requestedEndpoints.map((endpoint, index) => ({ id: endpoint.id || `${providerId}:endpoint:${index}`, endpoint }))
        : providerEndpointEntries(discoveredProvider);
      if (!endpointEntries.length) throw Object.assign(new Error('至少需要一个有效端点'), { status: 400 });

      const models = volcengineAgentPlanModels(endpointEntries);
      const userConfig = await loadUserConfig();
      const activeModelIds = new Set(
        Object.values(userConfig.agentProviders || {})
          .flatMap(state => state?.sites?.[p.id]?.modelIds || []),
      );
      p.models = replaceRemoteModels(p, models.flatMap(model => endpointEntries.map(({ id: endpointId }) => ({
        endpointId,
        model,
      }))), activeModelIds);
      try {
        p.models = await require('../web/api/models-dev').enrichModels(discoveredProvider || p, p.models);
      } catch (enrichErr) {
        console.warn(`[fetchModels] models.dev enrichment failed: ${enrichErr.message}`);
      }
      if (persistConfig && discoveredProvider) {
        Object.assign(p, {
          endpoints: discoveredProvider.endpoints,
          baseUrl: discoveredProvider.baseUrl,
          vaultKey: discoveredProvider.vaultKey,
        });
        await saveProviders(providers);
      } else {
        await _store.saveDiscoveredModels(p.id, p.models);
      }
      return {
        success: true,
        modelsDiscovered: true,
        models: previewConfig ? models : p.models,
        errors: undefined,
      };
    }

    if (p && providerExecutionMode(p) === 'agent_native' && !previewConfig) {
      // No native CLI source is available for this agent. Leave any existing
      // cache intact rather than presenting a preset list as live discovery.
      return { success: false, models: [], kept: p.models || [], modelsDiscovered: false };
    }

    const discoveredProvider = p && hasRequestedConfig ? {
      ...p,
      ...(Array.isArray(requestedEndpoints) ? {
        endpoints: requestedEndpoints,
        ...(requestedEndpoints[0]?.baseUrl ? { baseUrl: requestedEndpoints[0].baseUrl } : {}),
      } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, 'vaultKey') ? { vaultKey: requestedVaultKey || undefined } : {}),
    } : p;
    const apiKey = hasRequestedConfig
      ? (requestedVaultKey ? await resolveVaultKey(requestedVaultKey) : undefined)
      : (p?.vaultKey ? await resolveVaultKey(p.vaultKey) : undefined);
    const endpointEntries = Array.isArray(requestedEndpoints) && requestedEndpoints.length
      ? requestedEndpoints.map((endpoint, index) => ({ id: endpoint.id || `${providerId || 'preview'}:endpoint:${index}`, endpoint }))
      : (discoveredProvider ? providerEndpointEntries(discoveredProvider) : []);
    if (!endpointEntries.length) throw Object.assign(new Error('至少需要一个有效端点'), { status: 400 });
    const allModels = [];
    const discoveries = [];
    const successfulEndpointIds = new Set();
    const errors = [];

    for (const { id: endpointId, endpoint: ep } of endpointEntries) {
      try {
        let models = [];
        if (ep.type === 'openai') {
          models = qianfanModelDirectoryUrl(ep.baseUrl)
            ? await fetchQianfanCodingModels(ep.baseUrl, apiKey)
            : await fetchOpenAIModels(ep.baseUrl, apiKey);
        } else if (ep.type === 'anthropic') {
          models = isQianfanCodingAnthropicEndpoint(ep.baseUrl)
            ? await fetchQianfanCodingAnthropicModels(ep.baseUrl, apiKey)
            : await fetchAnthropicModels(ep.baseUrl, apiKey);
        }
        try {
          models = await require('../web/api/models-dev').enrichModels(discoveredProvider || { id: providerId, baseUrl: ep.baseUrl, endpoints: [ep] }, models);
        } catch (enrichErr) {
          console.warn(`[fetchModels] endpoint metadata enrichment failed: ${enrichErr.message}`);
        }
        successfulEndpointIds.add(endpointId);
        for (const m of models) {
          if (!allModels.find(x => x.id === m.id)) allModels.push(m);
          discoveries.push({ endpointId, model: m });
        }
      } catch (err) {
        const failure = modelDiscoveryFailure(err);
        // Keep endpoint identity for support correlation, but never return a
        // raw rejected value which could contain an Authorization credential.
        console.warn(`[model-discovery] provider=${providerId || p?.id || 'preview'} endpoint=${endpointId} kind=${describeRejection(err)}`);
        errors.push({ endpoint: ep.baseUrl, error: failure.error });
      }
    }

    if (allModels.length > 0 && p && !previewConfig) {
      // Refresh = full replace of remote models (delisted ids drop out).
      // Models any agent currently has selected on this provider survive so
      // an in-flight selection never dangles.
      const userConfig = await loadUserConfig();
      const activeModelIds = new Set(
        Object.values(userConfig.agentProviders || {})
          .flatMap(state => state?.sites?.[providerId]?.modelIds || []),
      );
      p.models = replaceRemoteModels(p, discoveries, activeModelIds);
      // models.dev enrichment: platform /models gives bare ids — attach
      // context/output/tool/reasoning/multimodal metadata from the catalog.
      try {
        p.models = await require('../web/api/models-dev').enrichModels(discoveredProvider || p, p.models);
      } catch (enrichErr) {
        console.warn(`[fetchModels] models.dev enrichment failed: ${enrichErr.message}`);
      }
      if (persistConfig && discoveredProvider) {
        Object.assign(p, {
          endpoints: discoveredProvider.endpoints,
          baseUrl: discoveredProvider.baseUrl,
          vaultKey: discoveredProvider.vaultKey,
        });
        // The connection configuration and its freshly discovered directory
        // become visible together. The store keeps models out of providers.json.
        await saveProviders(providers);
      } else {
        await _store.saveDiscoveredModels(p.id, p.models);
      }
    }

    return {
      success: allModels.length > 0,
      modelsDiscovered: allModels.length > 0,
      models: p && !previewConfig && allModels.length > 0
        ? p.models
        : allModels.map(model => ({ ...model, origin: model.origin || 'remote' })),
      errors: errors.length > 0 ? errors : undefined,
      kept: allModels.length === 0 && p ? p.models : undefined,
    };
  } catch (err) {
    throw err;
  }
}

function isReferencedByAnAgent(providerId, config) {
  return Object.values(config?.agentProviders || {}).some(state =>
    state?.activeProviderId === providerId || Boolean(state?.sites?.[providerId]),
  );
}

async function isConfiguredForWarmup(provider, config) {
  const native = providerExecutionMode(provider) === 'agent_native';
  if (native) {
    // These are the only native branches with an actual CLI/cache discovery
    // implementation in fetchModels. A selected Agent site also counts as an
    // explicit configuration; fetchModels still verifies OAuth where needed.
    if (!['openai-codex', 'xai-grok-build', 'github-copilot'].includes(provider.id)) return false;
    return isReferencedByAnAgent(provider.id, config) || await detectOAuth(provider.id);
  }

  // Do not turn unauthenticated presets (including authMode:none) into
  // network work. HTTP warmup requires a real local vault binding and at
  // least one endpoint; it never derives models from a preset/catalog.
  if (provider.authMode === 'none' || !provider.vaultKey || providerEndpointEntries(provider).length === 0) return false;
  return Boolean(await resolveVaultKey(provider.vaultKey));
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

/**
 * Background startup warmup for sites whose canonical runtime cache is absent.
 * It intentionally delegates each candidate to fetchModels so discovery,
 * same-ID models.dev enrichment, cache writes, and UI invalidation stay on the
 * established path. The providers directory and Agent configuration remain
 * untouched.
 */
async function discoverMissingConfiguredModels({ concurrency = 2, providerIds, requestId } = {}) {
  // loadProviders performs the one-time legacy catalog-membership cleanup.
  // Read the canonical cache only after that migration settles; otherwise a
  // parallel read can observe a soon-to-be-removed models.dev-only row and
  // incorrectly skip this process's only startup warmup attempt.
  const providers = await loadProviders();
  const [config, cache] = await Promise.all([
    loadUserConfig(),
    _store.loadModelsCache(),
  ]);
  const requestedIds = Array.isArray(providerIds)
    ? new Set(providerIds.filter(id => typeof id === 'string' && id))
    : null;
  const candidates = [];
  const preflightFailures = [];
  for (const provider of providers) {
    if (requestedIds && !requestedIds.has(provider.id)) continue;
    if (Array.isArray(cache.providers?.[provider.id]) && cache.providers[provider.id].length > 0) continue;
    try {
      if (await isConfiguredForWarmup(provider, config)) candidates.push(provider);
    } catch (error) {
      const failure = modelDiscoveryFailure(error);
      console.warn(`[model-warmup] request=${requestId || 'background'} provider=${provider.id} stage=configuration kind=${describeRejection(error)}`);
      preflightFailures.push({
        providerId: provider.id,
        status: 'failed',
        modelsDiscovered: false,
        ...failure,
      });
    }
  }

  const discoveredResults = await runWithConcurrency(candidates, Math.max(1, Math.min(3, Number(concurrency) || 2)), async provider => {
    const existing = warmupInflight.get(provider.id);
    if (existing) return existing;
    const task = (async () => {
      try {
        const result = await fetchModels({ providerId: provider.id });
        const unavailable = !result.modelsDiscovered;
        return {
          providerId: provider.id,
          // An empty 200 response means no current directory is available;
          // endpoint/network failures are actionable diagnostics for callers
          // such as sync pull and must not be collapsed into that state.
          status: result.modelsDiscovered ? 'discovered' : (result.errors?.length ? 'failed' : 'unavailable'),
          modelsDiscovered: Boolean(result.modelsDiscovered),
          ...(unavailable && result.errors?.length ? {
            code: 'MODEL_DISCOVERY_FAILED',
            error: result.errors.map(item => item.error).join('; '),
          } : {}),
        };
      } catch (error) {
        // Warmup is deliberately silent and independent per site. A manual
        // connection test remains the place to surface detailed diagnostics.
        const failure = modelDiscoveryFailure(error);
        console.warn(`[model-warmup] request=${requestId || 'background'} provider=${provider.id} stage=discovery kind=${describeRejection(error)}`);
        return {
          providerId: provider.id,
          status: 'failed',
          modelsDiscovered: false,
          ...failure,
        };
      } finally {
        warmupInflight.delete(provider.id);
      }
    })();
    warmupInflight.set(provider.id, task);
    return task;
  });
  const results = [...preflightFailures, ...discoveredResults];

  return {
    warmed: results.filter(result => result?.status === 'discovered').map(result => result.providerId),
    pending: [...preflightFailures.map(result => result.providerId), ...candidates.map(provider => provider.id)],
    results,
  };
}

async function fetchOpenAIModels(baseUrl, apiKey) {
  const url = baseUrl.replace(/\/+$/, '') + '/models';
  const headers = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const result = await httpReq(url, { method: 'GET', headers, timeout: 10000 });
  if (result.error) throw new Error(result.error);
  if (result.status === 200) {
    const d = JSON.parse(result.body);
    const models = (d.data || []).map(normalizeRemoteModel);
    if (models.length) return models;
  }
  // Probes may validate credentials elsewhere, but never manufacture model
  // membership. An empty official list is an empty discovery result.
  if (result.status !== 200) throw new Error(`HTTP ${result.status}`);
  return [];
}

async function fetchQianfanCodingModels(baseUrl, apiKey) {
  // Token Plan's inference URL is deliberately scoped under
  // /v2/tokenplan/personal, but Qianfan documents the authenticated model
  // directory at the canonical V2 endpoint: GET /v2/models. Appending
  // /models to the plan URL asks for a non-existent resource and leaves a
  // fresh synced device with no routeable models.
  const directoryUrl = qianfanModelDirectoryUrl(baseUrl);
  if (!directoryUrl) throw new Error('千帆 Token Plan 模型目录地址无效');
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const listResult = await httpReq(directoryUrl, { method: 'GET', headers, timeout: 10000 });
  if (listResult.error) throw new Error(listResult.error);

  const listCode = qianfanCodingErrorCode(listResult.body);
  const listMessage = qianfanCodingErrorMessage(listCode);
  if (listMessage) throw new Error(listMessage);
  if (listResult.status === 200) {
    const data = JSON.parse(listResult.body);
    const models = (data.data || []).map(normalizeRemoteModel);
    if (models.length) return models;
  }

  // A successful probe is not an official list-model response. Keep the
  // existing cache when this endpoint cannot enumerate models.
  if (listResult.status === 401) throw new Error('百度千帆 Coding Plan API Key 无效');
  if (listResult.status === 404 || listResult.status === 405) return [];
  throw new Error(`HTTP ${listResult.status}`);
}

async function fetchQianfanCodingAnthropicModels(baseUrl, apiKey) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  const headers = { 'anthropic-version': '2023-06-01' };
  if (apiKey) headers['x-api-key'] = apiKey;
  const result = await httpReq(`${root}/v1/models`, {
    method: 'GET', headers, timeout: 10000,
  });
  if (result.error) throw new Error(result.error);
  const code = qianfanCodingErrorCode(result.body);
  const message = qianfanCodingErrorMessage(code);
  if (message) throw new Error(message);
  if (result.status === 200) {
    const data = JSON.parse(result.body);
    return (data.data || []).map(normalizeRemoteModel).filter(model => model.id);
  }
  if (result.status === 401) throw new Error('百度千帆 Token Plan API Key 无效');
  if (result.status === 404 || result.status === 405) return [];
  throw new Error(`HTTP ${result.status}`);
}

async function fetchAnthropicModels(baseUrl, apiKey) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  const url = `${root}/v1/models`;
  const headers = {};
  if (getAnthropicAuthMode(baseUrl) === 'bearer') {
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  } else if (/^https?:\/\/api\.minimax(?:i\.com|\.io)\/anthropic\/?$/i.test(String(baseUrl || '').trim())) {
    if (apiKey) headers['X-Api-Key'] = apiKey;
  } else if (apiKey) {
    headers['x-api-key'] = apiKey;
  }
  if (/^https?:\/\/api\.z\.ai\/api\/anthropic\/?$/i.test(String(baseUrl || '').trim())) {
    headers['accept-language'] = 'en-US,en';
  }
  headers['anthropic-version'] = '2023-06-01';
  const result = await httpReq(url, { method: 'GET', headers, timeout: 10000 });
  if (result.error) throw new Error(result.error);
  if (result.status === 401) throw new Error('API Key 无效');
  if (result.status === 200) {
    const d = JSON.parse(result.body);
    const models = (d.data || []).map(normalizeRemoteModel);
    if (models.length) return models;
  }

  if (result.status === 404 || result.status === 405) throw new Error('不支持模型列表接口');
  throw new Error(`HTTP ${result.status}`);
}

function httpReq(url, options) {
  return new Promise((resolve) => {
    const parsed = new (require('url').URL)(url);
    const mod = parsed.protocol === 'https:' ? require('https') : require('http');
    const clientRequest = mod.request(url, options, (clientResponse) => {
      let body = '';
      clientResponse.on('data', c => body += c);
      clientResponse.on('end', () => resolve({ status: clientResponse.statusCode, body }));
    });
    clientRequest.on('error', err => resolve({ status: 0, error: err.message }));
    if (options.body) clientRequest.write(options.body);
    clientRequest.setTimeout(options.timeout || 10000, () => { clientRequest.destroy(); resolve({ status: 0, error: 'Timeout' }); });
    clientRequest.end();
  });
}

// ─── Deep Link: Provider Export / Import ───

const PROVIDER_CODE_PREFIX = 'okit-provider:';
const PROVIDER_CODE_SALT = 'okit-provider-salt';


  return { readCodexCachedModels, readGrokCliModels, readCopilotCliModels, withNativeAvailability, replaceRemoteModels, fetchModels, discoverMissingConfiguredModels, fetchOpenAIModels, fetchQianfanCodingModels, fetchQianfanCodingAnthropicModels, fetchAnthropicModels, volcengineAgentPlanModels };
}
module.exports = { createModelDiscoveryService };
