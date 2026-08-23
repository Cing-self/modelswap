import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';

const testRoot = vi.hoisted(() => {
  const p = require('path');
  const d = '/tmp/test-okit-grok';
  return {
    OKIT_DIR: d,
    REGISTRY_PATH: p.join(d, 'registry.json'),
    LOGS_DIR: p.join(d, 'logs'),
    CACHE_DIR: p.join(d, 'cache'),
    PROVIDERS_PATH: p.join(d, 'providers.json'),
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

const { GrokAdapter } = await import('../../../src/providers/adapters/grok');
const { updateUserConfig } = await import('../../../src/config/user');

const CONFIG_PATH = path.join(os.homedir(), '.grok', 'config.toml');
const PROVIDERS_JSON = testRoot.PROVIDERS_PATH;

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

describe('GrokAdapter', () => {
  it('has correct id and name', () => {
    const adapter = new GrokAdapter();
    expect(adapter.id).toBe('grok');
    expect(adapter.name).toBe('Grok Build');
  });

  it('writes a model table with inline api key and sets the default', async () => {
    const adapter = new GrokAdapter();
    await adapter.applyConfig(openAIProvider, 'my-model');

    const toml = mocks.files.get(CONFIG_PATH)!;
    expect(toml).toContain('[model.okit-custom-openai-my-model]');
    expect(toml).toContain('model = "my-model"');
    expect(toml).toContain('base_url = "https://custom.api.com/v1"');
    expect(toml).toContain('api_backend = "chat_completions"');
    expect(toml).toContain('api_key = "sk-test-123"');
    expect(toml).toContain('context_window = ');
    expect(toml).toContain('[models]\ndefault = "okit-custom-openai-my-model"');
  });

  it('registers every model of the provider', async () => {
    const adapter = new GrokAdapter();
    await adapter.applyConfig(openAIProvider, 'my-model');

    const toml = mocks.files.get(CONFIG_PATH)!;
    expect(toml).toContain('[model.okit-custom-openai-my-model]');
    expect(toml).toContain('[model.okit-custom-openai-other-model]');
  });

  it('maps anthropic providers to the messages backend', async () => {
    const adapter = new GrokAdapter();
    await adapter.applyConfig(anthropicProvider, 'claude-model');

    const toml = mocks.files.get(CONFIG_PATH)!;
    expect(toml).toContain('api_backend = "messages"');
    expect(toml).toContain('[models]\ndefault = "okit-custom-anthropic-claude-model"');
  });

it('routes ernie models through the local tool-schema proxy', async () => {
    const ernieProvider = { ...openAIProvider, models: [{ id: 'ernie-5.1' }] };
    const adapter = new GrokAdapter();
    await adapter.applyConfig(ernieProvider, 'ernie-5.1');

    const toml = mocks.files.get(CONFIG_PATH)!;
    const expected = `http://127.0.0.1:3780/api/grok-proxy/${encodeURIComponent('https://custom.api.com/v1')}`;
    expect(toml).toContain(`base_url = "${expected}"`);
    expect(toml).not.toContain('base_url = "https://custom.api.com/v1"');
  });

  it('writes gateway context windows for opencode.ai / openrouter.ai free models', async () => {
    const zenProvider = { ...openAIProvider, baseUrl: 'https://opencode.ai/zen/v1', models: [{ id: 'deepseek-v4-flash-free' }] };
    const adapter = new GrokAdapter();
    await adapter.applyConfig(zenProvider, 'deepseek-v4-flash-free');

    const toml = mocks.files.get(CONFIG_PATH)!;
    expect(toml).toContain('context_window = 200000');
    expect(toml).toContain('extra_headers = { "User-Agent" = "opencode/1.18.15" }');
  });

  it('does not add extra_headers for non-opencode endpoints', async () => {
    const adapter = new GrokAdapter();
    await adapter.applyConfig(openAIProvider, 'my-model');

    const toml = mocks.files.get(CONFIG_PATH)!;
    expect(toml).not.toContain('extra_headers');
  });

  it('keeps non-ernie models pointing directly at the provider', async () => {
    const adapter = new GrokAdapter();
    await adapter.applyConfig(openAIProvider, 'my-model');

    const toml = mocks.files.get(CONFIG_PATH)!;
    expect(toml).toContain('base_url = "https://custom.api.com/v1"');
    expect(toml).not.toContain('api/grok-proxy');
  });

  it('omits api_key when the vault has no key', async () => {
    const noKeyProvider = { ...openAIProvider, vaultKey: 'MISSING_KEY' };
    const adapter = new GrokAdapter();
    await adapter.applyConfig(noKeyProvider, 'my-model');
    expect(mocks.files.get(CONFIG_PATH)!).not.toContain('api_key');
  });

  it('rewrites only its own tables, preserving other sites and settings', async () => {
    mocks.files.set(CONFIG_PATH, [
      '[model.okit-custom-openai-my-model]',
      'model = "my-model"',
      'base_url = "https://old.example.com"',
      '',
      '[model.okit-other-site-some-model]',
      'model = "some-model"',
      'base_url = "https://other.example.com"',
      '',
      '[models]',
      'default = "okit-other-site-some-model"',
      'web_search = "grok-4.6"',
      '',
      '[ui]',
      'theme = "auto"',
    ].join('\n'));

    const adapter = new GrokAdapter();
    await adapter.applyConfig(openAIProvider, 'my-model');

    const toml = mocks.files.get(CONFIG_PATH)!;
    expect(toml).toContain('base_url = "https://custom.api.com/v1"');
    expect(toml).not.toContain('https://old.example.com');
    expect(toml).toContain('[model.okit-other-site-some-model]');
    expect(toml).toContain('web_search = "grok-4.6"');
    expect(toml).toContain('[models]\ndefault = "okit-custom-openai-my-model"');
    expect(toml).toContain('theme = "auto"');
  });

  it('applyModels is additive and does not touch the default', async () => {
    mocks.files.set(CONFIG_PATH, [
      '[model.okit-other-site-some-model]',
      'model = "some-model"',
      'base_url = "https://other.example.com"',
      '',
      '[models]',
      'default = "okit-other-site-some-model"',
    ].join('\n'));

    const adapter = new GrokAdapter();
    const { written } = await adapter.applyModels([{ provider: openAIProvider, modelId: 'my-model' }]);

    expect(written).toEqual(['my-model']);
    const toml = mocks.files.get(CONFIG_PATH)!;
    expect(toml).toContain('[model.okit-custom-openai-my-model]');
    expect(toml).toContain('[model.okit-other-site-some-model]');
    expect(toml).toContain('default = "okit-other-site-some-model"');
  });

  it('lists enabled providers, preferring the longest id on prefix collisions', async () => {
    mocks.files.set(PROVIDERS_JSON, JSON.stringify({
      providers: [
        { id: 'xiaomi', name: 'X', type: 'openai', baseUrl: 'https://x', authMode: 'api_key', models: [] },
        { id: 'xiaomi-coding', name: 'Y', type: 'openai', baseUrl: 'https://y', authMode: 'api_key', models: [] },
      ],
    }));
    mocks.files.set(CONFIG_PATH, [
      '[model.okit-xiaomi-coding-mimo-v2-5-pro]',
      'model = "mimo-v2.5-pro"',
      '',
      '[model.okit-xiaomi-mimo-v2-5]',
      'model = "mimo-v2.5"',
    ].join('\n'));

    const adapter = new GrokAdapter();
    expect(await adapter.listEnabledProviders()).toEqual(['xiaomi-coding', 'xiaomi']);
  });

  it('removeProvider strips its tables and clears a default it owned', async () => {
    mocks.files.set(CONFIG_PATH, [
      '[model.okit-custom-openai-my-model]',
      'model = "my-model"',
      'base_url = "https://custom.api.com/v1"',
      '',
      '[model.okit-other-site-some-model]',
      'model = "some-model"',
      'base_url = "https://other.example.com"',
      '',
      '[models]',
      'default = "okit-custom-openai-my-model"',
      'web_search = "grok-4.6"',
    ].join('\n'));

    const adapter = new GrokAdapter();
    await adapter.removeProvider('custom-openai');

    const toml = mocks.files.get(CONFIG_PATH)!;
    expect(toml).not.toContain('custom-openai');
    expect(toml).not.toContain('default =');
    expect(toml).toContain('[model.okit-other-site-some-model]');
    expect(toml).toContain('web_search = "grok-4.6"');
  });

  it('removeProvider is a no-op when the provider has no tables', async () => {
    mocks.files.set(CONFIG_PATH, '[ui]\ntheme = "auto"\n');
    const adapter = new GrokAdapter();
    await adapter.removeProvider('custom-openai');
    expect(mocks.files.get(CONFIG_PATH)).toBe('[ui]\ntheme = "auto"\n');
  });

  it('does not strip another provider whose id is a prefix of this one', async () => {
    mocks.files.set(CONFIG_PATH, [
      '[model.okit-xiaomi-mimo-v2-5]',
      'model = "mimo-v2.5"',
      'base_url = "https://x"',
    ].join('\n'));

    const xiaomiCodingProvider = { ...openAIProvider, id: 'xiaomi-coding', models: [{ id: 'mimo-v2.5-pro' }] };
    const adapter = new GrokAdapter();
    await adapter.applyConfig(xiaomiCodingProvider, 'mimo-v2.5-pro');

    const toml = mocks.files.get(CONFIG_PATH)!;
    // "okit-xiaomi-..." belongs to provider "xiaomi", not "xiaomi-coding".
    expect(toml).toContain('[model.okit-xiaomi-mimo-v2-5]');
    expect(toml).toContain('[model.okit-xiaomi-coding-mimo-v2-5-pro]');
  });
});