import { describe, expect, it } from 'vitest';
import { buildPlatforms } from '../../src/providers/platforms';
import { providerEndpointEntries, providerSupportsAdapter, resolveModelRoute } from '../../src/providers/routing';
import type { Provider } from '../../src/providers/types';

const codex = { id: 'codex', supportedTypes: ['openai'] as const };
const claude = { id: 'claude', supportedTypes: ['anthropic'] as const };
const opencode = { id: 'opencode', supportedTypes: ['openai', 'anthropic'] as const };

describe('provider routing', () => {
  it('keeps an agent-native subscription endpoint-free and restricted to its native agent', () => {
    const provider: Provider = {
      id: 'openai-codex',
      name: 'ChatGPT',
      type: 'openai',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      authMode: 'oauth',
      executionMode: 'agent_native',
      nativeAgentIds: ['codex'],
      models: [{ id: 'gpt-5.4' }],
    };

    expect(providerEndpointEntries(provider)).toEqual([]);
    expect(providerSupportsAdapter(provider, codex as any)).toBe(true);
    expect(providerSupportsAdapter(provider, opencode as any)).toBe(false);

    const platform = buildPlatforms([provider], [])[0];
    expect(platform.endpoints).toEqual([]);
    expect(platform.offerings[0]).toMatchObject({ executionMode: 'agent_native', endpointIds: [] });
    expect(platform.models[0].availability[0]).toMatchObject({
      executionMode: 'agent_native',
      endpointIds: [],
      remoteModelId: 'gpt-5.4',
    });
  });

  it('does not infer agent-native execution from OAuth alone', () => {
    const provider: Provider = {
      id: 'custom-oauth-api',
      name: 'Custom OAuth API',
      type: 'openai',
      baseUrl: 'https://api.example/v1',
      authMode: 'oauth',
      models: [{ id: 'model-one' }],
    };

    expect(providerEndpointEntries(provider)).toHaveLength(1);
    expect(providerSupportsAdapter(provider, codex as any)).toBe(true);
  });

  it('does not claim a legacy multi-endpoint model is available on every endpoint', () => {
    const provider: Provider = {
      id: 'gateway',
      name: 'Gateway',
      type: 'openai',
      baseUrl: 'https://gateway.example/v1',
      endpoints: [
        { id: 'gateway:openai', type: 'openai', baseUrl: 'https://gateway.example/v1' },
        { id: 'gateway:anthropic', type: 'anthropic', baseUrl: 'https://gateway.example/anthropic' },
      ],
      authMode: 'api_key',
      models: [{ id: 'shared-model' }],
    };

    const availability = buildPlatforms([provider], [])[0].models[0].availability[0];
    expect(availability.endpointIds).toEqual([]);
    expect(availability.source).toBe('legacy_unknown');
    expect(availability.status).toBe('unknown');
  });

  it('keeps generated endpoint IDs stable when endpoints are reordered', () => {
    const provider: Provider = {
      id: 'gateway',
      name: 'Gateway',
      type: 'openai',
      baseUrl: 'https://gateway.example/v1',
      endpoints: [
        { type: 'openai', baseUrl: 'https://gateway.example/v1' },
        { type: 'anthropic', baseUrl: 'https://gateway.example/anthropic' },
      ],
      authMode: 'api_key',
      models: [],
    };

    const original = providerEndpointEntries(provider).map(entry => [entry.endpoint.type, entry.id]);
    const reordered = providerEndpointEntries({ ...provider, endpoints: [...provider.endpoints!].reverse() })
      .map(entry => [entry.endpoint.type, entry.id]);
    expect(new Map(reordered)).toEqual(new Map(original));
  });

  it('routes a model through its recorded source endpoint', () => {
    const provider: Provider = {
      id: 'gateway',
      name: 'Gateway',
      type: 'openai',
      baseUrl: 'https://gateway.example/v1',
      endpoints: [
        { id: 'gateway:openai', type: 'openai', baseUrl: 'https://gateway.example/v1' },
        { id: 'gateway:anthropic', type: 'anthropic', baseUrl: 'https://gateway.example/anthropic' },
      ],
      authMode: 'api_key',
      models: [{
        id: 'canonical-model',
        availability: [{
          executionMode: 'http_endpoint',
          endpointId: 'gateway:anthropic',
          remoteModelId: 'remote-model-v2',
          status: 'available',
          source: 'remote',
        }],
      }],
    };

    const route = resolveModelRoute(provider, 'canonical-model', claude as any);
    expect(route.endpointId).toBe('gateway:anthropic');
    expect(route.remoteModelId).toBe('remote-model-v2');
    expect(route.provider).toMatchObject({
      type: 'anthropic',
      baseUrl: 'https://gateway.example/anthropic',
    });
    expect(route.provider.endpoints).toEqual([
      { id: 'gateway:anthropic', type: 'anthropic', baseUrl: 'https://gateway.example/anthropic' },
    ]);
  });

  it('never falls back to an endpoint where a sourced model was not observed', () => {
    const provider: Provider = {
      id: 'gateway',
      name: 'Gateway',
      type: 'openai',
      baseUrl: 'https://gateway.example/v1',
      endpoints: [
        { id: 'gateway:openai', type: 'openai', baseUrl: 'https://gateway.example/v1' },
        { id: 'gateway:anthropic', type: 'anthropic', baseUrl: 'https://gateway.example/anthropic' },
      ],
      authMode: 'api_key',
      models: [{
        id: 'anthropic-only',
        availability: [{
          executionMode: 'http_endpoint',
          endpointId: 'gateway:anthropic',
          remoteModelId: 'anthropic-only',
          status: 'available',
          source: 'remote',
        }],
      }],
    };

    expect(() => resolveModelRoute(provider, 'anthropic-only', codex as any))
      .toThrow('没有适用于 codex 的模型来源端点');
  });
});
