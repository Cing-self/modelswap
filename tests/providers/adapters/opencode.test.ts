import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';

const testRoot = vi.hoisted(() => {
  const p = require('path');
  const d = '/tmp/test-okit-opencode';
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
  updateUserConfig: vi.fn(async function(patch: any) { return patch; }),
}));

vi.mock('../../../src/vault/store', () => ({
  VaultStore: vi.fn().mockImplementation(function(this: any) {
    this.get = vi.fn(async function(key: string) { return key === 'TEST_API_KEY' ? 'sk-test-123' : undefined; });
  }),
}));

const { OpenCodeAdapter } = await import('../../../src/providers/adapters/opencode');
const { updateUserConfig } = await import('../../../src/config/user');

// OpenCode reads ~/.config/opencode/opencode.json (NOT ~/.opencode/config.json).
const CONFIG_PATH = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');

const openaiProvider = {
  id: 'deepseek',
  name: 'DeepSeek',
  type: 'openai' as const,
  baseUrl: 'https://api.deepseek.com/v1',
  vaultKey: 'TEST_API_KEY',
  authMode: 'api_key' as const,
  models: [{ id: 'deepseek-chat', name: 'DeepSeek V4' }],
};

const anthropicProvider = {
  id: 'zai',
  name: 'Z.AI',
  type: 'anthropic' as const,
  baseUrl: 'https://api.z.ai/api',
  vaultKey: 'TEST_API_KEY',
  authMode: 'api_key' as const,
  models: [{ id: 'glm-4.7' }],
};

beforeEach(() => {
  mocks.files.clear();
  vi.mocked(updateUserConfig).mockClear();
});

describe('OpenCodeAdapter', () => {
  it('has correct id and name', () => {
    const adapter = new OpenCodeAdapter();
    expect(adapter.id).toBe('opencode');
    expect(adapter.name).toBe('OpenCode');
  });

  it('supports anthropic/openai types', () => {
    const adapter = new OpenCodeAdapter();
    expect(adapter.supportedTypes).toEqual(['anthropic', 'openai']);
  });
});

describe('OpenCodeAdapter.applyConfig (cc-switch schema)', () => {
  it('writes provider as an object keyed by id under `provider`', async () => {
    const adapter = new OpenCodeAdapter();
    await adapter.applyConfig(openaiProvider, 'deepseek-chat');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(typeof written.provider).toBe('object');
    expect(written.provider.deepseek).toBeDefined();
  });

  it('writes npm package mapped from type (openai → @ai-sdk/openai-compatible)', async () => {
    const adapter = new OpenCodeAdapter();
    await adapter.applyConfig(openaiProvider, 'deepseek-chat');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(written.provider.deepseek.npm).toBe('@ai-sdk/openai-compatible');
  });

  it('writes npm @ai-sdk/anthropic for anthropic type', async () => {
    const adapter = new OpenCodeAdapter();
    await adapter.applyConfig(anthropicProvider, 'glm-4.7');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(written.provider.zai.npm).toBe('@ai-sdk/anthropic');
  });

  it('writes options.baseURL + options.apiKey', async () => {
    const adapter = new OpenCodeAdapter();
    await adapter.applyConfig(openaiProvider, 'deepseek-chat');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(written.provider.deepseek.options.baseURL).toBe('https://api.deepseek.com/v1');
    expect(written.provider.deepseek.options.apiKey).toBe('sk-test-123');
  });

  it('writes models as object keyed by model id', async () => {
    const adapter = new OpenCodeAdapter();
    await adapter.applyConfig(openaiProvider, 'deepseek-chat');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(written.provider.deepseek.models['deepseek-chat']).toEqual({ name: 'DeepSeek V4' });
  });

  it('adds opencode UA headers for opencode.ai gateway endpoints', async () => {
    const zenProvider = {
      ...openaiProvider,
      baseUrl: 'https://opencode.ai/zen/v1',
      models: [{ id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash' }],
    };
    const adapter = new OpenCodeAdapter();
    await adapter.applyConfig(zenProvider, 'deepseek-v4-flash-free');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(written.provider.deepseek.options.headers).toEqual({ 'User-Agent': 'opencode/1.18.15' });
  });

  it('writes explicit model limit for opencode.ai free models', async () => {
    const zenProvider = {
      ...openaiProvider,
      baseUrl: 'https://opencode.ai/zen/v1',
      models: [{ id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash' }],
    };
    const adapter = new OpenCodeAdapter();
    await adapter.applyConfig(zenProvider, 'deepseek-v4-flash-free');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(written.provider.deepseek.models['deepseek-v4-flash-free']).toEqual({
      name: 'DeepSeek V4 Flash',
      limit: { context: 200000, output: 128000 },
    });
  });

  it('writes openrouter :free model limits with no UA header', async () => {
    const orProvider = {
      ...openaiProvider,
      baseUrl: 'https://openrouter.ai/api/v1',
      models: [{ id: 'gpt-oss-20b:free' }, { id: 'cohere/north-mini-code:free' }],
    };
    const adapter = new OpenCodeAdapter();
    await adapter.applyConfig(orProvider, 'gpt-oss-20b:free');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(written.provider.deepseek.options.headers).toBeUndefined();
    expect(written.provider.deepseek.models['cohere/north-mini-code:free']).toEqual({
      name: 'cohere/north-mini-code:free',
      limit: { context: 256000, output: 8192 },
    });
  });

  it('does not add gateway headers or limits to non-gateway endpoints', async () => {
    const adapter = new OpenCodeAdapter();
    await adapter.applyConfig(openaiProvider, 'deepseek-chat');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(written.provider.deepseek.options.headers).toBeUndefined();
    expect(written.provider.deepseek.models['deepseek-chat']).toEqual({ name: 'DeepSeek V4' });
  });

  it('preserves existing providers (additive merge)', async () => {
    mocks.files.set(CONFIG_PATH, JSON.stringify({
      provider: { glm: { npm: '@ai-sdk/anthropic', options: {}, models: {} } },
    }));

    const adapter = new OpenCodeAdapter();
    await adapter.applyConfig(openaiProvider, 'deepseek-chat');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(Object.keys(written.provider)).toEqual(['glm', 'deepseek']);
  });

  it('records selection in user.json', async () => {
    const adapter = new OpenCodeAdapter();
    await adapter.applyConfig(openaiProvider, 'deepseek-chat');

    expect(updateUserConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: { opencode: { providerId: 'deepseek', modelId: 'deepseek-chat' } },
      }),
    );
  });
});

describe('OpenCodeAdapter additive interface', () => {
  it('applyModels writes provider entries without touching others', async () => {
    mocks.files.set(CONFIG_PATH, JSON.stringify({
      provider: { qianfan: { npm: '@ai-sdk/openai-compatible', options: {}, models: {} } },
    }));

    const adapter = new OpenCodeAdapter();
    const result = await adapter.applyModels([
      { provider: openaiProvider, modelId: 'deepseek-chat' },
      { provider: anthropicProvider, modelId: 'glm-4.7' },
    ]);

    expect(result.written).toEqual(['deepseek-chat', 'glm-4.7']);
    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(Object.keys(written.provider).sort()).toEqual(['deepseek', 'qianfan', 'zai']);
    expect(written.provider.deepseek.options.apiKey).toBe('sk-test-123');
  });

  it('listEnabledProviders returns provider keys from the config', async () => {
    mocks.files.set(CONFIG_PATH, JSON.stringify({
      provider: { deepseek: {}, qianfan: {} },
    }));
    const adapter = new OpenCodeAdapter();
    expect(await adapter.listEnabledProviders()).toEqual(['deepseek', 'qianfan']);
  });

  it('removeProvider deletes the entry and a model pointing at it', async () => {
    mocks.files.set(CONFIG_PATH, JSON.stringify({
      provider: { deepseek: {}, qianfan: {} },
      model: 'deepseek/deepseek-chat',
    }));
    const adapter = new OpenCodeAdapter();
    await adapter.removeProvider('deepseek');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(Object.keys(written.provider)).toEqual(['qianfan']);
    expect(written.model).toBeUndefined();
  });
});
