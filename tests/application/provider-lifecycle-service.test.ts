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

describe('updateProvider credential-change reconcile trigger', () => {
  const flush = () => new Promise(resolve => setImmediate(resolve));

  function build() {
    const providers = [
      { id: 'gateway', name: 'Gateway', type: 'openai', baseUrl: 'https://old.test/v1', vaultKey: 'OLD_KEY', authMode: 'api_key', models: [] },
    ];
    const reconcile = jest_like();
    function jest_like() {
      const state = { calls: [] as any[] };
      return Object.assign(async (config: unknown, options: { providerIds: string[] }) => {
        state.calls.push({ config, options });
        return [];
      }, state);
    }
    const service = createProviderLifecycleService({
      loadProviders: async () => providers,
      saveProviders: async () => undefined,
      loadUserConfig: async () => ({}),
      removeProviderConfiguration: async () => undefined,
      agentConfigService: { reconcile },
    });
    return { service, reconcile, providers };
  }

  it('reconciles the provider scope after a vaultKey rebind', async () => {
    const { service, reconcile } = build();
    await service.updateProvider('gateway', { vaultKey: 'NEW_KEY' });
    await flush();

    expect(reconcile.calls).toEqual([{ config: null, options: { providerIds: ['gateway'] } }]);
  });

  it('does not reconcile when only display fields change', async () => {
    const { service, reconcile } = build();
    await service.updateProvider('gateway', { name: 'Gateway renamed' });
    await flush();

    expect(reconcile.calls).toEqual([]);
  });
});
