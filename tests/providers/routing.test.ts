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

  it('falls back to the adapter-supported endpoint when records only exist on another protocol endpoint', () => {
    // deepseek-style vendor: discovery can only observe the OpenAI-compatible
    // side (the anthropic endpoint exposes no /models), yet the provider
    // legitimately mirrors its catalog on the dual-protocol endpoint.
    const provider: Provider = {
      id: 'deepseek',
      name: 'DeepSeek',
      type: 'openai',
      baseUrl: 'https://api.deepseek.com',
      endpoints: [
        { id: 'deepseek:openai', type: 'openai', baseUrl: 'https://api.deepseek.com' },
        { id: 'deepseek:anthropic', type: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic' },
      ],
      authMode: 'api_key',
      models: [{
        id: 'deepseek-v4-flash',
        availability: [{
          executionMode: 'http_endpoint',
          endpointId: 'deepseek:openai',
          remoteModelId: 'deepseek-v4-flash',
          status: 'available',
          source: 'remote',
        }],
      }],
    };
    const claude = { id: 'claude', supportedTypes: ['anthropic'] };

    const route = resolveModelRoute(provider, 'deepseek-v4-flash', claude as any);
    expect(route.endpointId).toBe('deepseek:anthropic');
    expect(route.remoteModelId).toBe('deepseek-v4-flash');
  });

  it('keeps strict matching while any record sits on an adapter-usable endpoint', () => {
    // Same-protocol multi-endpoint providers stay strict: a model observed on
    // one openai endpoint must not silently resolve to another openai endpoint.
    const provider: Provider = {
      id: 'gateway',
      name: 'Gateway',
      type: 'openai',
      baseUrl: 'https://one.example/v1',
      endpoints: [
        { id: 'gateway:one', type: 'openai', baseUrl: 'https://one.example/v1' },
        { id: 'gateway:two', type: 'openai', baseUrl: 'https://two.example/v1' },
      ],
      authMode: 'api_key',
      models: [{
        id: 'one-only',
        availability: [{
          executionMode: 'http_endpoint',
          endpointId: 'gateway:one',
          remoteModelId: 'one-only',
          status: 'available',
          source: 'remote',
        }],
      }],
    };
    const { opencode } = { opencode: { id: 'opencode', supportedTypes: ['anthropic', 'openai'] } };

    const route = resolveModelRoute(provider, 'one-only', opencode as any);
    expect(route.endpointId).toBe('gateway:one');
  });
});
