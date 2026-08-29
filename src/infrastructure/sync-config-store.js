const {
  mergeAgentProviderSelections,
  mergeModelOverrides,
} = require('../application/sync-config-state');

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
      if (fs.writeJson && Object.prototype.hasOwnProperty.call(fs.writeJson, 'mock')) {
        const live = await fs.readJson(configPath);
        migrateAgentProviders(live);
        return live;
      }
      const live = JSON.parse(await fs.readFile(configPath, 'utf-8'));
      migrateAgentProviders(live);
      return live;
    } catch {
      return { ...fallback };
    }
  }

  function laterTimestamp(liveValue, incomingValue) {
    const liveTime = typeof liveValue === 'string' ? Date.parse(liveValue) : NaN;
    const incomingTime = typeof incomingValue === 'string' ? Date.parse(incomingValue) : NaN;
    if (Number.isFinite(liveTime) && Number.isFinite(incomingTime)) {
      return incomingTime >= liveTime ? incomingValue : liveValue;
    }
    if (Number.isFinite(incomingTime)) return incomingValue;
    return liveValue;
  }

  function mergeSyncConfig(live, patch) {
    if (!patch || typeof patch !== 'object') return live;
    const next = { ...(live || {}), ...patch };
    if (patch.platforms && typeof patch.platforms === 'object') {
      next.platforms = { ...(live?.platforms || {}) };
      for (const [platformId, platformPatch] of Object.entries(patch.platforms)) {
        next.platforms[platformId] = platformPatch && typeof platformPatch === 'object'
          ? { ...(live?.platforms?.[platformId] || {}), ...platformPatch }
          : platformPatch;
      }
    }
    if (patch.lan && typeof patch.lan === 'object') next.lan = { ...(live?.lan || {}), ...patch.lan };
    if (patch.localChangedAt && typeof patch.localChangedAt === 'object') {
      next.localChangedAt = { ...(live?.localChangedAt || {}) };
      for (const [section, timestamp] of Object.entries(patch.localChangedAt)) {
        next.localChangedAt[section] = laterTimestamp(live?.localChangedAt?.[section], timestamp);
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'lastSyncAt')) {
      next.lastSyncAt = laterTimestamp(live?.lastSyncAt, patch.lastSyncAt);
    }
    return next;
  }

  async function loadConfig() {
    try {
      if (!(await fs.pathExists(configPath))) return {};
      const config = await fs.readJson(configPath);
      if (migrateAgentProviders(config)) {
        // Re-read and persist the migration inside the same queue as every
        // other user.json mutation. A direct write here could otherwise
        // replace a concurrent Agent or sync update with this stale snapshot.
        return commitMutation('legacy-migration', live => {
          migrateAgentProviders(live);
          return live;
        });
      }
      return config;
    } catch {
      return {};
    }
  }

  /**
   * The sole production write primitive for user.json. Callers declare their
   * owned fields in a mutator; the current file is read only after earlier
   * writes finish, then atomically replaced as part of that same queue item.
   */
  // Store-private queue primitive. It is deliberately not returned from this
  // factory: application/web callers can only use the semantic operations.
  async function commitMutation(owner, mutator) {
    if (typeof owner !== 'string' || !owner) throw new Error('Config mutation owner is required');
    if (typeof mutator !== 'function') throw new Error('Config mutator is required');
    return enqueue(async () => {
      await fs.ensureDir(require('path').dirname(configPath));
      const live = await readLiveConfig({});
      const proposed = await mutator(live);
      if (!proposed || typeof proposed !== 'object') throw new Error('Config mutator must return an object');
      // Even conditional mutations share the canonical sync normalization.
      // A mutator can choose which sync keys it owns, but cannot roll a newer
      // timestamp/platform/lan field back with an older value.
      const next = {
        ...proposed,
        ...(proposed.sync ? { sync: mergeSyncConfig(live.sync, proposed.sync) } : {}),
      };
      await backupImportantData(owner);
      await atomicWriteJson(configPath, next);
      return next;
    });
  }

  async function setSyncSetting(key, value) {
    if (!['autoSync', 'syncPlatform', 'password'].includes(key)) throw new Error('Unsupported sync setting');
    if (key === 'autoSync' ? typeof value !== 'boolean' : typeof value !== 'string' || !value) throw new Error('Invalid sync setting');
    return commitMutation(`sync-setting:${key}`, live => ({ ...live, sync: { ...(live.sync || {}), [key]: value } }));
  }

  async function setSyncPlatformField(platformId, field, value) {
    const allowed = new Set(['enabled', 'storeId', 'databaseId', 'tableName', 'bucketName', 'region', 'accessKey', 'secretKey', 'projectId', 'apiKey', 'apiToken', 'url', 'username', 'password', 'baseUrl', 'token']);
    if (typeof platformId !== 'string' || !platformId || !allowed.has(field) || !['string', 'boolean'].includes(typeof value)) throw new Error('Invalid sync platform field');
    return commitMutation(`sync-platform:${platformId}:${field}`, live => ({ ...live, sync: { ...(live.sync || {}), platforms: { ...(live.sync?.platforms || {}), [platformId]: { ...(live.sync?.platforms?.[platformId] || {}), [field]: value } } } }));
  }

  async function recordLocalChange(scope, timestamp) {
    if (!['secrets', 'providers', 'agentProviders', 'modelOverrides'].includes(scope) || !Number.isFinite(Date.parse(timestamp))) throw new Error('Invalid local change');
    return commitMutation(`local-change:${scope}`, live => ({ ...live, sync: mergeSyncConfig(live.sync, { localChangedAt: { [scope]: timestamp } }) }));
  }

  async function applyAgentBinding(agentId, selection) {
    if (typeof agentId !== 'string' || !agentId || !selection || typeof selection !== 'object') throw new Error('Invalid agent binding');
    return commitMutation(`agent-binding:${agentId}`, live => ({ ...live, agentProviders: mergeAgentProviderSelections(live.agentProviders, { [agentId]: selection }) }));
  }

  async function setModelOverrideField(providerId, modelId, field, value) {
    if (![providerId, modelId, field].every(item => typeof item === 'string' && item)) throw new Error('Invalid model override');
    return commitMutation(`model-override:${providerId}:${modelId}:${field}`, live => ({ ...live, modelOverrides: mergeModelOverrides(live.modelOverrides, { [providerId]: { [modelId]: { [field]: value } } }) }));
  }

  async function updateUserPreferences(patch) {
    const allowed = new Set(['language', 'git', 'repo', 'hints']);
    if (!patch || typeof patch !== 'object' || Object.keys(patch).some(key => !allowed.has(key))) {
      throw new Error('Invalid user preference patch');
    }
    return commitMutation('user-preferences', live => ({
      ...live,
      ...(Object.prototype.hasOwnProperty.call(patch, 'language') ? { language: patch.language } : {}),
      ...(patch.git ? { git: { ...(live.git || {}), ...patch.git } } : {}),
      ...(patch.repo ? { repo: { ...(live.repo || {}), ...patch.repo } } : {}),
      ...(patch.hints ? { hints: { ...(live.hints || {}), ...patch.hints } } : {}),
    }));
  }

  async function applyLegacyMigration() {
    return commitMutation('legacy-migration', live => {
      migrateAgentProviders(live);
      return live;
    });
  }

  async function setOnboardingDismissed(dismissed) {
    if (typeof dismissed !== 'boolean') throw new Error('Invalid onboarding state');
    return commitMutation('onboarding', live => {
      const hints = { ...(live.hints || {}) };
      if (dismissed) hints.onboardingDone = true;
      else delete hints.onboardingDone;
      return { ...live, hints };
    });
  }

  async function setLanField(field, value) {
    const valid = field === 'enabled' ? typeof value === 'boolean'
      : field === 'port' ? Number.isInteger(value) && value > 0 && value < 65536
      : ['token'].includes(field) && typeof value === 'string' && value;
    if (!valid) throw new Error('Invalid LAN field');
    return commitMutation(`lan-field:${field}`, live => ({ ...live, sync: { ...(live.sync || {}), lan: { ...(live.sync?.lan || {}), [field]: value } } }));
  }

  async function enableLan({ port, token }) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid LAN port');
    if (token !== undefined && (typeof token !== 'string' || !token)) throw new Error('Invalid LAN token');
    return commitMutation('lan-enable', live => {
      const sync = { ...(live.sync || {}) };
      const lan = { ...(sync.lan || {}), enabled: true, port, ...(token ? { token } : {}) };
      const platforms = { ...(sync.platforms || {}) };
      const existing = platforms.lan;
      if (!existing || /^http:\/\/(127\.0\.0\.1|localhost)(?::\d+)?$/i.test(existing.baseUrl || '')) {
        platforms.lan = { baseUrl: `http://127.0.0.1:${port}`, token: lan.token, enabled: true };
      }
      if (!sync.syncPlatform) sync.syncPlatform = 'lan';
      if (!sync.autoSync) sync.autoSync = true;
      return { ...live, sync: { ...sync, lan, platforms } };
    });
  }

  async function disableLan() {
    return commitMutation('lan-disable', live => {
      if (!live.sync?.lan) return live;
      const sync = { ...live.sync, lan: { ...live.sync.lan, enabled: false } };
      const local = sync.platforms?.lan;
      if (local && /^http:\/\/(127\.0\.0\.1|localhost)(?::\d+)?$/i.test(local.baseUrl || '')) {
        sync.platforms = { ...sync.platforms, lan: { ...local, enabled: false } };
      }
      return { ...live, sync };
    });
  }

  async function rotateLanToken(token) {
    if (typeof token !== 'string' || !token) throw new Error('Invalid LAN token');
    return commitMutation('lan-token-rotate', live => {
      if (!live.sync?.lan?.token) throw new Error('LAN is not enabled');
      const sync = { ...live.sync, lan: { ...live.sync.lan, token } };
      const local = sync.platforms?.lan;
      if (local && /^http:\/\/(127\.0\.0\.1|localhost)(?::\d+)?$/i.test(local.baseUrl || '')) {
        sync.platforms = { ...sync.platforms, lan: { ...local, token } };
      }
      return { ...live, sync };
    });
  }

  async function pairLan({ password, baseUrl, token }) {
    if (![password, baseUrl, token].every(value => typeof value === 'string' && value)) throw new Error('Invalid LAN pairing');
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:') throw new Error('Invalid LAN peer URL');
    return commitMutation('lan-pair', live => {
      const sync = { ...(live.sync || {}), password };
      const platforms = { ...(sync.platforms || {}) };
      if (sync.lan?.enabled && /^http:\/\/(127\.0\.0\.1|localhost)(?::\d+)?$/i.test(platforms.lan?.baseUrl || '')) {
        sync.lan = { ...sync.lan, enabled: false };
      }
      platforms.lan = { baseUrl, token, enabled: true };
      sync.platforms = platforms;
      if (!sync.syncPlatform) sync.syncPlatform = 'lan';
      if (!sync.autoSync) sync.autoSync = true;
      return { ...live, sync };
    });
  }

  async function recordLanListenerPort({ expectedToken, port }) {
    if (typeof expectedToken !== 'string' || !expectedToken || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid LAN listener port');
    return commitMutation('lan-listener-port', live => {
      const sync = { ...(live.sync || {}) };
      const lan = sync.lan || {};
      if (!lan.enabled || lan.token !== expectedToken) return live;
      sync.lan = { ...lan, port };
      const local = sync.platforms?.lan;
      if (local && /^http:\/\/(127\.0\.0\.1|localhost)(?::\d+)?$/i.test(local.baseUrl || '')) {
        sync.platforms = { ...sync.platforms, lan: { ...local, baseUrl: `http://127.0.0.1:${port}` } };
      }
      return { ...live, sync };
    });
  }

  async function recordSyncSuccess({ machineId, lastRemote, lastSyncPlatform, changedAt }) {
    if (typeof machineId !== 'string' || !machineId || typeof lastSyncPlatform !== 'string' || !lastSyncPlatform || !Number.isFinite(Date.parse(changedAt))) throw new Error('Invalid sync success');
    return commitMutation('sync-success', live => ({ ...live, sync: mergeSyncConfig(live.sync, {
      machineId,
      lastRemote,
      lastSyncAt: changedAt,
      lastSyncPlatform,
      localChangedAt: { secrets: changedAt, agentProviders: changedAt, modelOverrides: changedAt, providers: changedAt },
    }) }));
  }

  async function recordSyncObservation({ machineId, lastSyncPlatform, observedAt }) {
    if (typeof machineId !== 'string' || !machineId || typeof lastSyncPlatform !== 'string' || !lastSyncPlatform || !Number.isFinite(Date.parse(observedAt))) throw new Error('Invalid sync observation');
    return commitMutation('sync-observation', live => ({ ...live, sync: mergeSyncConfig(live.sync, {
      machineId,
      lastSyncAt: observedAt,
      lastSyncPlatform,
    }) }));
  }

  function validRemoteMeta(remoteUpdated, remoteFrom) {
    return Number.isFinite(Date.parse(remoteUpdated)) && typeof remoteFrom === 'string' && remoteFrom;
  }
  async function applyPulledSyncMetadata({ remoteUpdated, remoteMachineId, remoteFrom }) {
    if (!validRemoteMeta(remoteUpdated, remoteFrom) || (remoteMachineId !== null && remoteMachineId !== undefined && typeof remoteMachineId !== 'string')) throw new Error('Invalid pulled sync metadata');
    return commitMutation('sync-pull-metadata', live => ({ ...live, sync: mergeSyncConfig(live.sync, { machineId: live.sync?.machineId || require('crypto').randomUUID(), lastRemote: { updatedAt: remoteUpdated, machineId: remoteMachineId || null }, lastSyncAt: new Date().toISOString(), lastSyncPlatform: remoteFrom }) }));
  }
  async function applyPulledAgentSite({ remoteUpdated, agentId, providerId, modelIds, enabled, tierMap }) {
    if (!Number.isFinite(Date.parse(remoteUpdated)) || ![agentId, providerId].every(value => typeof value === 'string' && value) || !Array.isArray(modelIds) || modelIds.some(id => typeof id !== 'string') || (enabled !== undefined && typeof enabled !== 'boolean') || (tierMap !== undefined && (!tierMap || typeof tierMap !== 'object' || Array.isArray(tierMap)))) throw new Error('Invalid pulled agent site');
    return commitMutation('sync-pull-agent-site', live => {
      if (Date.parse(remoteUpdated) < Date.parse(live.sync?.localChangedAt?.agentProviders || 0)) return live;
      return { ...live, agentProviders: mergeAgentProviderSelections(live.agentProviders, { [agentId]: { sites: { [providerId]: { modelIds, ...(enabled === undefined ? {} : { enabled }), ...(tierMap === undefined ? {} : { tierMap }) } } } }) };
    });
  }
  async function applyPulledAgentActive({ remoteUpdated, agentId, providerId, modelId }) {
    if (!Number.isFinite(Date.parse(remoteUpdated)) || ![agentId, providerId, modelId].every(value => typeof value === 'string' && value)) throw new Error('Invalid pulled agent active model');
    return commitMutation('sync-pull-agent-active', live => {
      if (Date.parse(remoteUpdated) < Date.parse(live.sync?.localChangedAt?.agentProviders || 0)) return live;
      return { ...live, agentProviders: mergeAgentProviderSelections(live.agentProviders, { [agentId]: { activeProviderId: providerId, activeModelId: modelId, sites: {} } }) };
    });
  }
  async function applyPulledModelOverrideField({ remoteUpdated, providerId, modelId, field, value }) {
    if (!Number.isFinite(Date.parse(remoteUpdated)) || ![providerId, modelId, field].every(item => typeof item === 'string' && item) || value === undefined || (value && typeof value === 'object')) throw new Error('Invalid pulled model override');
    return commitMutation('sync-pull-model-override', live => {
      if (Date.parse(remoteUpdated) < Date.parse(live.sync?.localChangedAt?.modelOverrides || 0)) return live;
      return { ...live, modelOverrides: mergeModelOverrides(live.modelOverrides, { [providerId]: { [modelId]: { [field]: value } } }) };
    });
  }

  async function removeProviderConfiguration(providerId) {
    if (typeof providerId !== 'string' || !providerId) throw new Error('Invalid provider id');
    return commitMutation('provider-delete', live => {
      const next = { ...live, agentProviders: { ...(live.agentProviders || {}) }, modelOverrides: { ...(live.modelOverrides || {}) } };
      delete next.modelOverrides[providerId];
      for (const [agentId, state] of Object.entries(next.agentProviders)) {
        if (!state?.sites?.[providerId]) continue;
        const sites = { ...(state.sites || {}) };
        delete sites[providerId];
        const replacement = { ...state, sites };
        if (replacement.activeProviderId === providerId) { delete replacement.activeProviderId; delete replacement.activeModelId; }
        if (!Object.keys(sites).length && !replacement.activeProviderId) delete next.agentProviders[agentId];
        else next.agentProviders[agentId] = replacement;
      }
      return next;
    });
  }

  return {
    loadConfig,
    setSyncSetting,
    setSyncPlatformField,
    recordLocalChange,
    applyAgentBinding,
    setModelOverrideField,
    updateUserPreferences,
    applyLegacyMigration,
    setOnboardingDismissed,
    setLanField,
    enableLan,
    disableLan,
    rotateLanToken,
    pairLan,
    recordLanListenerPort,
    recordSyncSuccess,
    recordSyncObservation,
    applyPulledSyncMetadata,
    applyPulledAgentSite,
    applyPulledAgentActive,
    applyPulledModelOverrideField,
    removeProviderConfiguration,
  };
}

module.exports = { createSyncConfigStore };
