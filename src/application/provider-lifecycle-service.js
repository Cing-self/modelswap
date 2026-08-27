// Provider persistence and removal orchestration. HTTP mapping remains with
// the controller; this service owns the lifecycle mutations themselves.
function createProviderLifecycleService(deps) {
  const { loadProviders, saveProviders, loadUserConfig, saveUserConfig, agentConfigService } = deps;

  async function createProvider(req, res) {
    try {
      const providers = await loadProviders();
      const { id, name, type, baseUrl, endpoints, vaultKey, authMode, models, executionMode, nativeAgentIds } = req.body;
      if (!id || !name) return res.status(400).json({ error: 'Missing required fields: id, name' });
      const idx = providers.findIndex(p => p.id === id);
      const existing = idx >= 0 ? providers[idx] : null;
      const hasVaultKey = Object.prototype.hasOwnProperty.call(req.body, 'vaultKey');
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
      res.json({ success: true, provider });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }

  async function updateProvider(req, res) {
    try {
      const { id } = req.params;
      const providers = await loadProviders();
      const idx = providers.findIndex(p => p.id === id);
      if (idx < 0) return res.status(404).json({ error: 'Provider not found' });
      const current = providers[idx];
      const editableFields = ['name', 'type', 'baseUrl', 'endpoints', 'vaultKey', 'authMode', 'models', 'executionMode', 'nativeAgentIds'];
      const patch = {};
      for (const field of editableFields) {
        if (Object.prototype.hasOwnProperty.call(req.body, field)) {
          patch[field] = field === 'vaultKey' && !req.body[field] ? undefined : req.body[field];
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
      res.json({ success: true, provider: providers[idx] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }

  async function deleteProviderRoute(req, res) {
    try {
      const { id } = req.params;
      const providers = await loadProviders();
      const idx = providers.findIndex(p => p.id === id);
      if (idx < 0) return res.status(404).json({ error: 'Provider not found' });
      providers.splice(idx, 1);
      await saveProviders(providers);
      const config = await loadUserConfig();
      if (config.modelOverrides?.[id]) delete config.modelOverrides[id];
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
      if (agentProvidersChanged) await saveUserConfig(config, { deleteProviderId: id });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }

  return { createProvider, updateProvider, deleteProviderRoute };
}

module.exports = { createProviderLifecycleService };
