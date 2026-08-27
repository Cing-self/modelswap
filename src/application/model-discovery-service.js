// Provider model discovery is transport/cache orchestration, independent of HTTP.
function createModelDiscoveryService(deps) {
  const { fs, path, os, _store, loadProviders, saveProviders, loadUserConfig, providerEndpointEntries, providerExecutionMode, QIANFAN_CODING_PROBE_MODEL, isQianfanCodingEndpoint, isQianfanCodingAnthropicEndpoint, qianfanCodingErrorCode, qianfanCodingErrorMessage, qianfanCodingModels, getProbeModels, getFallbackModels, getAuthenticatedResourceFailureMessage, getAnthropicAuthMode, isModelAccessFailure, publishDataChanged, tagRecentModels, sortModels, normalizeRemoteModel, detectOAuth, resolveVaultKey, findCommand } = deps;
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

function withNativeAvailability(provider, models, source = 'static') {
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

// Explicit three-way refresh semantics: remote∩directory is enriched; remote
// only stays selectable with incomplete metadata; directory-only is retained
// but marked unavailable for this account. A failed request never reaches this
// function, so its old snapshot remains intact.
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
    if (!fresh && !survives) {
      // This came from the local directory rather than the authenticated
      // account. Keep it visible as an unavailable fact, never route it.
      entry.availability = [{
        executionMode: 'http_endpoint', remoteModelId: model.id,
        status: 'unavailable', source: 'static', discoveredAt: now, lastSeenAt: now,
      }];
    } else if (!Array.isArray(entry.availability) || entry.availability.length === 0) {
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

async function fetchModels(req, res) {
  const { providerId, endpoints: requestedEndpoints, vaultKey: requestedVaultKey } = req.body;
  const previewConfig = Array.isArray(requestedEndpoints) || Object.prototype.hasOwnProperty.call(req.body, 'vaultKey');
  if (!providerId && !previewConfig) return res.status(400).json({ error: 'providerId required' });

  try {
    const providers = await loadProviders();
    const p = providerId ? providers.find(x => x.id === providerId) : undefined;
    if (!p && !previewConfig) return res.status(404).json({ error: 'Provider 不存在' });

    if (p?.id === 'openai-codex' && !previewConfig) {
      // The ChatGPT subscription exposes no list-models API — Codex's own
      // runtime cache is the only fresh source. But OKIT must not HARD-depend
      // on another tool having run: when the cache isn't there yet, fall back
      // to the bundled preset list instead of failing the whole fetch.
      let cached = [];
      try {
        cached = await readCodexCachedModels();
      } catch { /* not run yet — preset list stands in */ }
      const source = cached.length ? cached : (p.models || []);
      if (source.length) {
        p.models = withNativeAvailability(p, source, 'cli');
        await _store.saveDiscoveredModels(p.id, p.models);
        await saveProviders(providers, { persistModels: false });
      }
      return res.json({
        success: source.length > 0,
        models: p.models || source,
        kept: source.length === 0 ? p.models : undefined,
      });
    }

    if (p?.id === 'xai-grok-build' && !previewConfig) {
      if (!(await detectOAuth(p.id))) throw new Error('请先完成 Grok 登录');
      const models = withNativeAvailability(p, await readGrokCliModels(), 'cli');
      p.models = models;
      await _store.saveDiscoveredModels(p.id, p.models);
      await saveProviders(providers, { persistModels: false });
      return res.json({ success: true, models });
    }

    if (p?.id === 'github-copilot' && !previewConfig) {
      if (!(await detectOAuth(p.id))) throw new Error('请先完成 GitHub Copilot 登录');
      const models = withNativeAvailability(p, await readCopilotCliModels(), 'cli');
      p.models = models;
      await _store.saveDiscoveredModels(p.id, p.models);
      await saveProviders(providers, { persistModels: false });
      return res.json({ success: true, models });
    }

    if (p && providerExecutionMode(p) === 'agent_native' && !previewConfig) {
      const models = withNativeAvailability(p, p.models || [], 'static');
      p.models = models;
      await _store.saveDiscoveredModels(p.id, p.models);
      await saveProviders(providers, { persistModels: false });
      return res.json({ success: models.length > 0, models });
    }

    const apiKey = previewConfig
      ? (requestedVaultKey ? await resolveVaultKey(requestedVaultKey) : undefined)
      : (p?.vaultKey ? await resolveVaultKey(p.vaultKey) : undefined);
    const endpointEntries = Array.isArray(requestedEndpoints) && requestedEndpoints.length
      ? requestedEndpoints.map((endpoint, index) => ({ id: endpoint.id || `${providerId || 'preview'}:endpoint:${index}`, endpoint }))
      : (p ? providerEndpointEntries(p) : []);
    if (!endpointEntries.length) return res.status(400).json({ error: '至少需要一个有效端点' });
    const allModels = [];
    const discoveries = [];
    const successfulEndpointIds = new Set();
    const errors = [];

    for (const { id: endpointId, endpoint: ep } of endpointEntries) {
      try {
        let models = [];
        if (ep.type === 'openai') {
          models = isQianfanCodingEndpoint(ep.baseUrl)
            ? await fetchQianfanCodingModels(ep.baseUrl, apiKey)
            : await fetchOpenAIModels(ep.baseUrl, apiKey);
        } else if (ep.type === 'anthropic') {
          models = isQianfanCodingAnthropicEndpoint(ep.baseUrl)
            ? await fetchQianfanCodingAnthropicModels(ep.baseUrl, apiKey)
            : await fetchAnthropicModels(ep.baseUrl, apiKey);
        }
        try {
          models = await require('../web/api/models-dev').enrichModels(p || { id: providerId, baseUrl: ep.baseUrl, endpoints: [ep] }, models);
        } catch (enrichErr) {
          console.warn(`[fetchModels] endpoint metadata enrichment failed: ${enrichErr.message}`);
        }
        successfulEndpointIds.add(endpointId);
        for (const m of models) {
          if (!allModels.find(x => x.id === m.id)) allModels.push(m);
          discoveries.push({ endpointId, model: m });
        }
      } catch (err) {
        errors.push({ endpoint: ep.baseUrl, error: err.message });
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
        p.models = await require('../web/api/models-dev').enrichModels(p, p.models);
      } catch (enrichErr) {
        console.warn(`[fetchModels] models.dev enrichment failed: ${enrichErr.message}`);
      }
      await _store.saveDiscoveredModels(p.id, p.models);
      await saveProviders(providers, { persistModels: false });
    }

    res.json({
      success: allModels.length > 0,
      models: p && !previewConfig && allModels.length > 0 ? p.models : allModels,
      errors: errors.length > 0 ? errors : undefined,
      kept: allModels.length === 0 && p ? p.models : undefined,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  // Some deployments return 200 with an empty list, or 404/403/405 when the
  // /models endpoint is not exposed. For Coding Plan providers we probe the
  // chat endpoint with a plan-specific model and return the known fallback
  // list on success so the UI shows usable models instead of "sync failed".
  const fallback = getFallbackModels(baseUrl);
  if (fallback && (result.status === 200 || result.status === 404 || result.status === 403 || result.status === 405)) {
    let probeResult;
    for (const probeModel of getProbeModels(baseUrl)) {
      const probeBody = JSON.stringify({
        model: probeModel,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
      probeResult = await httpReq(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST', headers, body: probeBody, timeout: 10000,
      });
      if (probeResult.error) throw new Error(probeResult.error);
      // 200 or 400 (bad request for max_tokens=1 etc.) both mean the key is
      // valid and the endpoint is reachable — return the known model list.
      if (probeResult.status === 200 || probeResult.status === 400) return fallback;
      if (isModelAccessFailure(probeResult.status, probeResult.body)) continue;
      if (getAuthenticatedResourceFailureMessage(probeResult.status, probeResult.body)) return fallback;
      if (probeResult.status === 401) throw new Error('API Key 无效');
      break;
    }
    // A model-level denial means authentication succeeded. Keep the offering
    // catalog visible; entitlement is evaluated when the user selects a model.
    if (probeResult && isModelAccessFailure(probeResult.status, probeResult.body)) return fallback;
    throw new Error(`HTTP ${probeResult?.status || 0}`);
  }
  if (result.status !== 200) throw new Error(`HTTP ${result.status}`);
  return [];
}

async function fetchQianfanCodingModels(baseUrl, apiKey) {
  const root = baseUrl.replace(/\/+$/, '');
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const listResult = await httpReq(`${root}/models`, { method: 'GET', headers, timeout: 10000 });
  if (listResult.error) throw new Error(listResult.error);

  const listCode = qianfanCodingErrorCode(listResult.body);
  const listMessage = qianfanCodingErrorMessage(listCode);
  if (listMessage) throw new Error(listMessage);
  if (listResult.status === 200) {
    const data = JSON.parse(listResult.body);
    const models = (data.data || []).map(normalizeRemoteModel);
    if (models.length) return models;
  }

  // The Coding Plan documentation guarantees the chat route and model names,
  // but some deployments do not expose /models. Validate the key with the
  // documented model and use the known list only after the probe succeeds.
  if (listResult.status === 404 || listResult.status === 405 || listResult.status === 200) {
    const probeBody = JSON.stringify({
      model: QIANFAN_CODING_PROBE_MODEL,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    const probeResult = await httpReq(`${root}/chat/completions`, {
      method: 'POST', headers, body: probeBody, timeout: 10000,
    });
    if (probeResult.error) throw new Error(probeResult.error);
    const probeCode = qianfanCodingErrorCode(probeResult.body);
    const probeMessage = qianfanCodingErrorMessage(probeCode);
    if (probeMessage) throw new Error(probeMessage);
    if (probeResult.status === 200 || probeResult.status === 400) return qianfanCodingModels();
    if (probeResult.status === 401) throw new Error('百度千帆 Coding Plan API Key 无效');
    throw new Error(`HTTP ${probeResult.status}`);
  }

  if (listResult.status === 401) throw new Error('百度千帆 Coding Plan API Key 无效');
  throw new Error(`HTTP ${listResult.status}`);
}

async function fetchQianfanCodingAnthropicModels(baseUrl, apiKey) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  const headers = {
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };
  if (apiKey) headers['x-api-key'] = apiKey;
  const body = JSON.stringify({
    model: QIANFAN_CODING_PROBE_MODEL,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
  });
  const result = await httpReq(`${root}/v1/messages`, {
    method: 'POST', headers, body, timeout: 10000,
  });
  if (result.error) throw new Error(result.error);
  const code = qianfanCodingErrorCode(result.body);
  const message = qianfanCodingErrorMessage(code);
  if (message) throw new Error(message);
  if (result.status === 200 || result.status === 400) return qianfanCodingModels();
  if (result.status === 401) throw new Error('百度千帆 Token Plan API Key 无效');
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

  const fallback = getFallbackModels(baseUrl);
  if (fallback && (result.status === 200 || result.status === 403 || result.status === 404 || result.status === 405)) {
    headers['content-type'] = 'application/json';
    let probeResult;
    for (const probeModel of getProbeModels(baseUrl)) {
      const body = JSON.stringify({
        model: probeModel,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      });
      probeResult = await httpReq(`${root}/v1/messages`, {
        method: 'POST', headers, body, timeout: 10000,
      });
      if (probeResult.error) throw new Error(probeResult.error);
      if (probeResult.status === 200 || probeResult.status === 400) return fallback;
      if (isModelAccessFailure(probeResult.status, probeResult.body)) continue;
      if (getAuthenticatedResourceFailureMessage(probeResult.status, probeResult.body)) return fallback;
      if (probeResult.status === 401) throw new Error('API Key 无效');
      break;
    }
    if (probeResult && isModelAccessFailure(probeResult.status, probeResult.body)) return fallback;
    throw new Error(`HTTP ${probeResult?.status || 0}`);
  }
  if (result.status === 404 || result.status === 405) throw new Error('不支持模型列表接口');
  throw new Error(`HTTP ${result.status}`);
}

function httpReq(url, options) {
  return new Promise((resolve) => {
    const parsed = new (require('url').URL)(url);
    const mod = parsed.protocol === 'https:' ? require('https') : require('http');
    const req = mod.request(url, options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', err => resolve({ status: 0, error: err.message }));
    if (options.body) req.write(options.body);
    req.setTimeout(options.timeout || 10000, () => { req.destroy(); resolve({ status: 0, error: 'Timeout' }); });
    req.end();
  });
}

// ─── Deep Link: Provider Export / Import ───

const PROVIDER_CODE_PREFIX = 'okit-provider:';
const PROVIDER_CODE_SALT = 'okit-provider-salt';


  return { readCodexCachedModels, readGrokCliModels, readCopilotCliModels, withNativeAvailability, replaceRemoteModels, fetchModels, fetchOpenAIModels, fetchQianfanCodingModels, fetchQianfanCodingAnthropicModels, fetchAnthropicModels };
}
module.exports = { createModelDiscoveryService };
