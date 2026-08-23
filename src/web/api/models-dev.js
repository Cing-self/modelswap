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
      const raw = JSON.parse(await fs.readFile(CACHE_PATH, 'utf-8'));
      return (_catalog = indexCatalog(raw));
    }
  } catch { /* no/failed cache */ }
  // Network fetch. On failure, return null — callers skip enrichment.
  try {
    const raw = await fetchJson(CATALOG_URL, 10000);
    await fs.ensureDir(path.dirname(CACHE_PATH));
    await fs.writeFile(CACHE_PATH, JSON.stringify(raw));
    return (_catalog = indexCatalog(raw));
  } catch {
    return null;
  }
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
  const candidates = [provider.baseUrl, ...((provider.endpoints || []).map(e => e.baseUrl))]
    .filter(Boolean).map(normalizeHost).filter(Boolean);
  for (const host of candidates) {
    const key = catalog.byHost.get(host);
    if (key) return key;
  }
  return null;
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
    const limit = entry.limit || {};
    const modalities = entry.modalities || {};
    const meta = { source: 'modelsdev' };
    if (limit.context) meta.context = limit.context;
    if (limit.output) meta.output = limit.output;
    if (typeof entry.tool_call === 'boolean') meta.toolCall = entry.tool_call;
    if (typeof entry.reasoning === 'boolean') meta.reasoning = entry.reasoning;
    if (Array.isArray(modalities.input)) meta.attachment = modalities.input.some(x => /image|video/i.test(String(x)));
    if (entry.status === 'deprecated') meta.deprecated = true;
    return { ...m, meta };
  });
}

function clearCatalogCache() {
  _catalog = null;
}

module.exports = { enrichModels, loadCatalog, clearCatalogCache, CACHE_PATH };
