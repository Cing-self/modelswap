import { describe, expect, it } from 'vitest';
import {
  filterModelEntries,
  normalizeEndpoint,
  providerPlans,
  providerProtocols,
  runtimeAuthReady,
} from '../src/web/frontend/src/components/models/modelsCatalog';

describe('models catalog filters', () => {
  it('keeps native providers out of HTTP protocol filters', () => {
    expect(providerProtocols({
      id: 'native',
      name: 'Native',
      type: 'openai',
      baseUrl: '',
      authMode: 'none',
      executionMode: 'agent_native',
      models: [],
    })).toEqual([]);
  });

  it('derives plans from endpoints without mutating a default API provider', () => {
    const coding = {
      id: 'custom-coding', name: 'Coding', type: 'openai', baseUrl: 'https://example.test', authMode: 'api_key', models: [],
      endpoints: [{ type: 'openai', baseUrl: 'https://example.test', plan: 'coding' }],
    } as any;
    const apiOnly = { ...coding, id: 'custom-api', endpoints: [] };

    expect(providerPlans(coding)).toEqual(['coding']);
    expect(providerPlans(apiOnly)).toEqual(['api-only']);
  });

  it('filters model catalog entries by the selected HTTP protocol without mutating the catalog', () => {
    const providers = [
      { id: 'chat', name: 'Chat', type: 'openai', baseUrl: 'https://chat.test', authMode: 'api_key', models: [] },
      { id: 'responses', name: 'Responses', type: 'openai', baseUrl: 'https://responses.test', authMode: 'api_key', models: [], endpoints: [{ type: 'openai', baseUrl: 'https://responses.test', protocol: 'responses' }] },
    ] as any;
    const entries: [string, any[]][] = [
      ['chat-model', [{ platform: 'chat' }]],
      ['responses-model', [{ platform: 'responses' }]],
    ];

    expect(filterModelEntries(entries, {
      hideLegacy: false,
      activeProtocol: 'openai-responses',
      searchQuery: '',
      providers,
    })).toEqual([['responses-model', [{ platform: 'responses' }]]]);
    expect(entries).toHaveLength(2);
  });

  it('shares endpoint normalization and auth readiness semantics across model views', () => {
    expect(normalizeEndpoint({ type: 'openai', baseUrl: 'https://api.test' })).toEqual({
      type: 'openai', baseUrl: 'https://api.test', protocol: 'chat',
    });
    expect(normalizeEndpoint({ type: 'anthropic', baseUrl: 'https://api.test', protocol: 'responses' })).toEqual({
      type: 'anthropic', baseUrl: 'https://api.test',
    });

    const provider = { id: 'test', name: 'Test', type: 'openai', baseUrl: 'https://api.test', authMode: 'api_key', vaultKey: 'TEST_KEY', models: [] } as any;
    expect(runtimeAuthReady(provider, { hasApiKey: true, authVerified: true, oauthLoggedIn: null, authMode: 'api_key' })).toBe(true);
    expect(runtimeAuthReady(provider, { hasApiKey: true, authVerified: false, oauthLoggedIn: null, authMode: 'api_key' })).toBe(false);
  });
});
