// Sync use-case orchestration. This module deliberately has no Express API.
const crypto = require('crypto');

const validId = value => typeof value === 'string' && /^[a-z0-9~][a-z0-9._~:/+-]{0,255}$/i.test(value);
const hasOnly = (value, keys) => Object.keys(value).every(key => keys.includes(key));

// The sync payload carries closed entities, never a user.json-shaped map.
// Decode and validate them before any local vault or config mutation.
function decodeDesiredSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !hasOnly(raw, ['providers', 'agentStates', 'modelOverrideFields'])
    || !Array.isArray(raw.agentStates || []) || !Array.isArray(raw.modelOverrideFields || [])) throw new Error('同步数据配置意图无效');
  const agentStates = raw.agentStates.map(entry => {
    if (!entry || typeof entry !== 'object' || !hasOnly(entry, ['agentId', 'activeProviderId', 'activeModelId', 'sites']) || !validId(entry.agentId)
      || !Array.isArray(entry.sites) || (entry.activeProviderId !== undefined && !validId(entry.activeProviderId)) || (entry.activeModelId !== undefined && !validId(entry.activeModelId))) throw new Error('同步数据配置意图无效');
    const sites = entry.sites.map(site => {
      if (!site || typeof site !== 'object' || !hasOnly(site, ['providerId', 'modelIds', 'enabled', 'tierMap']) || !validId(site.providerId)
        || !Array.isArray(site.modelIds) || site.modelIds.some(id => !validId(id)) || (site.enabled !== undefined && typeof site.enabled !== 'boolean')) throw new Error('同步数据配置意图无效');
      if (site.tierMap !== undefined && (!site.tierMap || typeof site.tierMap !== 'object' || Array.isArray(site.tierMap) || !hasOnly(site.tierMap, ['haiku', 'sonnet', 'opus']) || Object.values(site.tierMap).some(id => !validId(id)))) throw new Error('同步数据配置意图无效');
      return { ...site, modelIds: [...new Set(site.modelIds)], ...(site.tierMap ? { tierMap: { ...site.tierMap } } : {}) };
    });
    if (new Set(sites.map(site => site.providerId)).size !== sites.length) throw new Error('同步数据配置意图无效');
    return { ...entry, sites };
  });
  if (new Set(agentStates.map(entry => entry.agentId)).size !== agentStates.length) throw new Error('同步数据配置意图无效');
  const allowedOverrideFields = ['name', 'description', 'context', 'output', 'reasoning', 'tool', 'structuredOutput', 'temperature', 'inputPrice', 'outputPrice'];
  const modelOverrideFields = raw.modelOverrideFields.map(entry => {
    if (!entry || typeof entry !== 'object' || !hasOnly(entry, ['providerId', 'modelId', 'field', 'value']) || !validId(entry.providerId) || !validId(entry.modelId) || !allowedOverrideFields.includes(entry.field)
      || !['string', 'number', 'boolean'].includes(typeof entry.value) || (typeof entry.value === 'number' && !Number.isFinite(entry.value))) throw new Error('同步数据配置意图无效');
    return { ...entry };
  });
  return { agentStates, modelOverrideFields };
}

function exportDesiredSettings(config) {
  const agentStates = Object.entries(config.agentProviders || {}).flatMap(([agentId, state]) => {
    if (!validId(agentId) || !state || typeof state !== 'object') return [];
    const sites = Object.entries(state.sites || {}).flatMap(([providerId, site]) => {
      if (!validId(providerId) || !site || !Array.isArray(site.modelIds) || site.modelIds.some(id => !validId(id))) return [];
      const tierMap = site.tierMap && typeof site.tierMap === 'object' && !Array.isArray(site.tierMap)
        ? Object.fromEntries(Object.entries(site.tierMap).filter(([tier, modelId]) => ['haiku', 'sonnet', 'opus'].includes(tier) && validId(modelId))) : undefined;
      return [{ providerId, modelIds: [...new Set(site.modelIds)], ...(typeof site.enabled === 'boolean' ? { enabled: site.enabled } : {}), ...(tierMap && Object.keys(tierMap).length ? { tierMap } : {}) }];
    });
    return [{ agentId, ...(validId(state.activeProviderId) ? { activeProviderId: state.activeProviderId } : {}), ...(validId(state.activeModelId) ? { activeModelId: state.activeModelId } : {}), sites }];
  });
  const allowed = new Set(['name', 'description', 'context', 'output', 'reasoning', 'tool', 'structuredOutput', 'temperature', 'inputPrice', 'outputPrice']);
  const modelOverrideFields = [];
  for (const [providerId, models] of Object.entries(config.modelOverrides || {})) for (const [modelId, fields] of Object.entries(models || {})) for (const [field, value] of Object.entries(fields || {})) {
    if (validId(providerId) && validId(modelId) && allowed.has(field) && ['string', 'number', 'boolean'].includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value))) modelOverrideFields.push({ providerId, modelId, field, value });
  }
  return { agentStates, modelOverrideFields };
}

function createSyncService({
  appendLog,
  collectPlatformVaultSecrets,
  decryptPayload,
  decryptSyncCodePayload,
  encryptPayload,
  encryptSyncCodePayload,
  getVaultStore,
  hydratePulledAgentModels = async () => ({ warmed: [], pending: [], results: [] }),
  listEnabledSyncTargets,
  loadAdapter,
  loadConfig,
  loadProviderSites,
  mergeRemoteProviderSites,
  publishDataChanged,
  reconcilePulledAgentProviders,
  resolvePrimaryTarget,
  recordSyncPush,
  acceptPulledDesired,
  setSyncField,
  setPlatformField,
  shouldApplyRemoteSection,
}) {
  async function peekRemote() {
    let config = await loadConfig();
    const { targets, userId, encryptionKey } = await listEnabledSyncTargets(
      config,
    );
    let freshest = null;
    let failures = 0;
    for (const { id, resolvedConfig } of targets) {
      try {
        const encrypted = await loadAdapter(id).pullSync(resolvedConfig, userId);
        if (!encrypted) continue;
        const remoteData = decryptPayload(encrypted, encryptionKey);
        const info = {
          updatedAt: remoteData.updatedAt || '',
          machineId: remoteData.machineId || null,
        };
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
    const { targets, userId, encryptionKey } = await listEnabledSyncTargets(
      config,
    );

    if (!config.sync.machineId) config.sync.machineId = crypto.randomUUID();

    const secrets = await getVaultStore().exportAll();
    const syncData = {
      secrets,
      settings: {
        ...exportDesiredSettings(config),
        providers: await loadProviderSites(),
      },
      updatedAt: new Date().toISOString(),
      machineId: config.sync.machineId,
    };
    const encryptedBlob = encryptPayload(syncData, encryptionKey);

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

    await recordSyncPush(config.sync.machineId, syncData.updatedAt, pushed[0]);

    if (failed.length > 0) {
      throw new Error(
        `已推送到 ${pushed.join('、')}，但部分平台失败（${failed.join('; ')}）`,
      );
    }
    return {
      secrets: secrets.length,
      platforms: pushed,
      platform: pushed.join('、'),
    };
  }

  async function syncPull() {
    let config = await loadConfig();
    const { targets, userId, encryptionKey } = await listEnabledSyncTargets(
      config,
    );

    let remoteData = null;
    let remoteFrom = null;
    for (const { id, resolvedConfig } of targets) {
      try {
        const encrypted = await loadAdapter(id).pullSync(resolvedConfig, userId);
        if (!encrypted) continue;
        const data = decryptPayload(encrypted, encryptionKey);
        if (!remoteData || (data.updatedAt || '') > (remoteData.updatedAt || '')) {
          remoteData = data;
          remoteFrom = id;
        }
      } catch (error) {
        appendLog('pull-skip', id, false, error.message);
      }
    }
    if (!remoteData) throw new Error('远端没有同步数据');

    const desired = decodeDesiredSettings(remoteData.settings || {});
    const remoteUpdated = remoteData.updatedAt || '';
    const localChangedAt = config.sync.localChangedAt || {};
    // Providers have to exist locally before the desired Agent selection is
    // replayed. This keeps a pull on a new machine on the same service path
    // as an ordinary dashboard or CLI save.
    const providersApplied = Boolean(
      remoteData.settings &&
        shouldApplyRemoteSection(remoteUpdated, localChangedAt.providers),
    );
    const providers = providersApplied
      ? await mergeRemoteProviderSites(remoteData.settings.providers)
      : 0;

    const store = getVaultStore();
    const localMap = new Map(
      (await store.exportAll()).map((secret) => [secret.key, secret]),
    );
    let added = 0;
    let updated = 0;
    for (const remote of remoteData.secrets || []) {
      const local = localMap.get(remote.key);
      if (!local) {
        await store.set(
          remote.key,
          remote.value,
          remote.group,
          remote.expiresAt,
          remote.desc,
        );
        added++;
      } else if (
        remote.updatedAt &&
        (!local.updatedAt || remote.updatedAt > local.updatedAt)
      ) {
        await store.set(
          remote.key,
          remote.value,
          remote.group,
          remote.expiresAt,
          remote.desc,
        );
        updated++;
      }
    }

    const agentProvidersApplied = Boolean(
      desired.agentStates.length > 0 &&
        shouldApplyRemoteSection(remoteUpdated, localChangedAt.agentProviders),
    );
    const modelOverridesApplied = Boolean(
      desired.modelOverrideFields.length > 0 &&
        shouldApplyRemoteSection(remoteUpdated, localChangedAt.modelOverrides),
    );
    config = await acceptPulledDesired(remoteUpdated, remoteData.machineId || '', remoteFrom, desired.agentStates, desired.modelOverrideFields);

    // Desired Agent state is durable before this local-only step. Hydration
    // discovers membership from B's authenticated endpoint/CLI and writes
    // only B's models-cache; it never imports A's rebuildable cache or marks
    // a sync section dirty. Reconciliation remains the single writer path.
    const agentModelHydration = agentProvidersApplied
      ? await hydratePulledAgentModels(config)
      : { warmed: [], pending: [], results: [] };
    const agentReconciliation = agentProvidersApplied
      ? await reconcilePulledAgentProviders(config)
      : [];
    const changedSections = [];
    if (added > 0 || updated > 0) changedSections.push('secrets');
    if (agentProvidersApplied) changedSections.push('agents');
    if (providersApplied) changedSections.push('providers');
    if (changedSections.length > 0) publishDataChanged(changedSections);

    const agentFailures = agentReconciliation.filter(
      (result) => !result.success,
    );
    appendLog(
      'sync-pull',
      remoteFrom,
      true,
      `+${added} ~${updated} providers:${providers}${agentProvidersApplied ? ` agents:${agentReconciliation.length}/${agentFailures.length} failed` : ' agents:kept-local'}${providersApplied ? '' : ' providers:kept-local'}`,
    );
    return {
      added,
      updated,
      providers,
      total: (remoteData.secrets || []).length,
      agentProvidersApplied,
      providersApplied,
      agentModelHydration,
      agentReconciliation,
      agentFailures,
    };
  }

  async function exportSyncCode(passwordOverride) {
    const config = await loadConfig();
    const password = passwordOverride || config.sync?.password;
    if (!password) throw new Error('请先设置同步密码');

    const primary = await resolvePrimaryTarget(config);
    const entry = {
      id: primary.id,
      config: config.sync.platforms[primary.id],
    };
    const platformSecrets = await collectPlatformVaultSecrets(
      entry.config,
      entry.id,
    );
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
    if (!payload?.syncPlatform || !payload?.platformConfig) {
      throw new Error('同步码缺少平台配置');
    }
    const platformFields = {
      cloudflare: ['enabled', 'apiToken', 'storeId'], 'cloudflare-kv': ['enabled', 'apiToken', 'storeId'],
      'cloudflare-d1': ['enabled', 'apiToken', 'databaseId', 'tableName'],
      'cloudflare-r2': ['enabled', 'accountId', 'r2AccessKeyId', 'r2SecretAccessKey', 'bucketName'],
      supabase: ['enabled', 'projectId', 'apiKey', 'apiToken', 'storeId'], volcengine: ['enabled', 'region', 'accessKey', 'secretKey'],
      webdav: ['enabled', 'url', 'username', 'password'], lan: ['enabled', 'baseUrl', 'token'], icloud: ['enabled'],
    };
    if (!Object.prototype.hasOwnProperty.call(platformFields, payload.syncPlatform) || !payload.platformConfig || typeof payload.platformConfig !== 'object' || Array.isArray(payload.platformConfig)) {
      throw new Error('同步码平台配置无效');
    }
    for (const [field, value] of Object.entries(payload.platformConfig)) {
      if (!platformFields[payload.syncPlatform].includes(field) || !['string', 'boolean'].includes(typeof value)) throw new Error('同步码平台配置无效');
    }

    const secrets = Array.isArray(payload.platformSecrets)
      ? payload.platformSecrets
      : [];
    const store = getVaultStore();
    for (const secret of secrets) {
      if (!secret?.key || typeof secret.value !== 'string') continue;
      await store.set(
        secret.key,
        secret.value,
        secret.group || '',
        secret.expiresAt || undefined,
        secret.desc || '',
      );
    }

    await setSyncField('password', password);
    await setSyncField('syncPlatform', payload.syncPlatform);
    for (const [field, value] of Object.entries(payload.platformConfig)) await setPlatformField(payload.syncPlatform, field, value);
    await setPlatformField(payload.syncPlatform, 'enabled', true);
    appendLog('sync-code-import', payload.syncPlatform, true, `${secrets.length} secrets`);
    publishDataChanged(['config', 'secrets']);
    return { platform: payload.syncPlatform, secrets: secrets.length };
  }

  return {
    exportSyncCode,
    importSyncCode,
    peekRemote,
    syncPull,
    syncPush,
  };
}

module.exports = { createSyncService };
