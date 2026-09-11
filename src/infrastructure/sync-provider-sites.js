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
  async function loadProviderSites(referenced) {
    if (typeof fs.readFile !== 'function') return [];
    if (typeof providerStore.loadProviderSitesForSync !== 'function') return [];
    const sites = stripRebuildableProviderData(
      await providerStore.loadProviderSitesForSync(),
    );
    // Attach authored models from the local model directory so they survive
    // machine switches even without a discoverable endpoint: user-added rows
    // plus every model referenced by an agent selection (desired state by
    // definition, regardless of the row's provenance flags).
    const userModels = typeof providerStore.loadUserModelsForSync === 'function'
      ? await providerStore.loadUserModelsForSync()
      : {};
    const referencedModels = referenced && typeof providerStore.loadReferencedModelsForSync === 'function'
      ? await providerStore.loadReferencedModelsForSync(referenced)
      : {};
    for (const site of sites) {
      const merged = new Map();
      for (const model of [...(userModels[site.id] || []), ...(referencedModels[site.id] || [])]) {
        if (model?.id) merged.set(model.id, model);
      }
      if (merged.size > 0) site.models = [...merged.values()];
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

  // Seed the models carried on the remote site rows into the local model
  // directory. MUST run AFTER endpoint/CLI hydration: warmup skips any
  // provider that already has cache rows, and a seed written first would mask
  // the provider and block discovery of its remote models. The payload is
  // already filtered push-side (user-added ∪ selection-referenced); trust the
  // paired peer's blob and only shape-sanitize here.
  async function seedSyncedUserModels(remoteProviders) {
    if (typeof providerStore.mergeSyncedUserModels !== 'function') return;
    if (!Array.isArray(remoteProviders)) return;
    for (const remote of remoteProviders) {
      if (!remote?.id || !Array.isArray(remote.models)) continue;
      if (remote.models.length > 0) {
        await providerStore.mergeSyncedUserModels(remote.id, remote.models);
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
