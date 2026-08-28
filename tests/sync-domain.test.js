import { describe, expect, it } from 'vitest';

const {
  mergeAgentProviderSelections,
  mergeModelOverrides,
  shouldApplyRemoteSection,
} = await import('../src/application/sync-config-state.js');
const { desiredAgentSites } = await import(
  '../src/application/sync-agent-reconciliation.js'
);
const { createSyncService } = await import('../src/application/sync-service.js');
const { stripRebuildableProviderData } = await import(
  '../src/infrastructure/sync-provider-sites.js'
);

describe('sync domain conflict rules', () => {
  it('deep-merges user-owned selection and override partitions', () => {
    expect(
      mergeAgentProviderSelections(
        { codex: { activeProviderId: 'a', sites: { a: { modelIds: ['one'] } } } },
        { codex: { sites: { b: { modelIds: ['two'] } } } },
      ),
    ).toEqual({
      codex: {
        activeProviderId: 'a',
        sites: { a: { modelIds: ['one'] }, b: { modelIds: ['two'] } },
      },
    });
    expect(
      mergeModelOverrides(
        { provider: { one: { context: 1000, output: 100 } } },
        { provider: { one: { output: 200 }, two: { reasoning: true } } },
      ),
    ).toEqual({
      provider: {
        one: { context: 1000, output: 200 },
        two: { reasoning: true },
      },
    });
  });

  it('only accepts a strictly newer remote partition', () => {
    expect(shouldApplyRemoteSection('2026-08-28T10:01:00.000Z', '2026-08-28T10:00:00.000Z')).toBe(true);
    expect(shouldApplyRemoteSection('2026-08-28T10:00:00.000Z', '2026-08-28T10:00:00.000Z')).toBe(false);
    expect(shouldApplyRemoteSection('2026-08-28T09:59:00.000Z', '2026-08-28T10:00:00.000Z')).toBe(false);
  });

  it('keeps a per-agent/per-site desired-state diagnostic target', () => {
    expect(
      desiredAgentSites({
        agentProviders: {
          codex: {
            activeProviderId: 'open',
            sites: { open: { modelIds: ['one'] }, backup: { modelIds: ['two'] } },
          },
          claude: { activeProviderId: 'anthropic', sites: { anthropic: {} } },
        },
      }),
    ).toEqual([
      { agentId: 'codex', providerId: 'open' },
      { agentId: 'codex', providerId: 'backup' },
      { agentId: 'claude', providerId: 'anthropic' },
    ]);
  });

  it('projects only portable provider sites into a sync payload', () => {
    expect(
      stripRebuildableProviderData({
        providers: [
          {
            id: 'remote',
            name: 'Remote',
            models: [{ id: 'local-model' }],
            modelCache: { fetchedAt: 'now' },
            platforms: [{ id: 'legacy-projection' }],
            vaultKey: 'REMOTE_API_KEY',
          },
        ],
      }),
    ).toEqual([
      { id: 'remote', name: 'Remote', vaultKey: 'REMOTE_API_KEY' },
    ]);
  });
});

describe('sync pull orchestration', () => {
  it('merges sites and persists desired state before local model hydration and agent reconciliation', async () => {
    const order = [];
    const config = {
      sync: { localChangedAt: {} },
      agentProviders: {},
      modelOverrides: {},
    };
    const remote = {
      updatedAt: '2026-08-28T10:00:00.000Z',
      machineId: 'machine-a',
      secrets: [{ key: 'SYNC_KEY', value: 'value', group: 'AI' }],
      settings: {
        providers: [{ id: 'remote-site' }],
        agentProviders: { codex: { activeProviderId: 'remote-site', sites: { 'remote-site': { modelIds: ['m'] } } } },
        modelOverrides: { 'remote-site': { m: { context: 42 } } },
      },
    };
    const service = createSyncService({
      appendLog: () => {},
      collectPlatformVaultSecrets: async () => [],
      decryptPayload: () => remote,
      decryptSyncCodePayload: () => ({}),
      encryptPayload: () => ({}),
      encryptSyncCodePayload: () => '',
      getVaultStore: () => ({
        exportAll: async () => [],
        set: async () => order.push('vault'),
      }),
      hydratePulledAgentModels: async (persistedConfig) => {
        expect(persistedConfig.agentProviders.codex.activeProviderId).toBe('remote-site');
        order.push('hydrate');
        return { warmed: ['remote-site'], pending: ['remote-site'], results: [] };
      },
      listEnabledSyncTargets: async () => ({
        targets: [{ id: 'memory', resolvedConfig: {} }],
        userId: 'u',
        encryptionKey: Buffer.alloc(32),
      }),
      loadAdapter: () => ({ pullSync: async () => ({}) }),
      loadConfig: async () => config,
      loadProviderSites: async () => [],
      mergeRemoteProviderSites: async () => {
        order.push('providers');
        return 1;
      },
      publishDataChanged: () => {},
      reconcilePulledAgentProviders: async () => {
        order.push('agent');
        return [];
      },
      resolvePrimaryTarget: async () => ({ id: 'memory' }),
      saveConfig: async () => order.push('config'),
      shouldApplyRemoteSection,
    });

    const result = await service.syncPull();
    expect(order).toEqual(['providers', 'vault', 'config', 'hydrate', 'agent']);
    expect(result.agentModelHydration).toMatchObject({ warmed: ['remote-site'] });
  });
});
