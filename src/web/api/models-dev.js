// models.dev catalog integration — the de-facto industry standard for model
// metadata (consumed by opencode, MiMo Code, and Kimi Code's kosong catalog).
// Platform /models endpoints return little more than model ids; this module
// enriches fetched models with context/output limits, tool-call, reasoning,
// and multimodal support looked up from the catalog, keyed by API host.
//
// Resilience: catalog is cached at ~/.okit/cache/models-dev.json (24h TTL).
// If the fetch fails (offline), enrichment is simply skipped — OKIT must
// never depend on other tools' local data being present on the machine.

const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const https = require('https');

const CACHE_PATH = path.join(os.homedir(), '.okit', 'cache', 'models-dev.json');
const CATALOG_URL = 'https://models.dev/api.json';
const TTL_MS = 24 * 60 * 60 * 1000;

let _catalog = null; // { providers: { key: entry }, byHost: Map, globalIds: Map }

function normalizeHost(url) {
  try {
    return new URL(String(url)).host.toLowerCase();
  } catch {
    return null;
  }
}

function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

async function loadCatalog() {
  // Memory cache
  if (_catalog) return _catalog;
  // Disk cache (fresh enough)
  try {
    const st = await fs.stat(CACHE_PATH);
    if (Date.now() - st.mtimeMs < TTL_MS) {
      const cached = JSON.parse(await fs.readFile(CACHE_PATH, 'utf-8'));
      // v2 records provenance while accepting old bare api.json snapshots.
      const raw = cached && cached.data && cached.source === 'models.dev' ? cached.data : cached;
      return (_catalog = indexCatalog(raw));
    }
  } catch { /* no/failed cache */ }
  // Network fetch. On failure, return null — callers skip enrichment.
  try {
    const raw = await fetchJson(CATALOG_URL, 10000);
    await fs.ensureDir(path.dirname(CACHE_PATH));
    await fs.writeFile(CACHE_PATH, JSON.stringify({
      source: 'models.dev', version: 1, fetchedAt: new Date().toISOString(), data: raw,
    }));
    return (_catalog = indexCatalog(raw));
  } catch {
    return null;
  }
}

/** Fresh network-only catalog for the standalone data demo.
 * Never reads or writes OKIT's disk cache, so a failed request stays failed
 * instead of silently presenting yesterday's data as current data.
 */
async function loadFreshCatalog() {
  const raw = await fetchJson(CATALOG_URL, 15000);
  return indexCatalog(raw);
}

function indexCatalog(raw) {
  const providers = raw || {};
  const byHost = new Map(); // api host → provider key
  const globalIds = new Map(); // model id → [providerKey, ...] (for unique-id fallback)
  for (const [key, entry] of Object.entries(providers)) {
    const host = normalizeHost(entry && entry.api);
    if (host && !byHost.has(host)) byHost.set(host, key);
    for (const mid of Object.keys((entry && entry.models) || {})) {
      const id = mid.includes('/') ? mid.split('/').slice(1).join('/') : mid;
      if (!globalIds.has(id)) globalIds.set(id, []);
      globalIds.get(id).push(key);
    }
  }
  return { providers, byHost, globalIds };
}

// Resolve the catalog provider key for an OKIT provider: match by API host
// (baseUrl first, then each endpoint's baseUrl) — hosts are stable and match
// even when our preset ids differ from catalog keys.
function resolveCatalogKey(catalog, provider) {
  if (catalog.providers[provider.id]) return provider.id;
  const candidates = [provider.baseUrl, ...((provider.endpoints || []).map(e => e.baseUrl))]
    .filter(Boolean).map(normalizeHost).filter(Boolean);
  for (const host of candidates) {
    const key = catalog.byHost.get(host);
    if (key) return key;
  }
  return null;
}

function findCatalogModel(catalog, provider, modelId) {
  const key = resolveCatalogKey(catalog, provider);
  const devProvider = key ? catalog.providers[key] : null;
  let entry = devProvider && (devProvider.models || {})[modelId];
  if (!entry && devProvider) {
    for (const [fullId, value] of Object.entries(devProvider.models || {})) {
      if (fullId.endsWith('/' + modelId)) { entry = value; break; }
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
  return {
    id: modelId,
    ...(remoteModel?.name || entry?.name ? { name: remoteModel?.name || entry.name } : {}),
    ...(entry?.description ? { description: entry.description } : {}),
    ...(entry?.family ? { family: entry.family } : {}),
    ...(typeof entry?.attachment === 'boolean' ? { attachment: entry.attachment } : {}),
    ...(Number.isFinite(limit.context) ? { context: limit.context } : {}),
    ...(Number.isFinite(limit.input) ? { input: limit.input } : {}),
    ...(Number.isFinite(limit.output) ? { output: limit.output } : {}),
    ...(Array.isArray(modalities.input) || Array.isArray(modalities.output) ? {
      modalities: {
        ...(Array.isArray(modalities.input) ? { input: modalities.input } : {}),
        ...(Array.isArray(modalities.output) ? { output: modalities.output } : {}),
      },
    } : {}),
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
    source,
    confidence: entry ? 'high' : 'medium',
    fetchedAt,
    raw: source === 'remote' ? { remote: remoteModel, modelsDev: entry || undefined } : entry,
  };
}

function getFreshProviderMetadata(catalog, provider) {
  const key = resolveCatalogKey(catalog, provider);
  const entry = key ? catalog.providers[key] : null;
  if (!entry) return null;
  return {
    key,
    id: entry.id,
    name: entry.name,
    api: entry.api,
    doc: entry.doc,
    env: Array.isArray(entry.env) ? entry.env : [],
    npm: entry.npm,
  };
}

function listFreshProviderModels(catalog, provider, fetchedAt = new Date().toISOString()) {
  const key = resolveCatalogKey(catalog, provider);
  const devProvider = key ? catalog.providers[key] : null;
  if (!devProvider) return [];
  return Object.entries(devProvider.models || {}).map(([modelId, entry]) =>
    metadataFromCatalog(modelId, entry, fetchedAt, 'modelsdev')
  );
}

function enrichFreshRemoteModels(catalog, provider, models, fetchedAt = new Date().toISOString()) {
  return (models || []).filter(model => model?.id).map(model =>
    metadataFromCatalog(model.id, findCatalogModel(catalog, provider, model.id), fetchedAt, 'remote', model)
  );
}

// Enrich fetched models with catalog metadata. Existing fields (id, name,
// capabilities from presets) are never overwritten — catalog data lands in a
// separate `meta` object with `source: 'modelsdev'` so downstream consumers
// can prefer it over name-based heuristics.
async function enrichModels(provider, models) {
  if (!Array.isArray(models) || models.length === 0) return models;
  const catalog = await loadCatalog();
  if (!catalog) return models;

  let devProvider = null;
  const key = resolveCatalogKey(catalog, provider);
  if (key) devProvider = catalog.providers[key] || null;

  return models.map(m => {
    if (!m || !m.id || (m.meta && m.meta.source === 'modelsdev')) return m;
    let entry = devProvider && (devProvider.models || {})[m.id];
    // Gateway models on catalog providers may be namespaced ("vendor/id").
    if (!entry && devProvider) {
      for (const [fullId, v] of Object.entries(devProvider.models || {})) {
        if (fullId.endsWith('/' + m.id)) { entry = v; break; }
      }
    }
    // Host mismatch fallback: globally-unique model id.
    if (!entry) {
      const owners = catalog.globalIds.get(m.id);
      if (owners && owners.length === 1) {
        entry = (catalog.providers[owners[0]].models || {})[m.id]
          || (catalog.providers[owners[0]].models || {})[`${owners[0]}/${m.id}`];
      }
    }
    if (!entry) return m;
    const metadata = metadataFromCatalog(m.id, entry, new Date().toISOString());
    const {
      id: _id,
      name: _name,
      source: _source,
      confidence: _confidence,
      fetchedAt: _fetchedAt,
      raw: _raw,
      tool,
      ...catalogMeta
    } = metadata;
    const meta = {
      source: 'modelsdev',
      ...catalogMeta,
      ...(tool === undefined ? {} : { toolCall: tool }),
      ...(metadata.modalities?.input ? {
        attachment: metadata.modalities.input.some(x => /image|video/i.test(String(x))),
      } : {}),
      ...(entry.status === 'deprecated' ? { deprecated: true } : {}),
    };
    return { ...m, meta };
  });
}

function clearCatalogCache() {
  _catalog = null;
}

module.exports = {
  enrichModels,
  loadCatalog,
  loadFreshCatalog,
  listFreshProviderModels,
  enrichFreshRemoteModels,
  getFreshProviderMetadata,
  clearCatalogCache,
  CACHE_PATH,
};
