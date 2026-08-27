// Compatibility facade for the cloud, LAN and CLI sync entry points. Domain
// work lives in the sync services; this module only composes their existing
// filesystem, vault and provider runtime seams.
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { backupImportantData } = require('./backup');
const { appendLog } = require('./log-writer');
const { publishDataChanged } = require('./ui-events');
const { migrateAgentProviders } = require('./agent-providers');
const { createSyncConfigStore } = require('../../infrastructure/sync-config-store');
const { createProviderSiteSyncService, stripRebuildableProviderData } = require('../../infrastructure/sync-provider-sites');
const { decryptPayload, decryptSyncCodePayload, encryptPayload, encryptSyncCodePayload } = require('../../infrastructure/sync-crypto');
const { createSyncPlatformService } = require('../../infrastructure/sync-platform-service');
const { createPulledAgentReconciler } = require('../../application/sync-agent-reconciliation');
const { createSyncService } = require('../../application/sync-service');
const { shouldApplyRemoteSection } = require('../../application/sync-config-state');

const CONFIG_PATH = path.join(os.homedir(), '.okit', 'user.json');
let providerStore;
try {
  providerStore = require('../../providers/store');
} catch {
  providerStore = require('../../../dist/providers/store');
}

function loadProviderRuntime(name) {
  try {
    return require(`../../providers/${name}`);
  } catch {
    return require(`../../../dist/providers/${name}`);
  }
}

function loadAdapter(name) {
  const valid = new Set([
    'cloudflare',
    'cloudflare-d1',
    'cloudflare-kv',
    'cloudflare-r2',
    'supabase',
    'volcengine',
    'webdav',
    'lan',
    'icloud',
  ]);
  if (!name || !/^[a-z0-9-]+$/.test(name) || !valid.has(name)) {
    throw new Error(`Invalid platform adapter: ${name}`);
  }
  return require(`./platform-adapters/${name}`);
}

function createVaultStore() {
  const { VaultStore } = require('../../vault/store');
  return new VaultStore();
}

const configStore = createSyncConfigStore({
  fs,
  configPath: CONFIG_PATH,
  backupImportantData,
  migrateAgentProviders,
});
const providerSites = createProviderSiteSyncService({ fs, providerStore });
const platforms = createSyncPlatformService({
  loadAdapter,
  createVaultStore,
  appendLog,
});
const reconciler = createPulledAgentReconciler({
  providerStore,
  loadProviderRuntime,
  loadConfig: configStore.loadConfig,
  saveConfig: configStore.saveConfig,
  appendLog,
});
const syncService = createSyncService({
  appendLog,
  collectPlatformVaultSecrets: platforms.collectPlatformVaultSecrets,
  decryptPayload,
  decryptSyncCodePayload,
  encryptPayload,
  encryptSyncCodePayload,
  getVaultStore: createVaultStore,
  listEnabledSyncTargets: platforms.listEnabledSyncTargets,
  loadAdapter: platforms.adapterFor,
  loadConfig: configStore.loadConfig,
  loadProviderSites: providerSites.loadProviderSites,
  mergeRemoteProviderSites: providerSites.mergeRemoteProviderSites,
  publishDataChanged,
  reconcilePulledAgentProviders: reconciler.reconcilePulledAgentProviders,
  resolvePrimaryTarget: platforms.resolvePrimaryTarget,
  saveConfig: configStore.saveConfig,
  shouldApplyRemoteSection,
});

async function testConnection(platform) {
  return platforms.testConnection(await configStore.loadConfig(), platform);
}

module.exports = {
  ...syncService,
  appendLog,
  loadConfig: configStore.loadConfig,
  mergeSyncedProviderSites: providerSites.mergeSyncedProviderSites,
  resolveSyncKeys: platforms.resolveSyncKeys,
  resolveVaultRefs: platforms.resolveVaultRefs,
  saveConfig: configStore.saveConfig,
  saveUserConfig: configStore.saveUserConfig,
  testConnection,
  __testing: {
    shouldApplyRemoteSection,
    stripRebuildableProviderData,
  },
};
