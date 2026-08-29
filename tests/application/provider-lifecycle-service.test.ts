import { describe, expect, it } from 'vitest';

const { createProviderLifecycleService } = require('../../src/application/provider-lifecycle-service.js');

describe('provider lifecycle application service', () => {
  it('preserves an omitted vaultKey and cleans only the deleted provider Agent sites', async () => {
    const providers = [
      { id: 'gateway', name: 'Gateway', type: 'openai', vaultKey: 'GATEWAY_KEY', models: [] },
      { id: 'keep', name: 'Keep', type: 'openai', vaultKey: 'KEEP_KEY', models: [] },
    ];
    const config: any = {
      modelOverrides: { gateway: { one: { context: 1 } }, keep: { two: { context: 2 } } },
      agentProviders: {
        codex: { sites: { gateway: { modelIds: ['one'] }, keep: { modelIds: ['two'] } } },
      },
    };
    const removed: string[] = [];
    let savedConfig: any;
    const service = createProviderLifecycleService({
      loadProviders: async () => providers,
      saveProviders: async () => undefined,
      loadUserConfig: async () => config,
      removeProviderConfiguration: async () => {
        delete config.modelOverrides.gateway;
        savedConfig = config;
      },
      agentConfigService: {
        removeConfiguredSite: async ({ agentId, providerId }: any) => {
          removed.push(`${agentId}:${providerId}`);
          delete config.agentProviders[agentId].sites[providerId];
        },
      },
    });

    const updated = await service.createProvider({ id: 'gateway', name: 'Gateway renamed' });
    expect(updated.provider.vaultKey).toBe('GATEWAY_KEY');

    await service.deleteProvider('gateway');
    expect(removed).toEqual(['codex:gateway']);
    expect(savedConfig.modelOverrides.gateway).toBeUndefined();
    expect(savedConfig.modelOverrides.keep).toEqual({ two: { context: 2 } });
    expect(savedConfig.agentProviders.codex.sites.keep).toEqual({ modelIds: ['two'] });
    expect(providers.map(provider => provider.id)).toEqual(['keep']);
  });
});
