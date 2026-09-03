import { describe, expect, it, vi } from 'vitest';

const { createAgentConfigurationService } = require('../../src/application/agent-config-service.js');

describe('Agent configuration service dependencies', () => {
  it('keeps defaults when only a diagnostic dependency is overridden', () => {
    const log = vi.fn();
    const service = createAgentConfigurationService({ appendLog: log });
    expect(service.applySelection).toBeTypeOf('function');
    expect(service.reconcile).toBeTypeOf('function');
    expect(service.removeConfiguredSite).toBeTypeOf('function');
  });

  it('uses injected routing and resolution seams without losing service orchestration', () => {
    const service = createAgentConfigurationService({
      adapters: [{ id: 'fake', name: 'Fake', supportedTypes: ['openai'] }],
      resolveModel: vi.fn((provider: any, id: string) => ({ id, context: 1 })),
      resolveModelRoute: vi.fn((provider: any) => ({ provider, remoteModelId: 'wire-id', endpointId: 'e' })),
    });
    const write = service.prepareWrite({ id: 'p', type: 'openai', models: [{ id: 'canonical' }] }, 'fake', 'canonical', ['canonical'], {});
    expect(write.route.remoteModelId).toBe('wire-id');
    expect(write.resolved.id).toBe('canonical');
  });
});

describe('reconcileVaultKey', () => {
  function build(overrides: Record<string, unknown> = {}) {
    const siteA: any = { id: 'site-a', name: 'Site A', vaultKey: 'SITE_A_KEY', type: 'openai', models: [{ id: 'm1' }] };
    const siteB: any = { id: 'site-b', name: 'Site B', vaultKey: 'SITE_B_KEY', type: 'openai', models: [{ id: 'm2' }] };
    const applyModels = vi.fn(async (entries: any[]) => ({ written: entries.map(entry => entry.modelId), skipped: [] }));
    const zcode = { id: 'zcode', name: 'ZCode', supportedTypes: ['openai'], applyModels, removeProvider: vi.fn(async () => {}) };
    const codex = { id: 'codex', name: 'Codex', supportedTypes: ['openai'], applyConfig: vi.fn(async () => {}) };
    const service = createAgentConfigurationService({
      adapters: [zcode, codex],
      getAdapter: (id: string) => (id === 'zcode' ? zcode : codex),
      loadProviders: async () => [siteA, siteB],
      loadUserConfig: async () => ({
        agentProviders: {
          // additive: both sites enabled, only site-a binds the rotated key
          zcode: { sites: { 'site-a': { modelIds: ['m1'], enabled: true }, 'site-b': { modelIds: ['m2'], enabled: true } } },
          // non-additive: active site is site-b — out of scope for SITE_A_KEY
          codex: { activeProviderId: 'site-b', activeModelId: 'm2', sites: { 'site-b': { modelIds: ['m2'] } } },
        },
      }),
      resolveModelRoute: (provider: any, modelId: string) => ({ provider, remoteModelId: modelId, endpointId: 'endpoint' }),
      providerSupportsAdapter: () => true,
      resolveModel: (_provider: any, id: string) => ({ id }),
      authorize: async () => ({ ok: true }),
      captureSnapshot: async () => null,
      replaceAgentState: vi.fn(async () => ({})),
      persistReconciledDesired: vi.fn(async () => ({})),
      appendLog: vi.fn(),
      ...overrides,
    });
    return { service, zcode, codex, applyModels };
  }

  it('re-applies only the enabled sites bound to the rotated key', async () => {
    const { service, applyModels } = build();
    const outcome = await service.reconcileVaultKey({ vaultKey: 'SITE_A_KEY' });

    expect(outcome.providerIds).toEqual(['site-a']);
    expect(outcome.updated).toBe(1);
    expect(applyModels).toHaveBeenCalledTimes(1);
    const entries = applyModels.mock.calls[0][0] as any[];
    expect(entries.map(entry => entry.provider.id)).toEqual(['site-a']);
    expect(entries.map(entry => entry.modelId)).toEqual(['m1']);
  });

  it('reports nothing when no provider binds the key', async () => {
    const { service, applyModels } = build();
    const outcome = await service.reconcileVaultKey({ vaultKey: 'NOT_BOUND' });

    expect(outcome).toMatchObject({ providerIds: [], results: [], updated: 0 });
    expect(applyModels).not.toHaveBeenCalled();
  });

  it('keeps a failing agent write non-fatal and reported per site', async () => {
    const { service, applyModels } = build({
      getAdapter: () => ({ id: 'zcode', name: 'ZCode', supportedTypes: ['openai'], applyModels: async () => { throw new Error('write failed'); }, removeProvider: vi.fn(async () => {}) }),
      adapters: [{ id: 'zcode', name: 'ZCode', supportedTypes: ['openai'] }],
    });
    const outcome = await service.reconcileVaultKey({ vaultKey: 'SITE_A_KEY' });

    expect(outcome.updated).toBe(0);
    expect(outcome.results).toEqual([expect.objectContaining({ agentId: 'zcode', providerId: 'site-a', success: false, error: 'write failed' })]);
    expect(applyModels).not.toHaveBeenCalled();
  });

  it('accepts a providerIds scope on the generic reconcile', async () => {
    const { service, applyModels } = build();
    const results = await service.reconcile(undefined as any, { providerIds: ['site-b'] });

    // Only zcode's enabled site-b re-applies; codex's active site-b follows the
    // non-additive path via applyConfig.
    expect(applyModels).toHaveBeenCalledTimes(1);
    expect(results.map((result: any) => `${result.agentId}:${result.providerId}`).sort())
      .toEqual(['codex:site-b', 'zcode:site-b'].sort().reverse().sort());
  });
});
