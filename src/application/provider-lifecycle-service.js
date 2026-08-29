// Provider persistence and removal orchestration. HTTP mapping remains with
// the controller; this service owns the lifecycle mutations themselves.
function createProviderLifecycleService(deps) {
  const { loadProviders, saveProviders, loadUserConfig, removeProviderConfiguration, agentConfigService } = deps;

  const fail = (message, status = 400) => Object.assign(new Error(message), { status });

  async function createProvider(input = {}) {
      const providers = await loadProviders();
      const { id, name, type, baseUrl, endpoints, vaultKey, authMode, models, executionMode, nativeAgentIds } = input;
      if (!id || !name) throw fail('Missing required fields: id, name');
      const idx = providers.findIndex(p => p.id === id);
      const existing = idx >= 0 ? providers[idx] : null;
      const hasVaultKey = Object.prototype.hasOwnProperty.call(input, 'vaultKey');
      const provider = {
        ...(existing || {}), id, name,
        type: type || (endpoints && endpoints[0] ? endpoints[0].type : existing?.type || 'openai'),
        baseUrl: baseUrl || (endpoints && endpoints[0] ? endpoints[0].baseUrl : existing?.baseUrl || ''),
        endpoints: endpoints === undefined ? existing?.endpoints : endpoints,
        ...(hasVaultKey ? { vaultKey: vaultKey || undefined } : {}),
        authMode: authMode || existing?.authMode || 'api_key',
        executionMode: executionMode || existing?.executionMode || 'http_endpoint',
        nativeAgentIds: executionMode === 'agent_native'
          ? (Array.isArray(nativeAgentIds) ? nativeAgentIds : existing?.nativeAgentIds)
          : (executionMode ? undefined : existing?.nativeAgentIds),
        models: models === undefined ? (existing?.models || []) : models,
      };
      if (idx >= 0) providers[idx] = provider;
      else providers.push(provider);
      await saveProviders(providers);
      return { success: true, provider };
  }

  async function updateProvider(id, input = {}) {
      const providers = await loadProviders();
      const idx = providers.findIndex(p => p.id === id);
      if (idx < 0) throw fail('Provider not found', 404);
      const current = providers[idx];
      const editableFields = ['name', 'type', 'baseUrl', 'endpoints', 'vaultKey', 'authMode', 'models', 'executionMode', 'nativeAgentIds'];
      const patch = {};
      for (const field of editableFields) {
        if (Object.prototype.hasOwnProperty.call(input, field)) {
          patch[field] = field === 'vaultKey' && !input[field] ? undefined : input[field];
        }
      }
      const routeOrCredentialChanged = ['type', 'baseUrl', 'endpoints', 'vaultKey', 'authMode', 'executionMode']
        .some(field => Object.prototype.hasOwnProperty.call(patch, field) && JSON.stringify(patch[field]) !== JSON.stringify(current[field]));
      providers[idx] = { ...current, ...patch, id };
      if (routeOrCredentialChanged) {
        Object.assign(providers[idx], {
          authVerified: undefined, authVerifiedKey: undefined, authVerifiedAt: undefined,
          authLastCheckedAt: undefined, authLastCheckedKey: undefined, authLastError: undefined,
          authState: undefined, authVerifiedEndpointIds: [], authEndpointStates: {},
        });
      }
      await saveProviders(providers);
      return { success: true, provider: providers[idx] };
  }

  async function deleteProvider(id) {
      const providers = await loadProviders();
      const idx = providers.findIndex(p => p.id === id);
      if (idx < 0) throw fail('Provider not found', 404);
      providers.splice(idx, 1);
      await saveProviders(providers);
      const config = await loadUserConfig();
      let agentProvidersChanged = false;
      for (const [agentId, state] of Object.entries(config.agentProviders || {})) {
        if (!state?.sites?.[id]) continue;
        try {
          await agentConfigService.removeConfiguredSite({
            agentId, providerId: id, config, providers, persist: false,
            source: 'delete-provider', allowActiveWithoutFallback: true,
          });
        } catch (error) {
          console.warn(`[deleteProvider] removeProvider(${agentId}) failed: ${error.message}`);
        }
        agentProvidersChanged = true;
      }
      if (agentProvidersChanged || config.modelOverrides?.[id]) await removeProviderConfiguration(id);
      return { success: true };
  }

  return { createProvider, updateProvider, deleteProvider };
}

module.exports = { createProviderLifecycleService };
