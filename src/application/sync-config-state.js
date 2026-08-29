// Pure selection and conflict functions shared by sync storage and use cases.
function mergeAgentProviderSelections(live, incoming) {
  const merged = { ...(live || {}) };
  for (const [agentId, state] of Object.entries(incoming || {})) {
    if (state === null) {
      delete merged[agentId];
      continue;
    }
    const previous = merged[agentId] || { sites: {} };
    const sites = { ...(previous.sites || {}) };
    for (const [providerId, site] of Object.entries(state?.sites || {})) {
      // Additive adapters use null as an intentional delete marker. Retaining
      // it in user.json turns a valid selection into a later null.modelIds
      // crash during reconciliation.
      if (site === null) delete sites[providerId];
      else sites[providerId] = { ...(sites[providerId] || {}), ...site };
    }
    const next = {
      ...previous,
      ...state,
      sites,
    };
    for (const key of ['activeProviderId', 'activeModelId']) {
      if (state && state[key] === null) delete next[key];
    }
    merged[agentId] = next;
  }
  return merged;
}

function mergeModelOverrides(live, incoming) {
  const merged = { ...(live || {}) };
  for (const [providerId, models] of Object.entries(incoming || {})) {
    merged[providerId] = { ...(merged[providerId] || {}) };
    for (const [modelId, fields] of Object.entries(models || {})) {
      merged[providerId][modelId] = {
        ...(merged[providerId][modelId] || {}),
        ...(fields || {}),
      };
    }
  }
  return merged;
}

function shouldApplyRemoteSection(remoteUpdatedAt, localChangedAt) {
  return String(remoteUpdatedAt || '') > String(localChangedAt || '');
}

function removeProviderSelection(config, providerId) {
  delete config.modelOverrides?.[providerId];
  for (const [agentId, state] of Object.entries(config.agentProviders || {})) {
    if (!state?.sites?.[providerId]) continue;
    delete state.sites[providerId];
    if (state.activeProviderId === providerId) {
      delete state.activeProviderId;
      delete state.activeModelId;
    }
    if (Object.keys(state.sites || {}).length === 0 && !state.activeProviderId) {
      delete config.agentProviders[agentId];
    }
  }
}

function removeAgentProviderSite(config, agentId, providerId) {
  const state = config.agentProviders?.[agentId];
  if (!state?.sites?.[providerId]) return;
  delete state.sites[providerId];
  if (state.activeProviderId === providerId) {
    delete state.activeProviderId;
    delete state.activeModelId;
  }
  if (Object.keys(state.sites || {}).length === 0 && !state.activeProviderId) {
    delete config.agentProviders[agentId];
  }
}

module.exports = {
  mergeAgentProviderSelections,
  mergeModelOverrides,
  shouldApplyRemoteSection,
  removeProviderSelection,
  removeAgentProviderSite,
};
