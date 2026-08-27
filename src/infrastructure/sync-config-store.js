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

  async function loadConfig() {
    try {
      if (!(await fs.pathExists(configPath))) return {};
      const config = await fs.readJson(configPath);
      if (migrateAgentProviders(config)) {
        await backupImportantData('user');
        await fs.writeJson(configPath, config, { spaces: 2 });
      }
      return config;
    } catch {
      return {};
    }
  }

  async function saveConfig(config, options = {}) {
    return enqueue(async () => {
      await fs.ensureDir(require('path').dirname(configPath));
      await backupImportantData('sync');
      const live = await readLiveConfig(config);
      const next = { ...live, sync: config.sync };
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
      await atomicWriteJson(configPath, next);
    });
  }

  async function saveUserConfig(config, options = {}) {
    return enqueue(async () => {
      await fs.ensureDir(require('path').dirname(configPath));
      await backupImportantData('user');
      const live = await readLiveConfig(config);
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
      await atomicWriteJson(configPath, next);
    });
  }

  return { loadConfig, saveConfig, saveUserConfig };
}

module.exports = { createSyncConfigStore };
