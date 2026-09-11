// Provider-site persistence: sync never copies rebuildable model caches
// across machines. User-authored models are the exception — they are desired
// state (like agent selections), so they ride the site row in both directions.
function stripRebuildableProviderData(data) {
  const providers = Array.isArray(data?.providers)
    ? data.providers
    : Array.isArray(data)
      ? data
      : [];
  return providers.map((provider) => {
    const { platforms, modelCache, models, ...site } = provider || {};
    const userModels = Array.isArray(models)
      ? models.filter((model) => model?.origin === 'user' || model?.source === 'manual')
      : [];
    return userModels.length > 0 ? { ...site, models: userModels } : site;
  });
}

function createProviderSiteSyncService({ fs, providerStore }) {
  async function loadProviderSites() {
    if (typeof fs.readFile !== 'function') return [];
    if (typeof providerStore.loadProviderSitesForSync !== 'function') return [];
    const sites = stripRebuildableProviderData(
      await providerStore.loadProviderSitesForSync(),
    );
    // Attach user-authored models from the local model directory so authored
    // data survives machine switches even without a discoverable endpoint.
    if (typeof providerStore.loadUserModelsForSync === 'function') {
      const userModels = await providerStore.loadUserModelsForSync();
      for (const site of sites) {
        const models = userModels[site.id];
        if (Array.isArray(models) && models.length > 0) site.models = models;
      }
    }
    return sites;
  }

  async function saveProviderSites(providers) {
    const sites = Array.isArray(providers) ? providers : providers?.providers;
    if (!Array.isArray(sites)) return;
    await providerStore.mergeProviderSites(stripRebuildableProviderData(sites));
  }

  async function mergeSyncedProviderSites(providers) {
    await saveProviderSites(providers);
  }

  async function mergeRemoteProviderSites(remoteProviders) {
    if (!Array.isArray(remoteProviders) || remoteProviders.length === 0) return 0;
    const localProviders = await loadProviderSites();
    const merged = [...localProviders];
    let changed = 0;
    for (const remote of remoteProviders) {
      if (!remote?.id) continue;
      const index = merged.findIndex((provider) => provider.id === remote.id);
      if (index >= 0) merged[index] = { ...merged[index], ...remote };
      else merged.push(remote);
      changed++;
    }
    if (changed > 0) await saveProviderSites(merged);
    return changed;
  }

  // Seed user-authored models carried on the remote site rows into the local
  // model directory. MUST run AFTER endpoint/CLI hydration: warmup skips any
  // provider that already has cache rows, and a seed written first would mask
  // the provider and block discovery of its remote models.
  async function seedSyncedUserModels(remoteProviders) {
    if (typeof providerStore.mergeSyncedUserModels !== 'function') return;
    if (!Array.isArray(remoteProviders)) return;
    for (const remote of remoteProviders) {
      if (!remote?.id) continue;
      const userModels = stripRebuildableProviderData([remote])[0]?.models || [];
      if (userModels.length > 0) {
        await providerStore.mergeSyncedUserModels(remote.id, userModels);
      }
    }
  }

  return {
    loadProviderSites,
    saveProviderSites,
    mergeSyncedProviderSites,
    mergeRemoteProviderSites,
    seedSyncedUserModels,
  };
}

module.exports = {
  createProviderSiteSyncService,
  stripRebuildableProviderData,
};
