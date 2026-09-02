import { describe, expect, it } from 'vitest';
import { createModelDiscoveryService } from '../../src/application/model-discovery-service';
import { providerEndpointEntries } from '../../src/providers/routing';

describe('Volcengine Agent Plan models.dev fallback', () => {
  const provider = {
    id: 'volcengine-agent',
    name: '火山方舟 Agent Plan',
    type: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    endpoints: [
      { type: 'openai', protocol: 'chat', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', plan: 'agent' },
      { type: 'anthropic', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan', plan: 'agent' },
    ],
    authMode: 'api_key',
    vaultKey: 'VOLCENGINE_AGENT_PLAN_API_KEY',
  } as any;

  it('uses models.dev as the catalog when /models is unavailable', async () => {
    const saved: any[] = [];
    const service = createModelDiscoveryService({
      fs: { pathExists: async () => false, readFile: async () => '' },
      path: {},
      os: { homedir: () => '/tmp' },
      _store: { saveDiscoveredModels: async (_id: string, models: any[]) => { saved.push(models); } },
      loadProviders: async () => [provider],
      saveProviders: async () => { throw new Error('unexpected provider save'); },
      loadUserConfig: async () => ({ agentProviders: {} }),
      providerEndpointEntries,
      providerExecutionMode: () => 'http_endpoint',
      normalizeRemoteModel: model => model,
      detectOAuth: async () => null,
      resolveVaultKey: async () => 'unused',
      findCommand: () => null,
      modelsDev: {
        loadCatalog: async () => ({ meta: { sourceFetchedAt: '2026-09-01T00:00:00.000Z' } }),
        resolveCatalogKey: (catalog: any, mappedProvider: any, options: any) => {
          expect(options).toEqual({ strict: true });
          expect(mappedProvider.modelCatalogId).toBe('volcengine-agent-plan');
          return 'volcengine-agent-plan';
        },
        listFreshProviderModels: (catalog: any, mappedProvider: any) => {
          expect(catalog).toEqual({ meta: { sourceFetchedAt: '2026-09-01T00:00:00.000Z' } });
          expect(mappedProvider.id).toBe(provider.id);
          return [
            { id: 'modelsdev-model-a', name: 'Model A', source: 'modelsdev' },
            { id: 'modelsdev-model-b', name: 'Model B', source: 'modelsdev' },
          ];
        },
      },
    });

    const result = await service.fetchModels({ providerId: provider.id });
    const ids = result.models.map((model: any) => model.id);
    expect(result).toMatchObject({ success: true, modelsDiscovered: true });
    expect(ids).toEqual(['modelsdev-model-a', 'modelsdev-model-b']);
    for (const model of result.models) {
      expect(model.availability.map((item: any) => item.endpointId)).toHaveLength(2);
    }
    expect(saved).toHaveLength(1);
  });

  it('removes stale rows created by the retired MODELSWAP-owned allowlist', async () => {
    const staleModel = {
      id: 'ark-code-latest',
      name: 'Ark Code Latest',
      origin: 'user',
      source: 'manual',
      meta: { source: 'modelsdev' },
    };
    const savedProviders: any[] = [];
    const savedDiscovered: any[] = [];
    const localProvider = {
      ...provider,
      models: [
        staleModel,
        { id: 'user-key', name: 'Explicit User Key', origin: 'user' },
      ],
    };
    const service = createModelDiscoveryService({
      fs: { pathExists: async () => false, readFile: async () => '' },
      path: {},
      os: { homedir: () => '/tmp' },
      _store: { saveDiscoveredModels: async (_id: string, models: any[]) => { savedDiscovered.push(models); } },
      loadProviders: async () => [localProvider],
      saveProviders: async providers => { savedProviders.push(providers.map((item: any) => item.models)); },
      loadUserConfig: async () => ({ agentProviders: {} }),
      providerEndpointEntries,
      providerExecutionMode: () => 'http_endpoint',
      normalizeRemoteModel: model => model,
      detectOAuth: async () => null,
      resolveVaultKey: async () => 'unused',
      findCommand: () => null,
      modelsDev: {
        loadCatalog: async () => ({ meta: { sourceFetchedAt: '2026-09-01T00:00:00.000Z' } }),
        resolveCatalogKey: (catalog: any, mappedProvider: any, options: any) => {
          expect(options).toEqual({ strict: true });
          expect(mappedProvider.modelCatalogId).toBe('volcengine-agent-plan');
          return 'volcengine-agent-plan';
        },
        listFreshProviderModels: () => [
          { id: 'modelsdev-model-a', name: 'Model A', source: 'modelsdev' },
        ],
      },
    });

    const result = await service.fetchModels({ providerId: provider.id });
    expect(result.models.map((model: any) => model.id)).toEqual(['user-key', 'modelsdev-model-a']);
    expect(savedDiscovered).toHaveLength(1);
    expect(savedProviders).toHaveLength(1);
    expect(savedProviders[0][0].map((model: any) => model.id)).toEqual(['user-key']);
  });

  it('reports when models.dev has no Agent Plan entry', async () => {
    const purged: any[][] = [];
    const service = createModelDiscoveryService({
      fs: { pathExists: async () => false, readFile: async () => '' },
      path: {},
      os: { homedir: () => '/tmp' },
      _store: { saveDiscoveredModels: async (_id: string, models: any[]) => { purged.push(models); } },
      loadProviders: async () => [provider],
      saveProviders: async () => { throw new Error('unexpected provider save'); },
      loadUserConfig: async () => ({ agentProviders: {} }),
      providerEndpointEntries,
      providerExecutionMode: () => 'http_endpoint',
      normalizeRemoteModel: model => model,
      detectOAuth: async () => null,
      resolveVaultKey: async () => 'unused',
      findCommand: () => null,
      modelsDev: {
        loadCatalog: async () => ({ meta: { sourceFetchedAt: '2026-09-01T00:00:00.000Z' } }),
        resolveCatalogKey: (catalog: any, mappedProvider: any, options: any) => {
          expect(options).toEqual({ strict: true });
          expect(mappedProvider.modelCatalogId).toBe('volcengine-agent-plan');
          return null;
        },
        listFreshProviderModels: () => [],
      },
    });

    const result = await service.fetchModels({ providerId: provider.id });
    expect(result).toMatchObject({
      success: false,
      modelsDiscovered: false,
      models: [],
      errors: [{ endpoint: 'models.dev', error: 'models.dev 尚未提供 volcengine-agent-plan 目录，禁止回退到 Coding Plan' }],
    });
    expect(purged).toEqual([[]]);
  });
});
