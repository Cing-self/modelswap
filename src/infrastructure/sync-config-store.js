const {
  mergeAgentProviderSelections,
  mergeModelOverrides,
  removeProviderSelection,
  removeAgentProviderSite,
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
      const live = JSON.parse(await fs.readFile(configPath, 'utf-8'));
      migrateAgentProviders(live);
      return live;
    } catch {
      return { ...fallback };
    }
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
      next.localChangedAt = { ...(live?.localChangedAt || {}), ...patch.localChangedAt };
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
        return mutateConfig(live => {
          migrateAgentProviders(live);
          return live;
        }, { reason: 'user' });
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
  async function mutateConfig(mutator, { reason = 'user' } = {}) {
    return enqueue(async () => {
      await fs.ensureDir(require('path').dirname(configPath));
      const live = await readLiveConfig({});
      const next = await mutator(live);
      if (!next || typeof next !== 'object') throw new Error('Config mutator must return an object');
      await backupImportantData(reason);
      await atomicWriteJson(configPath, next);
      return next;
    });
  }

  async function saveConfig(config, options = {}) {
    return mutateConfig(live => {
      // Sync producers only own fields inside sync. Merge their patch against
      // the live queued value so lastSyncAt/localChangedAt cannot be rolled
      // back by an earlier settings snapshot.
      const next = { ...live, sync: mergeSyncConfig(live.sync, config.sync) };
      const virtualFs =
        fs.writeJson && Object.prototype.hasOwnProperty.call(fs.writeJson, 'mock');
      if (
        options.applyAgentProviders ||
        (virtualFs && Object.prototype.hasOwnProperty.call(config, 'agentProviders'))
      ) {
        next.agentProviders = config.agentProviders || {};
      }
      if (
        options.applyModelOverrides ||
        (virtualFs && Object.prototype.hasOwnProperty.call(config, 'modelOverrides'))
      ) {
        next.modelOverrides = config.modelOverrides || {};
      }
      return next;
    }, { reason: 'sync' });
  }

  async function saveUserConfig(config, options = {}) {
    return mutateConfig(live => {
      const next = {
        ...live,
        ...config,
        sync: live.sync === undefined ? config.sync : live.sync,
      };
      next.agentProviders = mergeAgentProviderSelections(
        live.agentProviders,
        config.agentProviders,
      );
      next.modelOverrides = mergeModelOverrides(
        live.modelOverrides,
        config.modelOverrides,
      );
      if (options.deleteProviderId) {
        removeProviderSelection(next, options.deleteProviderId);
      }
      if (options.removeSite?.agentId && options.removeSite?.providerId) {
        removeAgentProviderSite(
          next,
          options.removeSite.agentId,
          options.removeSite.providerId,
        );
      }
      return next;
    });
  }

  async function updateUserConfig(patch) {
    return mutateConfig(live => ({
      ...live,
      ...patch,
      hints: patch.hints ? { ...live.hints, ...patch.hints } : live.hints,
      git: patch.git ? { ...live.git, ...patch.git } : live.git,
      agentProviders: patch.agentProviders
        ? mergeAgentProviderSelections(live.agentProviders, patch.agentProviders)
        : live.agentProviders,
      modelOverrides: patch.modelOverrides
        ? mergeModelOverrides(live.modelOverrides, patch.modelOverrides)
        : live.modelOverrides,
      repo: patch.repo ? { ...live.repo, ...patch.repo } : live.repo,
      sync: patch.sync ? mergeSyncConfig(live.sync, patch.sync) : live.sync,
    }));
  }

  return { loadConfig, mutateConfig, saveConfig, saveUserConfig, updateUserConfig };
}

module.exports = { createSyncConfigStore };
