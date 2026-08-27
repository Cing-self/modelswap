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
