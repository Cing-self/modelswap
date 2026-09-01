import { describe, expect, it } from 'vitest';
import { createModelDiscoveryService } from '../../src/application/model-discovery-service';
import { providerEndpointEntries } from '../../src/providers/routing';

describe('Volcengine Agent Plan model catalog', () => {
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

  it('uses the console catalog instead of the unavailable /models endpoint', async () => {
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
    });

    const result = await service.fetchModels({ providerId: provider.id });
    const ids = result.models.map((model: any) => model.id);
    expect(result).toMatchObject({ success: true, modelsDiscovered: true });
    expect(ids).toContain('ark-code-latest');
    expect(ids).not.toContain('auto');
    expect(ids).not.toContain('kimi-k3');
    for (const model of result.models) {
      expect(model.availability.map((item: any) => item.endpointId)).toHaveLength(2);
    }
    expect(saved).toHaveLength(1);
  });
});
