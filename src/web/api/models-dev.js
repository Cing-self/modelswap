// Canonical models.dev catalog service.
//
// Every runtime consumer (provider store, /model-data, live /models
// enrichment and Agent adapters through Provider.models) uses this snapshot.
// Successful network refreshes are promoted atomically and bump a generation.
// Failed refreshes keep the last-good snapshot and never forge a new source
// timestamp or generation.

const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');

let CACHE_PATH = path.join(os.homedir(), '.modelswap', 'cache', 'models-dev.json');
const CATALOG_URL = 'https://models.dev/api.json';
const TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;
const CACHE_VERSION = 2;

let _snapshot = null; // { catalog, raw, meta }
let _loadPromise = null;
let _refreshPromise = null;
let _fetchJson = fetchJson;

function normalizeHost(url) {
  try { return new URL(String(url)).host.toLowerCase(); } catch { return null; }
}

function stableHash(raw) {
  return crypto.createHash('sha256').update(JSON.stringify(raw)).digest('hex');
}

function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

function snapshotMeta(envelope, overrides = {}) {
  return {
    source: 'models.dev',
    version: CACHE_VERSION,
    generation: Number.isInteger(envelope?.generation) && envelope.generation > 0 ? envelope.generation : 1,
    sourceFetchedAt: envelope?.sourceFetchedAt || envelope?.fetchedAt || new Date(0).toISOString(),
    cachedAt: envelope?.cachedAt || envelope?.sourceFetchedAt || envelope?.fetchedAt || new Date(0).toISOString(),
    sourceHash: envelope?.sourceHash || '',
    status: envelope?.status === 'error' || envelope?.status === 'stale' ? envelope.status : 'fresh',
    lastError: typeof envelope?.lastError === 'string' ? envelope.lastError : null,
    ...overrides,
  };
}

function isFresh(meta, now = Date.now()) {
  const fetched = Date.parse(meta?.sourceFetchedAt || '');
  return Number.isFinite(fetched) && now - fetched < TTL_MS;
}

function canUseWithoutRefresh(meta, now = Date.now()) {
  if (meta?.status === 'fresh') return isFresh(meta, now);
  // Serve last-good data during a short retry backoff after a failed refresh.
  // cachedAt is the failure-observation time; sourceFetchedAt stays untouched.
  if (meta?.status === 'stale' && meta?.lastError) {
    const attempted = Date.parse(meta.cachedAt || '');
    return Number.isFinite(attempted) && now - attempted < RETRY_AFTER_FAILURE_MS;
  }
  return false;
}

function indexCatalog(raw) {
  const providers = raw || {};
  const byHost = new Map();
  const globalIds = new Map();
  for (const [key, entry] of Object.entries(providers)) {
    const host = normalizeHost(entry && entry.api);
    if (host && !byHost.has(host)) byHost.set(host, key);
    for (const modelId of Object.keys((entry && entry.models) || {})) {
      const id = modelId.includes('/') ? modelId.split('/').slice(1).join('/') : modelId;
      if (!globalIds.has(id)) globalIds.set(id, []);
      globalIds.get(id).push(key);
    }
  }
  return { providers, byHost, globalIds };
}

function makeSnapshot(raw, envelope) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('models.dev catalog must be an object');
  const meta = snapshotMeta(envelope, { sourceHash: envelope?.sourceHash || stableHash(raw) });
  const catalog = indexCatalog(raw);
  catalog.meta = meta;
  return { raw, catalog, meta };
}

async function quarantineCorruptCache(error) {
  try {
    if (!(await fs.pathExists(CACHE_PATH))) return;
    const target = `${CACHE_PATH}.corrupt-${Date.now()}`;
    await fs.move(CACHE_PATH, target, { overwrite: false });
    console.warn(`[models.dev] quarantined corrupt cache: ${target} (${error.message})`);
  } catch { /* recovery remains best-effort */ }
}

async function readDiskSnapshot() {
  if (!(await fs.pathExists(CACHE_PATH))) return null;
  try {
    const stat = await fs.stat(CACHE_PATH);
    const parsed = JSON.parse(await fs.readFile(CACHE_PATH, 'utf-8'));
    const wrapped = parsed && parsed.source === 'models.dev' && parsed.data && typeof parsed.data === 'object';
    const raw = wrapped ? parsed.data : parsed;
    const envelope = wrapped ? parsed : {
      source: 'models.dev', version: 1, generation: 1,
      sourceFetchedAt: stat.mtime.toISOString(), cachedAt: stat.mtime.toISOString(), status: 'stale',
    };
    const snapshot = makeSnapshot(raw, envelope);
    if (!isFresh(snapshot.meta)) snapshot.meta = snapshot.catalog.meta = snapshotMeta(snapshot.meta, { status: 'stale' });
    return snapshot;
  } catch (error) {
    await quarantineCorruptCache(error);
    return null;
  }
}

async function atomicWriteSnapshot(snapshot) {
  await fs.ensureDir(path.dirname(CACHE_PATH));
  const temp = `${CACHE_PATH}.tmp-${process.pid}-${Date.now()}`;
  const previous = `${CACHE_PATH}.previous`;
  const envelope = {
    source: 'models.dev', version: CACHE_VERSION,
    generation: snapshot.meta.generation,
    sourceFetchedAt: snapshot.meta.sourceFetchedAt,
    cachedAt: snapshot.meta.cachedAt,
    sourceHash: snapshot.meta.sourceHash,
    status: snapshot.meta.status, lastError: snapshot.meta.lastError, data: snapshot.raw,
  };
  await fs.writeFile(temp, `${JSON.stringify(envelope)}\n`, 'utf-8');
  if (await fs.pathExists(CACHE_PATH)) {
    try { await fs.copy(CACHE_PATH, previous, { overwrite: true }); } catch { /* previous generation is best-effort */ }
  }
  await fs.rename(temp, CACHE_PATH);
}

async function refreshCatalog() {
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = (async () => {
    if (!_snapshot) _snapshot = await readDiskSnapshot();
    const previous = _snapshot;
    try {
      const raw = await _fetchJson(CATALOG_URL, 15000);
      const now = new Date().toISOString();
      const hash = stableHash(raw);
      const generation = previous?.meta?.sourceHash === hash
        ? previous.meta.generation
        : (previous?.meta?.generation || 0) + 1;
      const next = makeSnapshot(raw, {
        generation, sourceFetchedAt: now, cachedAt: now,
        sourceHash: hash, status: 'fresh', lastError: null,
      });
      await atomicWriteSnapshot(next);
      _snapshot = next;
      return next.catalog;
    } catch (error) {
      if (previous) {
        previous.meta = previous.catalog.meta = snapshotMeta(previous.meta, {
          cachedAt: new Date().toISOString(),
          status: 'stale', lastError: error instanceof Error ? error.message : String(error),
        });
        _snapshot = previous;
        try { await atomicWriteSnapshot(previous); } catch { /* memory state remains truthful */ }
      }
      throw error;
    } finally {
      _refreshPromise = null;
    }
  })();
  return _refreshPromise;
}

async function loadCatalog(options = {}) {
  if (options.force) return refreshCatalog();
  if (_snapshot && canUseWithoutRefresh(_snapshot.meta)) return _snapshot.catalog;
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    if (!_snapshot) _snapshot = await readDiskSnapshot();
    if (_snapshot && canUseWithoutRefresh(_snapshot.meta)) return _snapshot.catalog;
    try { return await refreshCatalog(); }
    catch { return _snapshot?.catalog || null; }
    finally { _loadPromise = null; }
  })();
  return _loadPromise;
}

// Compatibility name: a fresh request now promotes into the canonical store.
async function loadFreshCatalog() { return refreshCatalog(); }

function getCatalogState() {
  return _snapshot ? { ..._snapshot.meta, file: CACHE_PATH } : {
    source: 'models.dev', version: CACHE_VERSION, generation: 0,
    sourceFetchedAt: null, cachedAt: null, sourceHash: null,
    status: 'empty', lastError: null, file: CACHE_PATH,
  };
}

function resolveCatalogKey(catalog, provider, options = {}) {
  if (provider.modelCatalogId) {
    if (catalog.providers[provider.modelCatalogId]) return provider.modelCatalogId;
    if (options.strict) return null;
  }
  if (catalog.providers[provider.id]) return provider.id;
  if (options.strict) return null;
  const candidates = [provider.baseUrl, ...((provider.endpoints || []).map(endpoint => endpoint.baseUrl))]
    .filter(Boolean).map(normalizeHost).filter(Boolean);
  for (const host of candidates) {
    const key = catalog.byHost.get(host);
    if (key) return key;
  }
  return null;
}

function findCatalogModel(catalog, provider, modelId) {
  const key = resolveCatalogKey(catalog, provider);
  const catalogProvider = key ? catalog.providers[key] : null;
  let entry = catalogProvider && (catalogProvider.models || {})[modelId];
  if (!entry && catalogProvider) {
    for (const [fullId, value] of Object.entries(catalogProvider.models || {})) {
      if (fullId.endsWith(`/${modelId}`)) { entry = value; break; }
    }
  }
  if (!entry) {
    const owners = catalog.globalIds.get(modelId);
    if (owners && owners.length === 1) {
      entry = (catalog.providers[owners[0]].models || {})[modelId]
        || (catalog.providers[owners[0]].models || {})[`${owners[0]}/${modelId}`];
    }
  }
  return entry || null;
}

function metadataFromCatalog(modelId, entry, fetchedAt, source = 'modelsdev', remoteModel) {
  const limit = entry?.limit || {};
  const modalities = entry?.modalities || {};
  const remote = remoteModel?.remote || {};
  const remoteContext = Number.isFinite(remote.context) ? remote.context
    : Number.isFinite(remoteModel?.context_length) ? remoteModel.context_length : undefined;
  const remoteOutput = Number.isFinite(remote.output) ? remote.output
    : Number.isFinite(remoteModel?.top_provider?.max_completion_tokens) ? remoteModel.top_provider.max_completion_tokens : undefined;
  const remoteInputModalities = Array.isArray(remote.modalities?.input) ? remote.modalities.input
    : Array.isArray(remoteModel?.architecture?.input_modalities) ? remoteModel.architecture.input_modalities : undefined;
  const remoteOutputModalities = Array.isArray(remote.modalities?.output) ? remote.modalities.output
    : Array.isArray(remoteModel?.architecture?.output_modalities) ? remoteModel.architecture.output_modalities : undefined;
  return {
    id: modelId,
    ...(remoteModel?.name || entry?.name ? { name: remoteModel?.name || entry.name } : {}),
    ...(entry?.description ? { description: entry.description } : {}),
    ...(entry?.family ? { family: entry.family } : {}),
    ...(typeof entry?.attachment === 'boolean' ? { attachment: entry.attachment } : {}),
    ...(Number.isFinite(remoteContext) ? { context: remoteContext } : Number.isFinite(limit.context) ? { context: limit.context } : {}),
    ...(Number.isFinite(limit.input) ? { input: limit.input } : {}),
    ...(Number.isFinite(remoteOutput) ? { output: remoteOutput } : Number.isFinite(limit.output) ? { output: limit.output } : {}),
    ...(remoteInputModalities || remoteOutputModalities || Array.isArray(modalities.input) || Array.isArray(modalities.output) ? { modalities: {
      ...(remoteInputModalities ? { input: remoteInputModalities } : Array.isArray(modalities.input) ? { input: modalities.input } : {}),
      ...(remoteOutputModalities ? { output: remoteOutputModalities } : Array.isArray(modalities.output) ? { output: modalities.output } : {}),
    } } : {}),
    ...(typeof entry?.tool_call === 'boolean' ? { tool: entry.tool_call } : {}),
    ...(typeof entry?.reasoning === 'boolean' ? { reasoning: entry.reasoning } : {}),
    ...(Array.isArray(entry?.reasoning_options) ? { reasoningOptions: entry.reasoning_options } : {}),
    ...(typeof entry?.structured_output === 'boolean' ? { structuredOutput: entry.structured_output } : {}),
    ...(typeof entry?.temperature === 'boolean' ? { temperature: entry.temperature } : {}),
    ...(entry?.interleaved ? { interleaved: entry.interleaved } : {}),
    ...(entry?.knowledge ? { knowledge: entry.knowledge } : {}),
    ...(entry?.release_date ? { releaseDate: entry.release_date } : {}),
    ...(entry?.last_updated ? { lastUpdated: entry.last_updated } : {}),
    ...(typeof entry?.open_weights === 'boolean' ? { openWeights: entry.open_weights } : {}),
    ...(entry?.status ? { status: entry.status } : {}),
    ...(entry?.cost ? { cost: entry.cost } : {}),
    ...(entry?.provider ? { providerConfig: entry.provider } : {}),
    ...(entry?.experimental ? { experimental: entry.experimental } : {}),
    source, confidence: entry ? 'high' : 'medium', fetchedAt,
    raw: source === 'remote' ? { remote: remoteModel, modelsDev: entry || undefined } : entry,
  };
}

function getFreshProviderMetadata(catalog, provider) {
  const key = resolveCatalogKey(catalog, provider);
  const entry = key ? catalog.providers[key] : null;
  if (!entry) return null;
  return { key, id: entry.id, name: entry.name, api: entry.api, doc: entry.doc, env: Array.isArray(entry.env) ? entry.env : [], npm: entry.npm };
}

function listFreshProviderModels(catalog, provider, fetchedAt, options = {}) {
  const key = resolveCatalogKey(catalog, provider, options);
  const catalogProvider = key ? catalog.providers[key] : null;
  if (!catalogProvider) return [];
  const sourceTime = fetchedAt || catalog.meta?.sourceFetchedAt || new Date().toISOString();
  return Object.entries(catalogProvider.models || {}).map(([modelId, entry]) => metadataFromCatalog(modelId, entry, sourceTime, 'modelsdev'));
}

function enrichFreshRemoteModels(catalog, provider, models, fetchedAt) {
  const sourceTime = fetchedAt || catalog.meta?.sourceFetchedAt || new Date().toISOString();
  return (models || []).filter(model => model?.id).map(model => metadataFromCatalog(model.id, findCatalogModel(catalog, provider, model.id), sourceTime, 'remote', model));
}

async function enrichModels(provider, models) {
  if (!Array.isArray(models) || models.length === 0) return models;
  const catalog = await loadCatalog();
  if (!catalog) return models;
  return enrichFreshRemoteModels(catalog, provider, models).map((metadata, index) => {
    const original = models[index];
    const { id: _id, name: _name, source, confidence: _confidence, fetchedAt: _fetchedAt, raw: _raw, tool, ...facts } = metadata;
    const hasFacts = Object.keys(facts).length > 0;
    if (!hasFacts && !original.remote) return original;
    return {
      ...original,
      meta: {
        source: source === 'remote' ? 'remote' : 'modelsdev', ...facts,
        ...(tool === undefined ? {} : { toolCall: tool }),
        ...(facts.modalities?.input ? { attachment: facts.modalities.input.some(value => /image|video/i.test(String(value))) } : {}),
        ...(facts.status === 'deprecated' ? { deprecated: true } : {}),
      },
    };
  });
}

function clearCatalogCache() {
  _snapshot = null;
  _loadPromise = null;
  _refreshPromise = null;
}

function setTestHooks(options = {}) {
  if (typeof options.cachePath === 'string') CACHE_PATH = options.cachePath;
  if (typeof options.fetchJson === 'function') _fetchJson = options.fetchJson;
  clearCatalogCache();
}

function resetTestHooks() {
  CACHE_PATH = path.join(os.homedir(), '.modelswap', 'cache', 'models-dev.json');
  _fetchJson = fetchJson;
  clearCatalogCache();
}

const exported = {
  enrichModels, loadCatalog, loadFreshCatalog, refreshCatalog, getCatalogState,
  listFreshProviderModels, enrichFreshRemoteModels, getFreshProviderMetadata,
  resolveCatalogKey,
  clearCatalogCache,
  __testing: { indexCatalog, resolveCatalogKey, metadataFromCatalog, isFresh, canUseWithoutRefresh, stableHash, readDiskSnapshot, setTestHooks, resetTestHooks },
};
Object.defineProperty(exported, 'CACHE_PATH', { enumerable: true, get: () => CACHE_PATH });
module.exports = exported;
