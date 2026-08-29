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
        return mutateConfig('legacy-migration', live => {
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
  async function mutateConfig(owner, mutator) {
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

  async function patchSyncConfig(patch, owner = 'sync') {
    return mutateConfig(owner, live => ({
      ...live,
      sync: mergeSyncConfig(live.sync, patch),
    }));
  }

  async function patchUserPreferences(preferences, owner = 'user-preferences') {
    const allowed = new Set(['language', 'hints', 'git', 'repo']);
    for (const key of Object.keys(preferences || {})) {
      if (!allowed.has(key)) throw new Error(`Unsupported user preference patch: ${key}`);
    }
    return mutateConfig(owner, live => ({
      ...live,
      ...preferences,
      hints: preferences.hints ? { ...live.hints, ...preferences.hints } : live.hints,
      git: preferences.git ? { ...live.git, ...preferences.git } : live.git,
      repo: preferences.repo ? { ...live.repo, ...preferences.repo } : live.repo,
    }));
  }

  async function patchAgentSelection(agentId, selection, owner = 'agent-selection') {
    if (typeof agentId !== 'string' || !agentId) throw new Error('Agent id is required');
    return mutateConfig(owner, live => ({
      ...live,
      agentProviders: mergeAgentProviderSelections(live.agentProviders, { [agentId]: selection }),
    }));
  }

  async function patchModelOverrides(providerId, models, owner = 'model-overrides') {
    if (typeof providerId !== 'string' || !providerId) throw new Error('Provider id is required');
    return mutateConfig(owner, live => ({
      ...live,
      modelOverrides: mergeModelOverrides(live.modelOverrides, { [providerId]: models }),
    }));
  }

  return {
    loadConfig,
    mutateConfig,
    patchSyncConfig,
    patchUserPreferences,
    patchAgentSelection,
    patchModelOverrides,
  };
}

module.exports = { createSyncConfigStore };
