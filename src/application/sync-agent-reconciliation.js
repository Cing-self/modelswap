// Replays persisted desired Agent state through the sole application service.
const { createAgentConfigurationService } = require('./agent-config-service');

function desiredAgentSites(config) {
  const desired = [];
  for (const [agentId, raw] of Object.entries(config.agentProviders || {})) {
    const state = raw || {};
    if (state.activeProviderId) {
      desired.push({ agentId, providerId: state.activeProviderId });
    }
    for (const providerId of Object.keys(state.sites || {})) {
      if (
        !desired.some(
          (site) => site.agentId === agentId && site.providerId === providerId,
        )
      ) {
        desired.push({ agentId, providerId });
      }
    }
  }
  return desired;
}

function createPulledAgentReconciler({
  providerStore,
  loadProviderRuntime,
  loadConfig,
  replaceAgentState,
  appendLog,
}) {
  async function reconcilePulledAgentProviders(config) {
    const desired = desiredAgentSites(config);
    if (desired.length === 0) return [];

    if (typeof providerStore.loadProviderSites === 'function') {
      const localIds = new Set(
        (await providerStore.loadProviderSites()).map((site) => site.id),
      );
      if (!desired.some((site) => localIds.has(site.providerId))) {
        return desired.map(({ agentId, providerId }) => ({
          agentId,
          providerId,
          success: false,
          code: 'PROVIDER_NOT_FOUND',
          error: `Provider 不存在: ${providerId}`,
        }));
      }
    }

    const routing = loadProviderRuntime('routing');
    const registry = loadProviderRuntime('registry');
    const agentsMeta = loadProviderRuntime('agentsMeta');
    const snapshots = loadProviderRuntime('snapshots');
    const auth = loadProviderRuntime('auth');
    const service = createAgentConfigurationService({
      adapters: agentsMeta.AGENTS_META,
      getAdapter: registry.getAdapter,
      loadProviders: providerStore.loadProviders,
      loadUserConfig: loadConfig,
      replaceAgentState,
      // The desired state was atomically accepted before native hydration.
      // Reconciliation is native-only and must not write user.json again.
      persistReconciledDesired: async () => {},
      captureSnapshot: snapshots.capturePreSwitchSnapshot,
      restoreSnapshot: snapshots.restoreSnapshot,
      providerSupportsAdapter: routing.providerSupportsAdapter,
      resolveModelRoute: routing.resolveModelRoute,
      resolveModel: routing.resolveModel,
      appendLog,
      authorize: async (provider) => {
        if (provider.authMode === 'none' || !provider.authMode) {
          return { ok: true };
        }
        const status = await auth.checkAuthStatus(provider);
        // Native providers are hydrated only from their Agent's own CLI/cache.
        // That authenticated discovery is the proof available on this host;
        // do not reject it merely because the generic vault checker has no
        // OAuth implementation for that CLI.
        const nativeCliDiscovery = (provider.models || []).some(model =>
          model?.availability?.some(item => item.source === 'cli'),
        );
        if (status.hasApiKey || status.oauthLoggedIn || nativeCliDiscovery) {
          return { ok: true };
        }
        return {
          ok: false,
          code: 'AUTH_REQUIRED',
          message: '请先绑定 API Key',
        };
      },
    });
    return service.reconcile(config);
  }

  return { reconcilePulledAgentProviders };
}

module.exports = { createPulledAgentReconciler, desiredAgentSites };
