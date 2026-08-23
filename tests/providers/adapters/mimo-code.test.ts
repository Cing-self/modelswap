import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';

const testRoot = vi.hoisted(() => {
  const p = require('path');
  const d = '/tmp/test-okit-mimo-code';
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

const { MimoCodeAdapter } = await import('../../../src/providers/adapters/mimo-code');
const { updateUserConfig } = await import('../../../src/config/user');

const CONFIG_PATH = path.join(os.homedir(), '.config', 'mimocode', 'mimocode.jsonc');

const openAIProvider = {
  id: 'custom-openai',
  name: 'Custom OpenAI',
  type: 'openai' as const,
  baseUrl: 'https://custom.api.com/v1',
  vaultKey: 'TEST_API_KEY',
  authMode: 'api_key' as const,
  models: [{ id: 'my-model' }, { id: 'other-model' }],
};

const anthropicProvider = {
  id: 'custom-anthropic',
  name: 'Custom Anthropic',
  type: 'anthropic' as const,
  baseUrl: 'https://custom.anthropic.com',
  vaultKey: 'TEST_API_KEY',
  authMode: 'api_key' as const,
  models: [{ id: 'claude-model' }],
};

beforeEach(() => {
  mocks.files.clear();
  vi.mocked(updateUserConfig).mockClear();
});

describe('MimoCodeAdapter', () => {
  it('has correct id and name', () => {
    const adapter = new MimoCodeAdapter();
    expect(adapter.id).toBe('mimo-code');
    expect(adapter.name).toBe('MiMo Code');
  });

  it('writes the provider map with apiKey and sets the active model', async () => {
    const adapter = new MimoCodeAdapter();
    await adapter.applyConfig(openAIProvider, 'my-model');

    const data = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(data.model).toBe('custom-openai/my-model');
    expect(data.provider['custom-openai'].npm).toBe('@ai-sdk/openai-compatible');
    expect(data.provider['custom-openai'].options.baseURL).toBe('https://custom.api.com/v1');
    expect(data.provider['custom-openai'].options.apiKey).toBe('sk-test-123');
    expect(data.provider['custom-openai'].only_configured_models).toBe(true);
    expect(data.provider['custom-openai'].models['my-model']).toEqual({ name: 'my-model' });
    expect(data.provider['custom-openai'].models['other-model']).toEqual({ name: 'other-model' });
  });

  it('maps anthropic providers to the anthropic npm package', async () => {
    const adapter = new MimoCodeAdapter();
    await adapter.applyConfig(anthropicProvider, 'claude-model');

    const data = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(data.provider['custom-anthropic'].npm).toBe('@ai-sdk/anthropic');
  });

  it('adds opencode UA headers and model limits for opencode.ai gateway endpoints', async () => {
    const zenProvider = {
      ...openAIProvider,
      baseUrl: 'https://opencode.ai/zen/v1',
      models: [{ id: 'deepseek-v4-flash-free' }, { id: 'hy3-free' }],
    };
    const adapter = new MimoCodeAdapter();
    await adapter.applyConfig(zenProvider, 'deepseek-v4-flash-free');

    const data = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(data.provider['custom-openai'].options.headers).toEqual({ 'User-Agent': 'opencode/1.18.15' });
    expect(data.provider['custom-openai'].models['deepseek-v4-flash-free']).toEqual({
      name: 'deepseek-v4-flash-free',
      limit: { context: 200000, output: 128000 },
    });
  });

  it('writes openrouter :free model limits without UA headers', async () => {
    const orProvider = {
      ...openAIProvider,
      baseUrl: 'https://openrouter.ai/api/v1',
      models: [{ id: 'poolside/laguna-s-2.1:free' }],
    };
    const adapter = new MimoCodeAdapter();
    await adapter.applyConfig(orProvider, 'poolside/laguna-s-2.1:free');

    const data = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(data.provider['custom-openai'].options.headers).toBeUndefined();
    expect(data.provider['custom-openai'].models['poolside/laguna-s-2.1:free']).toEqual({
      name: 'poolside/laguna-s-2.1:free',
      limit: { context: 262144, output: 8192 },
    });
  });

  it('applyModels writes gateway headers and limits too', async () => {
    const zenProvider = {
      ...openAIProvider,
      baseUrl: 'https://opencode.ai/zen/v1',
      models: [{ id: 'mimo-v2.5-free' }],
    };
    const adapter = new MimoCodeAdapter();
    await adapter.applyModels([{ provider: zenProvider, modelId: 'mimo-v2.5-free' }]);

    const data = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(data.provider['custom-openai'].options.headers).toEqual({ 'User-Agent': 'opencode/1.18.15' });
    expect(data.provider['custom-openai'].models['mimo-v2.5-free']).toEqual({
      name: 'mimo-v2.5-free',
      limit: { context: 200000, output: 128000 },
    });
  });

  it('parses JSONC files with comments and trailing commas', async () => {
    mocks.files.set(CONFIG_PATH, [
      '{',
      '  // my comment',
      '  "$schema": "https://mimo.xiaomi.com/mimocode/config.json",',
      '  "provider": {',
      '    "existing": {',
      '      "npm": "@ai-sdk/openai-compatible",',
      '      "options": { "baseURL": "https://old.example.com", "apiKey": "sk-old" },',
      '    },',
      '  },',
      '}',
    ].join('\n'));

    const adapter = new MimoCodeAdapter();
    await adapter.applyConfig(openAIProvider, 'my-model');

    const data = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(data.provider['existing']).toBeDefined();
    expect(data.provider['existing'].options.baseURL).toBe('https://old.example.com');
    expect(data.provider['custom-openai']).toBeDefined();
    expect(data.model).toBe('custom-openai/my-model');
  });

  it('applyModels is additive and does not touch the active model', async () => {
    mocks.files.set(CONFIG_PATH, JSON.stringify({
      model: 'existing/some-model',
      provider: {
        existing: {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'https://old.example.com' },
        },
      },
    }));

    const adapter = new MimoCodeAdapter();
    const { written } = await adapter.applyModels([{ provider: openAIProvider, modelId: 'my-model' }]);

    expect(written).toEqual(['my-model']);
    const data = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(data.model).toBe('existing/some-model');
    expect(data.provider['existing']).toBeDefined();
    expect(data.provider['custom-openai']).toBeDefined();
  });

  it('lists enabled providers', async () => {
    mocks.files.set(CONFIG_PATH, JSON.stringify({
      model: 'custom-openai/my-model',
      provider: {
        'custom-openai': { npm: '@ai-sdk/openai-compatible', options: {} },
        'custom-anthropic': { npm: '@ai-sdk/anthropic', options: {} },
      },
    }));

    const adapter = new MimoCodeAdapter();
    expect(await adapter.listEnabledProviders()).toEqual(['custom-openai', 'custom-anthropic']);
  });

  it('removeProvider deletes the entry and clears the active model it owned', async () => {
    mocks.files.set(CONFIG_PATH, JSON.stringify({
      model: 'custom-openai/my-model',
      provider: {
        'custom-openai': { npm: '@ai-sdk/openai-compatible', options: {} },
        other: { npm: '@ai-sdk/openai-compatible', options: {} },
      },
    }));

    const adapter = new MimoCodeAdapter();
    await adapter.removeProvider('custom-openai');

    const data = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(data.provider['custom-openai']).toBeUndefined();
    expect(data.provider['other']).toBeDefined();
    expect(data.model).toBeUndefined();
  });

  it('removeProvider keeps the active model when it belongs to another provider', async () => {
    mocks.files.set(CONFIG_PATH, JSON.stringify({
      model: 'other/some-model',
      provider: {
        'custom-openai': { npm: '@ai-sdk/openai-compatible', options: {} },
        other: { npm: '@ai-sdk/openai-compatible', options: {} },
      },
    }));

    const adapter = new MimoCodeAdapter();
    await adapter.removeProvider('custom-openai');

    const data = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(data.provider['custom-openai']).toBeUndefined();
    expect(data.model).toBe('other/some-model');
  });

  it('removeProvider is a no-op when the provider is not configured', async () => {
    mocks.files.set(CONFIG_PATH, JSON.stringify({ provider: { other: {} } }));
    const adapter = new MimoCodeAdapter();
    await adapter.removeProvider('custom-openai');
    expect(mocks.files.get(CONFIG_PATH)).toBe(JSON.stringify({ provider: { other: {} } }));
  });
});