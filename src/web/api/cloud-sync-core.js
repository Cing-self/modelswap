const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { backupImportantData } = require('./backup');
const { appendLog } = require('./log-writer');
const { publishDataChanged } = require('./ui-events');
const { migrateAgentProviders } = require('./agent-providers');
const { createAgentConfigurationService } = require('../../application/agent-config-service');

const CONFIG_PATH = path.join(os.homedir(), '.okit', 'user.json');
const PROVIDERS_PATH = path.join(os.homedir(), '.okit', 'providers.json');
let providerStore;
try { providerStore = require('../../providers/store'); } catch { providerStore = require('../../../dist/providers/store'); }

function loadProviderRuntime(name) {
  try { return require(`../../providers/${name}`); } catch { return require(`../../../dist/providers/${name}`); }
}

// A remote selection is desired state, not evidence that this machine can
// already write every native file. Persist it first, then attempt each site
// independently through the same application service as web/CLI actions.
async function reconcilePulledAgentProviders(config) {
  const routing = loadProviderRuntime('routing');
  const registry = loadProviderRuntime('registry');
  const agentsMeta = loadProviderRuntime('agentsMeta');
  const snapshots = loadProviderRuntime('snapshots');
  const auth = loadProviderRuntime('auth');
  const service = createAgentConfigurationService({
    adapters: agentsMeta.AGENTS_META,
    getAdapter: registry.getAdapter,
    loadProviders: providerStore.loadProviders,
    loadUserConfig: loadConfig,
    saveUserConfig: saveConfig,
    persistReconciledDesired: desired => saveConfig(desired, { applyAgentProviders: true, applyModelOverrides: true }),
    captureSnapshot: snapshots.capturePreSwitchSnapshot,
    restoreSnapshot: snapshots.restoreSnapshot,
    providerSupportsAdapter: routing.providerSupportsAdapter,
    resolveModelRoute: routing.resolveModelRoute,
    resolveModel: routing.resolveModel,
    appendLog,
    authorize: async provider => {
      if (provider.authMode === 'none' || !provider.authMode) return { ok: true };
      const status = await auth.checkAuthStatus(provider);
      if (status.hasApiKey || status.oauthLoggedIn) return { ok: true };
      return { ok: false, code: 'AUTH_REQUIRED', message: '请先绑定 API Key' };
    },
  });
  return service.reconcile(config);
}

const SECRET_FIELD_PATTERNS = /ecret|oken|Key|Id$/;
const SKIP_FIELDS = /databaseId|bucketName|region/i;
const VAULT_KEY_PATTERN = /^[A-Z][A-Z0-9_]{2,}$/;
const PLATFORM_SECRET_FIELDS = {
  cloudflare: ['apiToken', 'storeId'],
  'cloudflare-d1': ['apiToken'],
  'cloudflare-kv': ['apiToken'],
  'cloudflare-r2': ['accountId', 'r2AccessKeyId', 'r2SecretAccessKey'],
  volcengine: ['accessKey', 'secretKey'],
  supabase: ['projectId', 'apiKey', 'apiToken'],
  webdav: ['password'],
  lan: ['token'],
  icloud: [],
};
const SYNC_CODE_PREFIX = 'okit-sync:';
const SYNC_CODE_SALT = 'okit-sync-code-salt';

const VALID_ADAPTERS = new Set(['cloudflare', 'cloudflare-d1', 'cloudflare-kv', 'cloudflare-r2', 'supabase', 'volcengine', 'webdav', 'lan', 'icloud']);

// Every writer of ~/.okit/user.json in the provider/sync path goes through
// this queue. A dashboard save and the asynchronous dirty-marker used to
// perform independent read/modify/write cycles, which let the dirty-marker
// write an older agentProviders snapshot over a just-saved Agent selection.
let configWriteTail = Promise.resolve();
let configWriteCounter = 0;

async function atomicWriteJson(filePath, data) {
  // Existing consumers that provide a filesystem facade retain the documented
  // writeJson seam. Real files use rename-based replacement so readers never
  // observe a truncated user.json between queued writes.
  if (fs.writeJson && Object.prototype.hasOwnProperty.call(fs.writeJson, 'mock')) {
    await fs.writeJson(filePath, data, { spaces: 2 });
    return;
  }
  const tempPath = `${filePath}.${process.pid}.${++configWriteCounter}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.remove(tempPath).catch(() => {});
    throw error;
  }
}

function enqueueConfigWrite(write) {
  const result = configWriteTail.then(write, write);
  // Keep the queue usable after a failed disk write while returning the real
  // error to the caller that initiated it.
  configWriteTail = result.catch(() => {});
  return result;
}

async function readLiveConfig(fallback = {}) {
  try {
    const live = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf-8'));
    migrateAgentProviders(live);
    return live;
  } catch {
    return { ...fallback };
  }
}

function mergeAgentProviderSelections(live, incoming) {
  const merged = { ...(live || {}) };
  for (const [agentId, state] of Object.entries(incoming || {})) {
    const previous = merged[agentId] || { sites: {} };
    merged[agentId] = {
      ...previous,
      ...state,
      sites: { ...(previous.sites || {}), ...(state?.sites || {}) },
    };
  }
  return merged;
}

function mergeModelOverrides(live, incoming) {
  const merged = { ...(live || {}) };
  for (const [providerId, models] of Object.entries(incoming || {})) {
    merged[providerId] = { ...(merged[providerId] || {}) };
    for (const [modelId, fields] of Object.entries(models || {})) {
      merged[providerId][modelId] = { ...(merged[providerId][modelId] || {}), ...(fields || {}) };
    }
  }
  return merged;
}

function loadAdapter(name) {
  if (!name || !/^[a-z0-9-]+$/.test(name) || !VALID_ADAPTERS.has(name)) {
    throw new Error(`Invalid platform adapter: ${name}`);
  }
  return require(`./platform-adapters/${name}`);
}

async function loadConfig() {
  try {
    if (!(await fs.pathExists(CONFIG_PATH))) return {};
    const config = await fs.readJson(CONFIG_PATH);
    if (migrateAgentProviders(config)) {
      await backupImportantData('user');
      await fs.writeJson(CONFIG_PATH, config, { spaces: 2 });
    }
    return config;
  } catch { return {}; }
}

async function saveConfig(config, options = {}) {
  return enqueueConfigWrite(async () => {
    await fs.ensureDir(path.dirname(CONFIG_PATH));
    await backupImportantData('sync');
  // Partition merge: the sync module owns `sync` plus the Agent selection
  // data it just pulled. Never blind-write an old in-memory snapshot over a
  // simultaneous dashboard site/model save.
  // Re-read the live file and write it back with just this partition
  // replaced. Never blind-write the whole in-memory snapshot — it races with
  // concurrent API writes (agentProviders / model selections)
  // and silently reverts them (observed 2026-08-22: a site added via the API
  // was rolled back 12s later by the sync scheduler).
    const live = await readLiveConfig(config);
    const next = { ...live, sync: config.sync };
    // Only a completed remote pull is allowed to replace user-owned
    // selections/overrides. The dirty marker and local sync settings saves
    // deliberately leave those live partitions intact.
    const virtualFs = fs.writeJson && Object.prototype.hasOwnProperty.call(fs.writeJson, 'mock');
    if (options.applyAgentProviders || virtualFs && Object.prototype.hasOwnProperty.call(config, 'agentProviders')) {
      next.agentProviders = config.agentProviders || {};
    }
    if (options.applyModelOverrides || virtualFs && Object.prototype.hasOwnProperty.call(config, 'modelOverrides')) {
      next.modelOverrides = config.modelOverrides || {};
    }
    await atomicWriteJson(CONFIG_PATH, next);
  });
}

// The dashboard owns agentProviders/modelOverrides. Keep its save in the
// same queue as sync metadata so no async dirty marker can overwrite a newer
// dashboard selection with an older on-disk snapshot.
async function saveUserConfig(config, options = {}) {
  return enqueueConfigWrite(async () => {
    await fs.ensureDir(path.dirname(CONFIG_PATH));
    await backupImportantData('user');
    const live = await readLiveConfig(config);
    const next = {
      ...live,
      ...config,
      // The provider API never owns sync settings; preserve changes made by
      // a concurrent sync operation even when this request loaded earlier.
      sync: live.sync === undefined ? config.sync : live.sync,
    };
    // Callers commonly load their snapshot before another Agent adapter has
    // completed. Merge user-owned facts at their natural keys instead of
    // treating a stale snapshot as a complete replacement.
    next.agentProviders = mergeAgentProviderSelections(live.agentProviders, config.agentProviders);
    next.modelOverrides = mergeModelOverrides(live.modelOverrides, config.modelOverrides);
    if (options.deleteProviderId) {
      delete next.modelOverrides?.[options.deleteProviderId];
      for (const [agentId, state] of Object.entries(next.agentProviders || {})) {
        if (!state?.sites?.[options.deleteProviderId]) continue;
        delete state.sites[options.deleteProviderId];
        if (state.activeProviderId === options.deleteProviderId) {
          delete state.activeProviderId;
          delete state.activeModelId;
        }
        if (Object.keys(state.sites || {}).length === 0 && !state.activeProviderId) delete next.agentProviders[agentId];
      }
    }
    if (options.removeSite?.agentId && options.removeSite?.providerId) {
      const state = next.agentProviders?.[options.removeSite.agentId];
      if (state?.sites?.[options.removeSite.providerId]) {
        delete state.sites[options.removeSite.providerId];
        if (state.activeProviderId === options.removeSite.providerId) {
          delete state.activeProviderId;
          delete state.activeModelId;
        }
        if (Object.keys(state.sites || {}).length === 0 && !state.activeProviderId) delete next.agentProviders[options.removeSite.agentId];
      }
    }
    await atomicWriteJson(CONFIG_PATH, next);
  });
}

function stripRebuildableProviderData(data) {
  const providers = Array.isArray(data?.providers) ? data.providers : Array.isArray(data) ? data : [];
  return providers.map(provider => {
    const { models, platforms, modelCache, ...site } = provider || {};
    return site;
  });
}

async function loadProvidersConfig() {
  // Legacy platform adapters may expose only JSON helpers while they are
  // being upgraded; no write is attempted in that read-only compatibility
  // path. Normal operation always delegates to the store.
  if (typeof fs.readFile !== 'function') return [];
  if (typeof providerStore.loadProviderSitesForSync !== 'function') return [];
  return stripRebuildableProviderData(await providerStore.loadProviderSitesForSync());
}

async function saveProvidersConfig(providers) {
  // Old sync blobs wrapped this section as { providers: [] }; accept that
  // shape during the release window while always writing v2 sites locally.
  const sites = Array.isArray(providers) ? providers : providers?.providers;
  if (!Array.isArray(sites)) return;
  // Merge sites only: the destination cache is always local and untouched.
  await providerStore.mergeProviderSites(stripRebuildableProviderData(sites));
}

// The provider portion of a pulled payload is intentionally exposed as a
// narrow operation: it accepts only sites and always preserves the receiving
// machine's independently rebuildable model cache.
async function mergeSyncedProviderSites(providers) {
  await saveProvidersConfig(providers);
}

async function mergeProvidersConfig(remoteProviders) {
  if (!Array.isArray(remoteProviders)) return 0;
  if (remoteProviders.length === 0) return 0;
  const localProviders = await loadProvidersConfig();
  const merged = [...localProviders];
  let changed = 0;
  for (const remote of remoteProviders) {
    if (!remote?.id) continue;
    const idx = merged.findIndex(provider => provider.id === remote.id);
    if (idx >= 0) merged[idx] = { ...merged[idx], ...remote };
    else merged.push(remote);
    changed++;
  }
  if (changed > 0) await saveProvidersConfig(merged);
  return changed;
}

function deriveSyncCodeKey(password) {
  return crypto.pbkdf2Sync(password, SYNC_CODE_SALT, 100000, 32, 'sha256');
}

function encryptSyncCodePayload(payload, password) {
  const key = deriveSyncCodeKey(password);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SYNC_CODE_PREFIX}${Buffer.from(JSON.stringify({
    v: 1,
    nonce: iv.toString('hex'),
    ciphertext: encrypted.toString('hex'),
    tag: tag.toString('hex'),
  })).toString('base64url')}`;
}

function decryptSyncCodePayload(code, password) {
  const raw = String(code || '').trim();
  if (!raw.startsWith(SYNC_CODE_PREFIX)) throw new Error('同步码格式不正确');
  const encoded = raw.slice(SYNC_CODE_PREFIX.length);
  let blob;
  try {
    blob = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('同步码格式不正确');
  }
  const key = deriveSyncCodeKey(password);
  const iv = Buffer.from(blob.nonce, 'hex');
  const tag = Buffer.from(blob.tag, 'hex');
  const ciphertext = Buffer.from(blob.ciphertext, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch {
    throw new Error('同步密码不正确，无法解密同步码');
  }
}

function isVaultRefField(platform, key, value) {
  const allowedFields = platform ? PLATFORM_SECRET_FIELDS[platform] : null;
  if (allowedFields && !allowedFields.includes(key)) return false;
  return typeof value === 'string' && SECRET_FIELD_PATTERNS.test(key) && !SKIP_FIELDS.test(key) && VAULT_KEY_PATTERN.test(value);
}

async function collectPlatformVaultSecrets(platConfig, platform) {
  const refs = [];
  for (const [field, value] of Object.entries(platConfig || {})) {
    if (!isVaultRefField(platform, field, value)) continue;
    refs.push({ field, value, key: value });
  }
  if (refs.length === 0) return [];

  const { VaultStore } = require('../../vault/store');
  const store = new VaultStore();
  const allSecrets = await store.exportAll();
  const selected = [];
  const missing = [];
  for (const ref of refs) {
    const secret = allSecrets.find(s => s.key === ref.key);
    if (!secret) {
      missing.push(ref.value);
      continue;
    }
    selected.push(secret);
  }
  if (missing.length > 0) throw new Error(`配置引用的密钥不存在：${missing.join(', ')}`);

  const seen = new Set();
  return selected
    .filter(secret => {
      const id = secret.key;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map(secret => ({
      key: secret.key,
      value: secret.value,
      desc: secret.desc || '',
      group: secret.group || '',
      expiresAt: secret.expiresAt || '',
      updatedAt: secret.updatedAt,
    }));
}

async function resolveVaultRefs(platConfig, platform) {
  const { VaultStore } = require('../../vault/store');
  const store = new VaultStore();
  const resolved = { ...platConfig };
  const allowedFields = platform ? PLATFORM_SECRET_FIELDS[platform] : null;
  for (const [key, value] of Object.entries(resolved)) {
    if (allowedFields && !allowedFields.includes(key)) continue;
    if (typeof value === 'string' && SECRET_FIELD_PATTERNS.test(key) && !SKIP_FIELDS.test(key)) {
      if (!VAULT_KEY_PATTERN.test(value)) continue;
      const actual = await store.get(value);
      if (!actual) throw new Error(`密钥 "${value}" 不存在，请先在密钥管理中添加`);
      resolved[key] = actual;
    }
  }
  return resolved;
}

async function testConnection(platform) {
  const config = await loadConfig();
  const platConfig = config.sync?.platforms?.[platform];
  if (!platConfig) throw new Error(`平台 ${platform} 未配置`);

  const resolved = await resolveVaultRefs(platConfig, platform);
  const adapter = loadAdapter(platform);
  const result = await adapter.testConnection(resolved);
  appendLog('platform-test', platform, true, result);
  return result;
}

// Derive userId/encryptionKey from the sync password. All enabled platforms
// share the same derived identity, so any of them can serve the same blob.
async function resolveSyncKeys(config) {
  const password = config.sync?.password;
  if (!password) throw new Error('请先设置同步密码');
  const key = crypto.pbkdf2Sync(password, 'okit-sync-salt', 100000, 32, 'sha256');
  return { userId: key.slice(0, 16).toString('hex'), encryptionKey: key };
}

// Sync goes to EVERY enabled platform (enabled = participates). The legacy
// syncPlatform preference only breaks ties for single-target flows like the
// sync-code export.
async function listEnabledSyncTargets(config) {
  const { userId, encryptionKey } = await resolveSyncKeys(config);
  const platforms = config.sync?.platforms || {};
  const targets = [];
  for (const [id, platConfig] of Object.entries(platforms)) {
    if (!platConfig?.enabled) continue;
    targets.push({ id, resolvedConfig: await resolveVaultRefs(platConfig, id) });
  }
  if (targets.length === 0) throw new Error('请先启用一个同步平台');
  return { targets, userId, encryptionKey };
}

async function resolvePrimaryTarget(config) {
  const { targets } = await listEnabledSyncTargets(config);
  const preferred = config.sync?.syncPlatform;
  return targets.find(t => t.id === preferred) || targets[0];
}

function decryptRemoteBlob(encrypted, encryptionKey) {
  const iv = Buffer.from(encrypted.nonce, 'hex');
  const tag = Buffer.from(encrypted.tag, 'hex');
  const ciphertext = Buffer.from(encrypted.ciphertext, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

// Read the freshest remote blob across all enabled platforms without merging.
// A platform that errors or has no data is skipped; returns null when none
// has data. Throws only when every enabled platform failed.
async function peekRemote() {
  const config = await loadConfig();
  const { targets, userId, encryptionKey } = await listEnabledSyncTargets(config);
  let freshest = null;
  let failures = 0;
  for (const { id, resolvedConfig } of targets) {
    try {
      const encrypted = await loadAdapter(id).pullSync(resolvedConfig, userId);
      if (!encrypted) continue;
      const remoteData = decryptRemoteBlob(encrypted, encryptionKey);
      const info = { updatedAt: remoteData.updatedAt || '', machineId: remoteData.machineId || null };
      if (!freshest || info.updatedAt > freshest.updatedAt) freshest = info;
    } catch (error) {
      failures++;
      appendLog('peek-remote', id, false, error.message);
    }
  }
  if (!freshest && failures === targets.length) {
    throw new Error('所有已启用的同步平台都无法访问');
  }
  return freshest;
}

async function syncPush() {
  const config = await loadConfig();
  const { targets, userId, encryptionKey } = await listEnabledSyncTargets(config);

  if (!config.sync.machineId) {
    config.sync.machineId = crypto.randomUUID();
  }

  const { VaultStore } = require('../../vault/store');
  const store = new VaultStore();
  const secrets = await store.exportAll();

  const syncData = {
    secrets,
    settings: { agentProviders: config.agentProviders || {}, modelOverrides: config.modelOverrides || {}, providers: await loadProvidersConfig() },
    updatedAt: new Date().toISOString(),
    machineId: config.sync.machineId,
  };

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(syncData), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encryptedBlob = { nonce: iv.toString('hex'), ciphertext: encrypted.toString('hex'), tag: tag.toString('hex') };

  // Fan out the same encrypted blob to every enabled platform. Attempt all
  // before reporting failures so one dead platform never blocks the others.
  const pushed = [];
  const failed = [];
  for (const { id, resolvedConfig } of targets) {
    try {
      await loadAdapter(id).pushSync(resolvedConfig, userId, encryptedBlob);
      pushed.push(id);
      appendLog('sync-push', id, true, `${secrets.length} secrets`);
    } catch (error) {
      failed.push(`${id}: ${error.message}`);
      appendLog('sync-push', id, false, error.message);
    }
  }
  if (pushed.length === 0) {
    throw new Error(`推送失败（${failed.join('; ')}）`);
  }

  // Baselines: everything pushed at syncData.updatedAt. Newer local edits (or a
  // newer remote blob) are what the pull guards compare against.
  config.sync.lastRemote = { updatedAt: syncData.updatedAt, machineId: config.sync.machineId };
  config.sync.localChangedAt = { secrets: syncData.updatedAt, agentProviders: syncData.updatedAt, modelOverrides: syncData.updatedAt, providers: syncData.updatedAt };
  config.sync.lastSyncAt = new Date().toISOString();
  config.sync.lastSyncPlatform = pushed.join(',');
  await saveConfig(config);

  if (failed.length > 0) {
    throw new Error(`已推送到 ${pushed.join('、')}，但部分平台失败（${failed.join('; ')}）`);
  }
  return { secrets: secrets.length, platforms: pushed, platform: pushed.join('、') };
}

async function syncPull() {
  const config = await loadConfig();
  const { targets, userId, encryptionKey } = await listEnabledSyncTargets(config);

  // Pick the freshest blob across enabled platforms; stale copies on other
  // platforms are ignored. Unreachable platforms are skipped (peek logged).
  let remoteData = null;
  let remoteFrom = null;
  for (const { id, resolvedConfig } of targets) {
    try {
      const encrypted = await loadAdapter(id).pullSync(resolvedConfig, userId);
      if (!encrypted) continue;
      const data = decryptRemoteBlob(encrypted, encryptionKey);
      if (!remoteData || (data.updatedAt || '') > (remoteData.updatedAt || '')) {
        remoteData = data;
        remoteFrom = id;
      }
    } catch (error) {
      appendLog('pull-skip', id, false, error.message);
    }
  }
  if (!remoteData) throw new Error('远端没有同步数据');

  // Merge
  const { VaultStore } = require('../../vault/store');
  const store = new VaultStore();
  const localSecrets = await store.exportAll();
  const localMap = new Map();
  for (const s of localSecrets) localMap.set(s.key, s);

  let added = 0, updated = 0;
  for (const remote of (remoteData.secrets || [])) {
    const local = localMap.get(remote.key);
    if (!local) {
      await store.set(remote.key, remote.value, remote.group, remote.expiresAt, remote.desc);
      added++;
    } else if (remote.updatedAt && (!local.updatedAt || remote.updatedAt > local.updatedAt)) {
      await store.set(remote.key, remote.value, remote.group, remote.expiresAt, remote.desc);
      updated++;
    }
  }

  // Config guards: apply remote agentProviders/providers only when the remote blob is newer
  // than the last local edit of that section, so an auto-pull loop never clobbers
  // newer local config with stale remote config. Missing localChangedAt (legacy
  // installs) keeps the old unconditional-apply behavior.
  const remoteUpdated = remoteData.updatedAt || '';
  const localChangedAt = config.sync.localChangedAt || {};
  let agentProvidersApplied = false;
  if (remoteData.settings?.agentProviders && remoteUpdated > (localChangedAt.agentProviders || '')) {
    config.agentProviders = remoteData.settings.agentProviders;
    agentProvidersApplied = true;
  }
  if (remoteData.settings?.modelOverrides && remoteUpdated > (localChangedAt.modelOverrides || '')) {
    config.modelOverrides = remoteData.settings.modelOverrides;
  }
  let providersApplied = false;
  let providers = 0;
  if (remoteData.settings && remoteUpdated > (localChangedAt.providers || '')) {
    providers = await mergeProvidersConfig(remoteData.settings.providers);
    providersApplied = true;
  }

  if (!config.sync.machineId) config.sync.machineId = crypto.randomUUID();
  config.sync.lastRemote = { updatedAt: remoteUpdated, machineId: remoteData.machineId || null };
  config.sync.lastSyncAt = new Date().toISOString();
  config.sync.lastSyncPlatform = remoteFrom;
  await saveConfig(config, {
    applyAgentProviders: agentProvidersApplied,
    applyModelOverrides: remoteData.settings?.modelOverrides && remoteUpdated > (localChangedAt.modelOverrides || ''),
  });

  // Do not let a missing local key, model cache or Agent installation turn a
  // successful pull into a failed sync. The accepted desired state above is
  // intentionally retained; this result is both diagnostic evidence and the
  // next-pull retry boundary.
  const agentReconciliation = agentProvidersApplied
    ? await reconcilePulledAgentProviders(config)
    : [];

  const changedSections = [];
  if (added > 0 || updated > 0) changedSections.push('secrets');
  if (agentProvidersApplied) changedSections.push('agents');
  if (providersApplied) changedSections.push('providers');
  if (changedSections.length > 0) publishDataChanged(changedSections);

  const agentFailures = agentReconciliation.filter(result => !result.success);
  appendLog('sync-pull', remoteFrom, true, `+${added} ~${updated} providers:${providers}${agentProvidersApplied ? ` agents:${agentReconciliation.length}/${agentFailures.length} failed` : ' agents:kept-local'}${providersApplied ? '' : ' providers:kept-local'}`);
  return { added, updated, providers, total: (remoteData.secrets || []).length, agentProvidersApplied, providersApplied, agentReconciliation, agentFailures };
}

async function exportSyncCode(passwordOverride) {
  const config = await loadConfig();
  const password = passwordOverride || config.sync?.password;
  if (!password) throw new Error('请先设置同步密码');

  const primary = await resolvePrimaryTarget(config);
  const entry = { id: primary.id, config: config.sync.platforms[primary.id] };

  const platformSecrets = await collectPlatformVaultSecrets(entry.config, entry.id);
  const payload = {
    version: 1,
    createdAt: new Date().toISOString(),
    syncPlatform: entry.id,
    platformConfig: entry.config,
    platformSecrets,
  };

  return {
    code: encryptSyncCodePayload(payload, password),
    platform: entry.id,
    secrets: platformSecrets.length,
  };
}

async function importSyncCode(code, password) {
  if (!password) throw new Error('请先设置同步密码');
  const payload = decryptSyncCodePayload(code, password);
  if (!payload?.syncPlatform || !payload?.platformConfig) throw new Error('同步码缺少平台配置');

  const { VaultStore } = require('../../vault/store');
  const store = new VaultStore();
  const secrets = Array.isArray(payload.platformSecrets) ? payload.platformSecrets : [];
  for (const secret of secrets) {
    if (!secret?.key || typeof secret.value !== 'string') continue;
    await store.set(secret.key, secret.value, secret.group || '', secret.expiresAt || undefined, secret.desc || '');
  }

  const config = await loadConfig();
  config.sync = {
    ...(config.sync || {}),
    password,
    syncPlatform: payload.syncPlatform,
    platforms: {
      ...(config.sync?.platforms || {}),
      [payload.syncPlatform]: {
        ...payload.platformConfig,
        enabled: true,
      },
    },
  };
  await saveConfig(config);
  appendLog('sync-code-import', payload.syncPlatform, true, `${secrets.length} secrets`);
  publishDataChanged(['config', 'secrets']);

  return { platform: payload.syncPlatform, secrets: secrets.length };
}

module.exports = { loadConfig, saveConfig, saveUserConfig, mergeSyncedProviderSites, appendLog, resolveVaultRefs, resolveSyncKeys, testConnection, peekRemote, syncPush, syncPull, exportSyncCode, importSyncCode, __testing: { stripRebuildableProviderData } };
