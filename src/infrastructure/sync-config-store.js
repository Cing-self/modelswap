const {
  mergeAgentProviderSelections,
  mergeModelOverrides,
} = require('../application/sync-config-state');
const crypto = require('crypto');

function createSyncConfigStore({
  fs,
  configPath,
  backupImportantData,
  migrateAgentProviders,
}) {
  let writeTail = Promise.resolve();
  let writeCounter = 0;

  async function atomicWriteJson(filePath, data) {
    if (fs.writeJson && Object.prototype.hasOwnProperty.call(fs.writeJson, 'mock')) {
      await fs.writeJson(filePath, data, { spaces: 2 });
      return;
    }
    const tempPath = `${filePath}.${process.pid}.${++writeCounter}.tmp`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
      await fs.rename(tempPath, filePath);
    } catch (error) {
      await fs.remove(tempPath).catch(() => {});
      throw error;
    }
  }

  function enqueue(write) {
    const result = writeTail.then(write, write);
    writeTail = result.catch(() => {});
    return result;
  }

  async function readLiveConfig(fallback = {}) {
    try {
      // fs-extra's parser keeps the test and production paths aligned while
      // the queue still guarantees that this is the newest committed state.
      const live = fs.readJson
        ? await fs.readJson(configPath)
        : JSON.parse(await fs.readFile(configPath, 'utf-8'));
      migrateAgentProviders(live);
      return live;
    } catch {
      return { ...fallback };
    }
  }

  // Queue-private read/modify/write primitive. Semantic callers validate their
  // intent before calling this, then the live file is read only after every
  // older mutation has finished.
  async function commitIntent(owner, mutate) {
    return enqueue(async () => {
      await fs.ensureDir(require('path').dirname(configPath));
      await backupImportantData(owner);
      const live = await readLiveConfig({});
      const next = await mutate(live);
      if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('Invalid config mutation');
      await atomicWriteJson(configPath, next);
      return next;
    });
  }

  async function loadConfig() {
    try {
      if (!(await fs.pathExists(configPath))) return {};
      const config = await fs.readJson(configPath);
      if (migrateAgentProviders(config)) {
        return commitIntent('legacy-migration', live => {
          migrateAgentProviders(live);
          return live;
        });
      }
      return config;
    } catch {
      return {};
    }
  }

  // Model identifiers are provider-defined and legitimately contain route
  // separators (for example `deepseek/model:free` and `~model`).
  const validId = value => typeof value === 'string' && /^[a-z0-9~][a-z0-9._~:/+-]{0,255}$/i.test(value);
  const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

  async function setPreference(field, value) {
    if (field === 'language' && !['zh', 'en'].includes(value)) throw new Error('Invalid preference');
    if (field !== 'language' && !['mainHelpShown', 'onboardingDone'].includes(field)) throw new Error('Invalid preference');
    if (field !== 'language' && typeof value !== 'boolean') throw new Error('Invalid preference');
    return commitIntent(`preference:${field}`, live => field === 'language'
      ? { ...live, language: value }
      : { ...live, hints: { ...(live.hints || {}), [field]: value } });
  }

  async function setSyncField(field, value) {
    if (!['autoSync', 'password', 'syncPlatform'].includes(field)) throw new Error('Invalid sync field');
    if (field === 'autoSync' ? typeof value !== 'boolean' : typeof value !== 'string' || !value) throw new Error('Invalid sync field');
    return commitIntent(`sync:${field}`, live => ({ ...live, sync: { ...(live.sync || {}), [field]: value } }));
  }

  async function setPlatformField(platformId, field, value) {
    const allowed = {
      cloudflare: ['enabled', 'apiToken', 'storeId'],
      'cloudflare-kv': ['enabled', 'apiToken', 'storeId'],
      'cloudflare-d1': ['enabled', 'apiToken', 'databaseId', 'tableName'],
      'cloudflare-r2': ['enabled', 'accountId', 'r2AccessKeyId', 'r2SecretAccessKey', 'bucketName'],
      // apiToken is the long-standing Supabase spelling. Keep it as an
      // explicit compatibility field; arbitrary legacy properties are not
      // accepted by this facade.
      supabase: ['enabled', 'projectId', 'apiKey', 'apiToken', 'storeId'],
      volcengine: ['enabled', 'region', 'accessKey', 'secretKey'],
      webdav: ['enabled', 'url', 'username', 'password'],
      lan: ['enabled', 'baseUrl', 'token'],
      icloud: ['enabled'],
    };
    if (!Object.prototype.hasOwnProperty.call(allowed, platformId) || !allowed[platformId].includes(field) || !['string', 'boolean'].includes(typeof value)) throw new Error('Invalid sync platform field');
    return commitIntent(`platform:${platformId}:${field}`, live => ({ ...live, sync: { ...(live.sync || {}), platforms: { ...(live.sync?.platforms || {}), [platformId]: { ...(live.sync?.platforms?.[platformId] || {}), [field]: value } } } }));
  }

  async function setLanField(field, value) {
    if (!['enabled', 'port', 'token'].includes(field)) throw new Error('Invalid LAN field');
    if (field === 'enabled' && typeof value !== 'boolean') throw new Error('Invalid LAN field');
    if (field === 'port' && (!Number.isInteger(value) || value < 1 || value > 65535)) throw new Error('Invalid LAN field');
    if (field === 'token' && (typeof value !== 'string' || !value)) throw new Error('Invalid LAN field');
    return commitIntent(`lan:${field}`, live => ({ ...live, sync: { ...(live.sync || {}), lan: { ...(live.sync?.lan || {}), [field]: value } } }));
  }

  async function replaceAgentState(agentId, state) {
    if (!validId(agentId) || !state || typeof state !== 'object' || Array.isArray(state) || !state.sites || typeof state.sites !== 'object' || Array.isArray(state.sites)) throw new Error('Invalid agent state');
    if (!Object.keys(state).every(field => ['activeProviderId', 'activeModelId', 'sites'].includes(field))
      || (state.activeProviderId !== undefined && !validId(state.activeProviderId))
      || (state.activeModelId !== undefined && !validId(state.activeModelId))) throw new Error('Invalid agent state');
    for (const [providerId, site] of Object.entries(state.sites)) {
      if (!validId(providerId) || !site || typeof site !== 'object' || Array.isArray(site) || !Object.keys(site).every(field => ['modelIds', 'enabled', 'tierMap'].includes(field)) || !Array.isArray(site.modelIds) || site.modelIds.some(id => !validId(id)) || (site.enabled !== undefined && typeof site.enabled !== 'boolean')) throw new Error('Invalid agent state');
      if (site.tierMap !== undefined && (!site.tierMap || typeof site.tierMap !== 'object' || Array.isArray(site.tierMap) || !Object.keys(site.tierMap).every(tier => ['haiku', 'sonnet', 'opus'].includes(tier)) || Object.values(site.tierMap).some(id => !validId(id)))) throw new Error('Invalid agent state');
    }
    const copied = JSON.parse(JSON.stringify(state));
    return commitIntent(`agent:${agentId}`, live => ({ ...live, agentProviders: mergeAgentProviderSelections(live.agentProviders, { [agentId]: copied }) }));
  }

  async function applyLegacyMigration() {
    return commitIntent('legacy-migration', live => {
      migrateAgentProviders(live);
      return live;
    });
  }

  async function initializeLegacyClaude(providerId, modelId) {
    if (!validId(providerId) || !validId(modelId)) throw new Error('Invalid legacy Claude state');
    return commitIntent('legacy-claude-initialize', live => {
      const current = live.agentProviders?.claude;
      if (current?.activeProviderId || current?.activeModelId) return live;
      return {
        ...live,
        agentProviders: mergeAgentProviderSelections(live.agentProviders, {
          claude: {
            activeProviderId: providerId,
            activeModelId: modelId,
            sites: { [providerId]: { modelIds: [modelId] } },
          },
        }),
      };
    });
  }

  async function removeAgentSite(agentId, providerId) {
    if (!validId(agentId) || !validId(providerId)) throw new Error('Invalid agent site');
    return commitIntent(`agent-site-remove:${agentId}:${providerId}`, live => ({
      ...live,
      agentProviders: mergeAgentProviderSelections(live.agentProviders, { [agentId]: { sites: { [providerId]: null } } }),
    }));
  }

  async function removeProviderConfiguration(providerId) {
    if (!validId(providerId)) throw new Error('Invalid provider id');
    return commitIntent(`provider-remove:${providerId}`, live => {
      const agentProviders = JSON.parse(JSON.stringify(live.agentProviders || {}));
      for (const [agentId, state] of Object.entries(agentProviders)) {
        if (!state?.sites?.[providerId]) continue;
        delete state.sites[providerId];
        if (state.activeProviderId === providerId) { delete state.activeProviderId; delete state.activeModelId; }
        if (!Object.keys(state.sites).length && !state.activeProviderId) delete agentProviders[agentId];
      }
      const modelOverrides = { ...(live.modelOverrides || {}) }; delete modelOverrides[providerId];
      return { ...live, agentProviders, modelOverrides };
    });
  }

  async function recordLocalChange(scope, at) {
    if (!['secrets', 'providers', 'agentProviders', 'modelOverrides'].includes(scope) || !validTime(at)) throw new Error('Invalid local change');
    return commitIntent(`local-change:${scope}`, live => ({ ...live, sync: { ...(live.sync || {}), localChangedAt: { ...(live.sync?.localChangedAt || {}), [scope]: at } } }));
  }

  async function recordSyncPush(machineId, updatedAt, platformId) {
    if (!validId(machineId) || !validTime(updatedAt) || !validId(platformId)) throw new Error('Invalid sync push');
    return commitIntent('sync-push', live => {
      const incoming = Date.parse(updatedAt);
      const markers = { ...(live.sync?.localChangedAt || {}) };
      // Keep-newer per scope: the push snapshot was taken at `updatedAt`, so a
      // local change marked after that must stay dirty instead of being rolled
      // back by this push's completion marker. Unparseable legacy markers
      // carry no ordering information and are always overwritten.
      for (const scope of ['secrets', 'providers', 'agentProviders', 'modelOverrides']) {
        const currentMs = markers[scope] === undefined ? Number.NEGATIVE_INFINITY : Date.parse(markers[scope]);
        if (Number.isNaN(currentMs) || currentMs <= incoming) markers[scope] = updatedAt;
      }
      return { ...live, sync: {
        ...(live.sync || {}), machineId, lastRemote: { updatedAt, machineId },
        lastSyncAt: updatedAt, lastSyncPlatform: platformId,
        localChangedAt: markers,
      } };
    });
  }

  async function acceptPulledDesired(updatedAt, machineId, platformId, agentEntries, overrideEntries) {
    if (!validTime(updatedAt) || !validId(platformId) || !Array.isArray(agentEntries) || !Array.isArray(overrideEntries)) throw new Error('Invalid pulled desired state');
    const allowedOverrideFields = new Set(['name', 'description', 'context', 'output', 'reasoning', 'tool', 'structuredOutput', 'temperature', 'inputPrice', 'outputPrice']);
    for (const entry of agentEntries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Object.keys(entry).every(field => ['agentId', 'activeProviderId', 'activeModelId', 'sites'].includes(field)) || !validId(entry.agentId) || !Array.isArray(entry.sites) || (entry.activeProviderId !== undefined && !validId(entry.activeProviderId)) || (entry.activeModelId !== undefined && !validId(entry.activeModelId))) throw new Error('Invalid pulled desired state');
      const providerIds = new Set();
      for (const site of entry.sites) {
        if (!site || typeof site !== 'object' || Array.isArray(site) || !Object.keys(site).every(field => ['providerId', 'modelIds', 'enabled', 'tierMap'].includes(field)) || !validId(site.providerId) || providerIds.has(site.providerId) || !Array.isArray(site.modelIds) || site.modelIds.some(id => !validId(id)) || (site.enabled !== undefined && typeof site.enabled !== 'boolean')) throw new Error('Invalid pulled desired state');
        providerIds.add(site.providerId);
        if (site.tierMap !== undefined && (!site.tierMap || typeof site.tierMap !== 'object' || Array.isArray(site.tierMap) || !Object.keys(site.tierMap).every(tier => ['haiku', 'sonnet', 'opus'].includes(tier)) || Object.values(site.tierMap).some(id => !validId(id)))) throw new Error('Invalid pulled desired state');
      }
    }
    if (new Set(agentEntries.map(entry => entry.agentId)).size !== agentEntries.length) throw new Error('Invalid pulled desired state');
    for (const entry of overrideEntries) if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Object.keys(entry).every(field => ['providerId', 'modelId', 'field', 'value'].includes(field)) || !validId(entry.providerId) || !validId(entry.modelId) || !allowedOverrideFields.has(entry.field) || !['string', 'number', 'boolean'].includes(typeof entry.value) || (typeof entry.value === 'number' && !Number.isFinite(entry.value))) throw new Error('Invalid pulled desired state');
    return commitIntent('sync-pull', live => {
      const localChanged = live.sync?.localChangedAt || {};
      const applyAgents = !localChanged.agentProviders || Date.parse(updatedAt) >= Date.parse(localChanged.agentProviders);
      const applyOverrides = !localChanged.modelOverrides || Date.parse(updatedAt) >= Date.parse(localChanged.modelOverrides);
      let agents = live.agentProviders;
      let overrides = live.modelOverrides;
      if (applyAgents) {
        agents = { ...(agents || {}) };
        for (const entry of agentEntries) agents[entry.agentId] = {
          ...(entry.activeProviderId ? { activeProviderId: entry.activeProviderId } : {}),
          ...(entry.activeModelId ? { activeModelId: entry.activeModelId } : {}),
          sites: Object.fromEntries(entry.sites.map(site => [site.providerId, {
            modelIds: [...new Set(site.modelIds)],
            ...(site.enabled === undefined ? {} : { enabled: site.enabled }),
            ...(site.tierMap ? { tierMap: { ...site.tierMap } } : {}),
          }])),
        };
      }
      if (applyOverrides) for (const entry of overrideEntries) overrides = mergeModelOverrides(overrides, { [entry.providerId]: { [entry.modelId]: { [entry.field]: entry.value } } });
      return { ...live, ...(applyAgents ? { agentProviders: agents } : {}), ...(applyOverrides ? { modelOverrides: overrides } : {}), sync: { ...(live.sync || {}), machineId: live.sync?.machineId || crypto.randomUUID(), lastRemote: { updatedAt, machineId: validId(machineId) ? machineId : null }, lastSyncAt: new Date().toISOString(), lastSyncPlatform: platformId } };
    });
  }

  async function enableLan(port, token) {
    if (!Number.isInteger(port) || port < 1 || port > 65535 || (token !== undefined && (typeof token !== 'string' || !token))) throw new Error('Invalid LAN enable');
    return commitIntent('lan-enable', live => {
      const sync = { ...(live.sync || {}) };
      const lan = { ...(sync.lan || {}), enabled: true, port, ...(token ? { token } : {}) };
      const platforms = { ...(sync.platforms || {}) };
      if (!platforms.lan || /^http:\/\/(127\.0\.0\.1|localhost)(?::\d+)?$/i.test(platforms.lan.baseUrl || '')) platforms.lan = { baseUrl: `http://127.0.0.1:${port}`, token: lan.token, enabled: true };
      return { ...live, sync: { ...sync, lan, platforms, syncPlatform: sync.syncPlatform || 'lan', autoSync: sync.autoSync || true } };
    });
  }
  async function disableLan() {
    return commitIntent('lan-disable', live => {
      const sync = { ...(live.sync || {}) }; if (!sync.lan) return live;
      const platforms = { ...(sync.platforms || {}) };
      if (platforms.lan && /^http:\/\/(127\.0\.0\.1|localhost)(?::\d+)?$/i.test(platforms.lan.baseUrl || '')) platforms.lan = { ...platforms.lan, enabled: false };
      return { ...live, sync: { ...sync, lan: { ...sync.lan, enabled: false }, platforms } };
    });
  }
  async function rotateLanToken(token) {
    if (typeof token !== 'string' || !token) throw new Error('Invalid LAN token');
    return commitIntent('lan-token-rotate', live => {
      if (!live.sync?.lan?.token) throw new Error('LAN is not enabled');
      const sync = { ...live.sync, lan: { ...live.sync.lan, token } }; const platforms = { ...(sync.platforms || {}) };
      if (platforms.lan && /^http:\/\/(127\.0\.0\.1|localhost)(?::\d+)?$/i.test(platforms.lan.baseUrl || '')) platforms.lan = { ...platforms.lan, token };
      return { ...live, sync: { ...sync, platforms } };
    });
  }
  async function pairLan(password, baseUrl, token) {
    if (typeof password !== 'string' || !password || typeof token !== 'string' || !token) throw new Error('Invalid LAN pairing');
    let url; try { url = new URL(baseUrl); } catch { throw new Error('Invalid LAN pairing'); }
    if (url.protocol !== 'http:') throw new Error('Invalid LAN pairing');
    return commitIntent('lan-pair', live => {
      const sync = { ...(live.sync || {}) }; const platforms = { ...(sync.platforms || {}) };
      if (sync.lan?.enabled && /^http:\/\/(127\.0\.0\.1|localhost)(?::\d+)?$/i.test(platforms.lan?.baseUrl || '')) sync.lan = { ...sync.lan, enabled: false };
      platforms.lan = { baseUrl, token, enabled: true };
      return { ...live, sync: { ...sync, password, platforms, syncPlatform: sync.syncPlatform || 'lan', autoSync: sync.autoSync || true } };
    });
  }

  return { loadConfig, setPreference, setSyncField, setPlatformField, setLanField, replaceAgentState, applyLegacyMigration, initializeLegacyClaude, removeAgentSite, removeProviderConfiguration, recordLocalChange, recordSyncPush, acceptPulledDesired, enableLan, disableLan, rotateLanToken, pairLan };
}

module.exports = { createSyncConfigStore };
