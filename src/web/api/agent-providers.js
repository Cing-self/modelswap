// Unified per-Agent provider state. This module stays CommonJS because the web
// server is loaded directly by Node in development as well as from dist.

const RETIRED_FIELDS = [
  'providers', 'homeProviders', 'codexCatalogVisible',
  'codexCatalogVisibleMigrated', 'claudeTierMaps', 'claude', 'agent',
  'favoriteModels', 'recentModels',
];

function ensureAgent(states, agentId) {
  if (!states[agentId] || typeof states[agentId] !== 'object') {
    states[agentId] = { sites: {} };
  }
  if (!states[agentId].sites || typeof states[agentId].sites !== 'object') {
    states[agentId].sites = {};
  }
  return states[agentId];
}

function mergeSite(states, agentId, providerId, modelIds, extras = {}) {
  if (!providerId || typeof providerId !== 'string') return;
  const state = ensureAgent(states, agentId);
  const previous = state.sites[providerId] && typeof state.sites[providerId] === 'object'
    ? state.sites[providerId]
    : { modelIds: [] };
  const incoming = Array.isArray(modelIds) ? modelIds.filter(id => typeof id === 'string') : [];
  state.sites[providerId] = {
    ...previous,
    ...extras,
    modelIds: [...new Set([...(Array.isArray(previous.modelIds) ? previous.modelIds : []), ...incoming])],
  };
}

function getAgentState(config, agentId) {
  const states = config.agentProviders && typeof config.agentProviders === 'object'
    ? config.agentProviders
    : {};
  const state = states[agentId];
  return state && typeof state === 'object'
    ? { ...state, sites: state.sites && typeof state.sites === 'object' ? state.sites : {} }
    : { sites: {} };
}

function migrateAgentProviders(config) {
  if (!config || typeof config !== 'object') return false;
  const hasRetiredFields = RETIRED_FIELDS.some(key => Object.prototype.hasOwnProperty.call(config, key));
  const hasEmptySites = Object.values(config.agentProviders || {}).some(state =>
    Object.values(state?.sites || {}).some(site => !Array.isArray(site?.modelIds) || site.modelIds.length === 0));
  if (!hasRetiredFields && !hasEmptySites) return false;

  const legacyProviders = config.providers && typeof config.providers === 'object' ? config.providers : {};
  const legacyHome = config.homeProviders && typeof config.homeProviders === 'object' ? config.homeProviders : {};
  const legacyVisible = config.codexCatalogVisible && typeof config.codexCatalogVisible === 'object' ? config.codexCatalogVisible : {};
  const legacyTierMaps = config.claudeTierMaps && typeof config.claudeTierMaps === 'object' ? config.claudeTierMaps : {};
  const states = config.agentProviders && typeof config.agentProviders === 'object' ? { ...config.agentProviders } : {};

  for (const [agentId, raw] of Object.entries(legacyProviders)) {
    if (!raw || typeof raw !== 'object') continue;
    const state = ensureAgent(states, agentId);
    if (raw.providerId && !state.activeProviderId) state.activeProviderId = raw.providerId;
    if (raw.modelId && !state.activeModelId) state.activeModelId = raw.modelId;
    if (raw.providerId) mergeSite(states, agentId, raw.providerId, raw.modelId ? [raw.modelId] : []);
    for (const [providerId, modelIds] of Object.entries(raw.managedModels || {})) {
      mergeSite(states, agentId, providerId, modelIds, { enabled: true });
    }
  }

  for (const [agentId, providerIds] of Object.entries(legacyHome)) {
    if (!Array.isArray(providerIds)) continue;
    for (const providerId of providerIds) {
      if (typeof providerId === 'string' && Array.isArray(legacyVisible[providerId]) && legacyVisible[providerId].length > 0) {
        mergeSite(states, agentId, providerId, legacyVisible[providerId], { enabled: true });
      }
    }
  }

  if (config.claude?.name && config.claude?.model) {
    const state = ensureAgent(states, 'claude');
    state.activeProviderId = state.activeProviderId || String(config.claude.name).toLowerCase();
    state.activeModelId = state.activeModelId || config.claude.model;
    mergeSite(states, 'claude', state.activeProviderId, [state.activeModelId]);
  }
  for (const [providerId, tierMap] of Object.entries(legacyTierMaps)) {
    if (!tierMap || typeof tierMap !== 'object') continue;
    mergeSite(states, 'claude', providerId, [tierMap.haiku, tierMap.sonnet, tierMap.opus], { tierMap });
  }

  for (const [agentId, state] of Object.entries(states)) {
    for (const [providerId, site] of Object.entries(state.sites || {})) {
      if (!Array.isArray(site?.modelIds) || site.modelIds.length === 0) delete state.sites[providerId];
    }
    if (Object.keys(state.sites || {}).length === 0 && !state.activeProviderId) delete states[agentId];
  }

  config.agentProviders = states;
  for (const key of RETIRED_FIELDS) delete config[key];
  return true;
}

function setSite(config, agentId, providerId, site) {
  if (!config.agentProviders || typeof config.agentProviders !== 'object') config.agentProviders = {};
  const state = ensureAgent(config.agentProviders, agentId);
  state.sites[providerId] = {
    modelIds: Array.isArray(site?.modelIds) ? [...new Set(site.modelIds.filter(id => typeof id === 'string'))] : [],
    ...(site?.enabled === undefined ? {} : { enabled: !!site.enabled }),
    ...(site?.tierMap ? { tierMap: site.tierMap } : {}),
  };
  return state;
}

function replaceAgentState(config, agentId, state) {
  if (!config.agentProviders || typeof config.agentProviders !== 'object') config.agentProviders = {};
  const sites = state?.sites && typeof state.sites === 'object' ? state.sites : {};
  config.agentProviders[agentId] = {
    ...(state?.activeProviderId ? { activeProviderId: state.activeProviderId } : {}),
    ...(state?.activeModelId ? { activeModelId: state.activeModelId } : {}),
    sites: Object.fromEntries(Object.entries(sites).map(([providerId, site]) => [providerId, {
      modelIds: Array.isArray(site?.modelIds) ? [...new Set(site.modelIds.filter(id => typeof id === 'string'))] : [],
      ...(site?.enabled === undefined ? {} : { enabled: !!site.enabled }),
      ...(site?.tierMap ? { tierMap: site.tierMap } : {}),
    }])),
  };
  return config.agentProviders[agentId];
}

function removeSite(config, agentId, providerId) {
  const state = getAgentState(config, agentId);
  if (!config.agentProviders || !config.agentProviders[agentId]) return state;
  delete config.agentProviders[agentId].sites?.[providerId];
  if (config.agentProviders[agentId].activeProviderId === providerId) {
    delete config.agentProviders[agentId].activeProviderId;
    delete config.agentProviders[agentId].activeModelId;
  }
  if (Object.keys(config.agentProviders[agentId].sites || {}).length === 0
    && !config.agentProviders[agentId].activeProviderId) {
    delete config.agentProviders[agentId];
  }
  return state;
}

module.exports = { getAgentState, mergeSite, migrateAgentProviders, removeSite, replaceAgentState, setSite };
