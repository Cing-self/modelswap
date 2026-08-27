// Provider-site persistence: sync never copies model caches across machines.
function stripRebuildableProviderData(data) {
  const providers = Array.isArray(data?.providers)
    ? data.providers
    : Array.isArray(data)
      ? data
      : [];
  return providers.map((provider) => {
    const { models, platforms, modelCache, ...site } = provider || {};
    return site;
  });
}

function createProviderSiteSyncService({ fs, providerStore }) {
  async function loadProviderSites() {
    if (typeof fs.readFile !== 'function') return [];
    if (typeof providerStore.loadProviderSitesForSync !== 'function') return [];
    return stripRebuildableProviderData(
      await providerStore.loadProviderSitesForSync(),
    );
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

  return {
    loadProviderSites,
    saveProviderSites,
    mergeSyncedProviderSites,
    mergeRemoteProviderSites,
  };
}

module.exports = {
  createProviderSiteSyncService,
  stripRebuildableProviderData,
};
