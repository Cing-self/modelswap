// Express transport adapter for the provider application services. Keep all
// request parsing and HTTP status mapping at this edge.
const service = require('../../application/provider-service');
const { sendApiError } = require('../../application/error-normalization');

function respond(res, operation) {
  return Promise.resolve().then(operation).then(result => res.json(result)).catch(error =>
    sendApiError(res, error, res?.locals?.requestId),
  );
}

const body = req => req.body || {};
const route = (req, key) => req.params?.[key];

module.exports = {
  listProviders: (_req, res) => respond(res, () => service.listProviders()),
  getModelData: (_req, res) => respond(res, () => service.getModelData()),
  refreshModelData: (_req, res) => respond(res, () => service.refreshModelData()),
  refreshDemoProviderModels: (req, res) => respond(res, () => service.refreshDemoProviderModels(route(req, 'id'))),
  getAdaptersList: (_req, res) => respond(res, () => service.getAdaptersList()),
  createProvider: (req, res) => respond(res, () => service.createProvider(body(req))),
  updateProvider: (req, res) => respond(res, () => service.updateProvider(route(req, 'id'), body(req))),
  deleteProvider: (req, res) => respond(res, () => service.deleteProvider(route(req, 'id'))),
  switchProvider: (req, res) => respond(res, () => service.switchProvider(body(req))),
  configureAgentProvider: (req, res) => respond(res, () => service.configureAgentProvider({
    ...body(req), agentId: route(req, 'agentId'), providerId: route(req, 'providerId') || body(req).providerId,
  })),
  removeAgentProvider: (req, res) => respond(res, () => service.removeAgentProvider({
    agentId: route(req, 'agentId'), providerId: route(req, 'providerId'),
  })),
  setAgentProviderEnabled: (req, res) => respond(res, () => service.setAgentProviderEnabled({
    ...body(req), agentId: route(req, 'agentId'), providerId: route(req, 'providerId') || body(req).providerId,
  })),
  getAgentConfigFiles: (req, res) => respond(res, () => service.getAgentConfigFiles({
    agentId: route(req, 'agentId'), reveal: req.query?.reveal === '1',
  })),
  saveAgentConfigFile: (req, res) => respond(res, () => service.saveAgentConfigFile({
    ...body(req), agentId: route(req, 'agentId'),
  })),
  agentConfigPresence: (_req, res) => respond(res, () => service.agentConfigPresence()),
  getTierMaps: (_req, res) => respond(res, () => service.getTierMaps()),
  setTierMap: (req, res) => respond(res, () => service.setTierMap({ ...body(req), providerId: route(req, 'providerId') })),
  launchAgent: (req, res) => respond(res, () => service.launchAgent(body(req))),
  getAuthStatus: (_req, res) => respond(res, () => service.getAuthStatus()),
  verifyProviderAuth: (req, res) => respond(res, () => service.verifyProviderAuth(route(req, 'id'))),
  triggerOAuthLogin: (req, res) => respond(res, () => service.triggerOAuthLogin(body(req).providerId)),
  fetchModels: (req, res) => respond(res, () => service.fetchModels(body(req))),
  warmupMissingModels: (_req, res) => respond(res, () => service.discoverMissingConfiguredModels({ requestId: res?.locals?.requestId })),
  exportProviderCode: (req, res) => respond(res, () => service.exportProviderCode(body(req))),
  importProviderCode: (req, res) => respond(res, () => service.importProviderCode(body(req))),
  __testing: service.__testing,
};
