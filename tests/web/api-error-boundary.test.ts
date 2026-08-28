import { describe, expect, it } from 'vitest';

const controller = require('../../src/web/api/providers-controller');
const providerService = require('../../src/application/provider-service');
const { createModelDiscoveryService } = require('../../src/application/model-discovery-service');

function fakeResponse() {
  const response: { statusCode?: number; payload?: unknown; status: (code: number) => unknown; json: (payload: unknown) => unknown } = {
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      return payload;
    },
  };
  return response;
}

describe('provider API error boundary', () => {
  it('normalizes every rejected value without leaking it or throwing from the response path', async () => {
    const original = providerService.listProviders;
    const rejectedValues = [undefined, null, 'Bearer fixture-secret-value', { message: 'token=fixture-secret-value' }];
    try {
      for (const rejected of rejectedValues) {
        providerService.listProviders = () => Promise.reject(rejected);
        const res = fakeResponse();
        await controller.listProviders({}, res);
        expect(res.statusCode).toBe(500);
        expect(res.payload).toEqual({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
        expect(JSON.stringify(res.payload)).not.toContain('fixture-secret-value');
      }
    } finally {
      providerService.listProviders = original;
    }
  });

  it('contains an undefined vault-resolution rejection inside startup warmup', async () => {
    const discovery = createModelDiscoveryService({
      fs: {}, path: {}, os: {},
      _store: { loadModelsCache: async () => ({ providers: {} }) },
      loadProviders: async () => [{
        id: 'broken-warmup', authMode: 'api_key', vaultKey: 'WARMUP_FIXTURE_REF',
        endpoints: [{ id: 'main', type: 'openai', baseUrl: 'http://127.0.0.1:9/v1' }],
      }],
      saveProviders: async () => {},
      loadUserConfig: async () => ({ agentProviders: {} }),
      providerEndpointEntries: (provider: any) => provider.endpoints.map((endpoint: any) => ({ id: endpoint.id, endpoint })),
      providerExecutionMode: () => 'http_endpoint',
      detectOAuth: async () => false,
      // This mirrors an untyped dependency rejection. Warmup is background
      // work and must return a diagnostic result, not reject its HTTP route.
      resolveVaultKey: async () => Promise.reject(undefined),
      findCommand: () => undefined,
    });

    await expect(discovery.discoverMissingConfiguredModels()).resolves.toEqual({
      warmed: [],
      pending: ['broken-warmup'],
      results: [{
        providerId: 'broken-warmup',
        status: 'failed',
        modelsDiscovered: false,
        code: 'MODEL_DISCOVERY_FAILED',
        error: 'Model discovery failed',
      }],
    });
  });
});
