import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { resolveModel, resolveModelRoute } from '../../../src/providers/routing';

const testRoot = vi.hoisted(() => {
  const p = require('path');
  const d = '/tmp/test-okit-hermes';
  return {
    OKIT_DIR: d,
    REGISTRY_PATH: p.join(d, 'registry.json'),
    LOGS_DIR: p.join(d, 'logs'),
    CACHE_DIR: p.join(d, 'cache'),
  };
});

const mocks = vi.hoisted(() => {
  const files = new Map<string, string>();
  return {
    files,
    pathExists: vi.fn(async function(p: string) { return files.has(p); }),
    readFile: vi.fn(async function(p: string) { return files.get(p) ?? ''; }),
    writeFile: vi.fn(async function(p: string, c: string) { files.set(p, c); }),
    rename: vi.fn(async function(oldPath: string, newPath: string) { const c = files.get(oldPath); if (c !== undefined) files.set(newPath, c); }),
    ensureDir: vi.fn(async function() {}),
  };
});

vi.mock('fs-extra', () => ({ default: mocks }));

vi.mock('../../../src/config/registry', () => ({
  OKIT_DIR: testRoot.OKIT_DIR,
  REGISTRY_PATH: testRoot.REGISTRY_PATH,
  LOGS_DIR: testRoot.LOGS_DIR,
  CACHE_DIR: testRoot.CACHE_DIR,
}));

vi.mock('../../../src/config/user', () => ({
  loadUserConfig: vi.fn(async function() { return {}; }),
  patchAgentSelection: vi.fn(async function(_agentId: string, patch: any) { return patch; }),
}));

vi.mock('../../../src/vault/store', () => ({
  VaultStore: vi.fn().mockImplementation(function(this: any) {
    this.get = vi.fn(async function(key: string) { return key === 'TEST_API_KEY' ? 'sk-test-123' : undefined; });
  }),
}));

const { HermesAdapter } = await import('../../../src/providers/adapters/hermes');
const { patchAgentSelection } = await import('../../../src/config/user');

// Hermes keeps everything in ~/.hermes/config.yaml (never config.json).
const CONFIG_PATH = path.join(os.homedir(), '.hermes', 'config.yaml');

const testProvider = {
  id: 'deepseek',
  name: 'DeepSeek',
  type: 'openai' as const,
  baseUrl: 'https://api.deepseek.com',
  vaultKey: 'TEST_API_KEY',
  authMode: 'api_key' as const,
  models: [{ id: 'deepseek-chat', name: 'DeepSeek V4' }],
};

function readWritten(): Record<string, any> {
  const raw = mocks.files.get(CONFIG_PATH)!;
  return (yaml.load(raw) as Record<string, any>) || {};
}

beforeEach(() => {
  mocks.files.clear();
  vi.mocked(patchAgentSelection).mockClear();
});

describe('HermesAdapter', () => {
  it('has correct id and name', () => {
    const adapter = new HermesAdapter();
    expect(adapter.id).toBe('hermes');
    expect(adapter.name).toBe('Hermes');
  });

  it('supports anthropic/openai types', () => {
    const adapter = new HermesAdapter();
    expect(adapter.supportedTypes).toEqual(['anthropic', 'openai']);
  });
});

describe('HermesAdapter.applyConfig (config.yaml schema)', () => {
  it('writes the routed remote ID while retaining canonical context/output/vision facts', async () => {
    const provider: any = {
      ...testProvider,
      endpoints: [{ id: 'gateway:openai', type: 'openai', baseUrl: testProvider.baseUrl }],
      models: [{
        id: 'canonical-model', name: 'Canonical Model',
        meta: { source: 'modelsdev', context: 131072, output: 4096, modalities: { input: ['text', 'image'], output: ['text'] } },
        availability: [{ executionMode: 'http_endpoint', endpointId: 'gateway:openai', remoteModelId: 'remote-model-v2', status: 'available', source: 'remote' }],
      }],
    };
    const adapter = new HermesAdapter();
    const route = resolveModelRoute(provider, 'canonical-model', adapter);
    await adapter.applyConfig(route.provider, route.remoteModelId, resolveModel(provider, 'canonical-model'));

    const written = readWritten();
    expect(written.providers.deepseek).toMatchObject({ default_model: 'remote-model-v2' });
    expect(written.providers.deepseek.models).toEqual({
      'remote-model-v2': { context_length: 131072, supports_vision: true },
    });
    expect(written.model).toMatchObject({
      default: 'remote-model-v2', context_length: 131072, max_tokens: 4096, supports_vision: true,
    });
  });

  it('writes the current named-provider format with api, api_key, transport and default_model', async () => {
    const adapter = new HermesAdapter();
    await adapter.applyConfig(testProvider, 'deepseek-chat');

    const written = readWritten();
    const entry = written.providers.deepseek;
    expect(entry).toMatchObject({
      api: 'https://api.deepseek.com',
      api_key: 'sk-test-123',
      transport: 'chat_completions',
      default_model: 'deepseek-chat',
    });
  });

  it('maps anthropic type to api_mode anthropic_messages', async () => {
    const anthropicProvider = { ...testProvider, id: 'zai', name: 'ZAI', type: 'anthropic' as const };
    const adapter = new HermesAdapter();
    await adapter.applyConfig(anthropicProvider, 'glm-4.7');

    const entry = readWritten().providers.zai;
    expect(entry.transport).toBe('anthropic_messages');
  });

  it('adds opencode UA via extra_headers for opencode.ai gateway endpoints', async () => {
    const zenProvider = { ...testProvider, baseUrl: 'https://opencode.ai/zen/v1' };
    const adapter = new HermesAdapter();
    await adapter.applyConfig(zenProvider, 'deepseek-chat');

    const entry = readWritten().providers.deepseek;
    expect(entry.extra_headers).toEqual({ 'User-Agent': 'opencode/1.18.15' });
  });

  it('does not add extra_headers for non-opencode endpoints', async () => {
    const adapter = new HermesAdapter();
    await adapter.applyConfig(testProvider, 'deepseek-chat');

    const entry = readWritten().providers.deepseek;
    expect(entry.extra_headers).toBeUndefined();
  });

  it('maps resolved context/output/vision only to Hermes-supported fields', async () => {
    const adapter = new HermesAdapter();
    await adapter.applyConfig(testProvider, 'ignored-id', {
      id: 'resolved-model', name: 'Resolved Model', context: 131072, output: 4096,
      modalities: { input: ['text', 'image'], output: ['text'] }, reasoning: true,
      reasoningOptions: [{ type: 'effort', values: ['high'] }], source: 'remote', confidence: 'high',
    });

    const written = readWritten();
    expect(written.providers.deepseek.models).toEqual({
      'ignored-id': { context_length: 131072, supports_vision: true },
    });
    expect(written.model).toMatchObject({
      default: 'ignored-id', provider: 'custom:deepseek', context_length: 131072,
      max_tokens: 4096, supports_vision: true,
    });
    expect(written.model).not.toHaveProperty('reasoning');
  });

  it('sets model.default to the resolved model and selects its named provider', async () => {
    const adapter = new HermesAdapter();
    await adapter.applyConfig(testProvider, 'deepseek-chat');

    expect(readWritten().model).toMatchObject({ default: 'deepseek-chat', provider: 'custom:deepseek' });
  });

  it('routes traffic through the named custom provider', async () => {
    const adapter = new HermesAdapter();
    await adapter.applyConfig(testProvider, 'deepseek-chat');

    expect(readWritten().model).toMatchObject({
      provider: 'custom:deepseek',
    });
    expect(readWritten().providers.deepseek).toMatchObject({ api: 'https://api.deepseek.com', api_key: 'sk-test-123' });
  });

  it('keeps transport on the provider block, not on the model block', async () => {
    const adapter = new HermesAdapter();
    await adapter.applyConfig(testProvider, 'deepseek-chat');
    expect(readWritten().model.transport).toBeUndefined();

    const anthropicProvider = { ...testProvider, id: 'zai', name: 'ZAI', type: 'anthropic' as const };
    await adapter.applyConfig(anthropicProvider, 'glm-4.7');
    expect(readWritten().providers.zai).toMatchObject({ transport: 'anthropic_messages' });
  });

  it('replaces its own named entry and preserves other providers + unrelated config', async () => {
    mocks.files.set(CONFIG_PATH, yaml.dump({
      providers: {
        user: { api: 'https://user.example', api_key: 'sk-user' },
        deepseek: { api: 'https://old.deepseek.com', api_key: 'sk-old' },
      },
      model: { default: 'foo' },
      memory: { enabled: true },
    }));

    const adapter = new HermesAdapter();
    await adapter.applyConfig(testProvider, 'deepseek-chat');

    const written = readWritten();
    expect(Object.keys(written.providers)).toEqual(['user', 'deepseek']);
    expect(written.providers.user).toMatchObject({ api: 'https://user.example' });
    expect(written.providers.deepseek.api).toBe('https://api.deepseek.com');
    expect(written.memory).toEqual({ enabled: true });
    expect(written.model.default).toBe('deepseek-chat');
  });

  it('records selection in user.json', async () => {
    const adapter = new HermesAdapter();
    await adapter.applyConfig(testProvider, 'deepseek-chat');

    expect(patchAgentSelection).toHaveBeenCalledWith(
      'hermes',
      expect.objectContaining({
            activeProviderId: 'deepseek', activeModelId: 'deepseek-chat',
            sites: { deepseek: { modelIds: ['deepseek-chat'] } },
      }),
    );
  });
});
