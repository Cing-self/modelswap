// Pure selection and conflict functions shared by sync storage and use cases.
function mergeAgentProviderSelections(live, incoming) {
  const merged = { ...(live || {}) };
  for (const [agentId, state] of Object.entries(incoming || {})) {
    const previous = merged[agentId] || { sites: {} };
    merged[agentId] = {
      ...previous,
      ...state,
      sites: { ...(previous.sites || {}), ...(state?.sites || {}) },
    };
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
