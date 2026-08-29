// Sync use-case orchestration. This module deliberately has no Express API.
const crypto = require('crypto');

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
  mutateConfig,
  patchSyncConfig,
  shouldApplyRemoteSection,
}) {
  async function peekRemote() {
    const config = await loadConfig();
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

    const machineId = config.sync.machineId || crypto.randomUUID();

    const secrets = await getVaultStore().exportAll();
    const syncData = {
      secrets,
      settings: {
        agentProviders: config.agentProviders || {},
        modelOverrides: config.modelOverrides || {},
        providers: await loadProviderSites(),
      },
      updatedAt: new Date().toISOString(),
      machineId,
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

    await patchSyncConfig({
      machineId,
      lastRemote: { updatedAt: syncData.updatedAt, machineId },
      localChangedAt: {
        secrets: syncData.updatedAt,
        agentProviders: syncData.updatedAt,
        modelOverrides: syncData.updatedAt,
        providers: syncData.updatedAt,
      },
      lastSyncAt: new Date().toISOString(),
      lastSyncPlatform: pushed.join(','),
    }, 'sync-push');

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
    const config = await loadConfig();
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

    const remoteUpdated = remoteData.updatedAt || '';

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

    let providersApplied = false;
    let agentProvidersApplied = false;
    let modelOverridesApplied = false;
    // Re-evaluate every conflict guard against the queue-fresh local state.
    // `remoteData` is a decrypted wire intent, never a saved local snapshot.
    const committedConfig = await mutateConfig('sync-pull', live => {
      const localChangedAt = live.sync?.localChangedAt || {};
      providersApplied = Boolean(remoteData.settings && shouldApplyRemoteSection(
        remoteUpdated, localChangedAt.providers,
      ));
      agentProvidersApplied = Boolean(remoteData.settings?.agentProviders && shouldApplyRemoteSection(
        remoteUpdated, localChangedAt.agentProviders,
      ));
      modelOverridesApplied = Boolean(remoteData.settings?.modelOverrides && shouldApplyRemoteSection(
        remoteUpdated, localChangedAt.modelOverrides,
      ));
      return {
        ...live,
        ...(agentProvidersApplied ? { agentProviders: remoteData.settings.agentProviders } : {}),
        ...(modelOverridesApplied ? { modelOverrides: remoteData.settings.modelOverrides } : {}),
        sync: {
          ...(live.sync || {}),
          machineId: live.sync?.machineId || crypto.randomUUID(),
          lastRemote: { updatedAt: remoteUpdated, machineId: remoteData.machineId || null },
          lastSyncAt: new Date().toISOString(),
          lastSyncPlatform: remoteFrom,
        },
      };
    });
    // Provider sites must exist before local discovery/reconciliation, but
    // their user.json conflict decision was made in the queued mutation above.
    const providers = providersApplied
      ? await mergeRemoteProviderSites(remoteData.settings.providers)
      : 0;

    // Desired Agent state is durable before this local-only step. Hydration
    // discovers membership from B's authenticated endpoint/CLI and writes
    // only B's models-cache; it never imports A's rebuildable cache or marks
    // a sync section dirty. Reconciliation remains the single writer path.
    const agentModelHydration = agentProvidersApplied
      ? await hydratePulledAgentModels(committedConfig)
      : { warmed: [], pending: [], results: [] };
    const agentReconciliation = agentProvidersApplied
      ? await reconcilePulledAgentProviders(committedConfig)
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

    await patchSyncConfig({
      password,
      syncPlatform: payload.syncPlatform,
      platforms: { [payload.syncPlatform]: { ...payload.platformConfig, enabled: true } },
    }, 'sync-code-import');
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
