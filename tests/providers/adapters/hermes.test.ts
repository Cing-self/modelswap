import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';

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
  updateUserConfig: vi.fn(async function(patch: any) { return patch; }),
}));

vi.mock('../../../src/vault/store', () => ({
  VaultStore: vi.fn().mockImplementation(function(this: any) {
    this.get = vi.fn(async function(key: string) { return key === 'TEST_API_KEY' ? 'sk-test-123' : undefined; });
  }),
}));

const { HermesAdapter } = await import('../../../src/providers/adapters/hermes');
const { updateUserConfig } = await import('../../../src/config/user');

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
  vi.mocked(updateUserConfig).mockClear();
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
  it('appends a custom_providers entry with base_url and api_key', async () => {
    const adapter = new HermesAdapter();
    await adapter.applyConfig(testProvider, 'deepseek-chat');

    const written = readWritten();
    expect(Array.isArray(written.custom_providers)).toBe(true);
    const entry = written.custom_providers.find((p: any) => p.name === 'DeepSeek');
    expect(entry).toMatchObject({
      name: 'DeepSeek',
      base_url: 'https://api.deepseek.com',
      api_key: 'sk-test-123',
    });
    // OpenAI-compatible endpoints carry no api_mode (Hermes default transport).
    expect(entry.api_mode).toBeUndefined();
  });

  it('maps anthropic type to api_mode anthropic_messages', async () => {
    const anthropicProvider = { ...testProvider, id: 'zai', name: 'ZAI', type: 'anthropic' as const };
    const adapter = new HermesAdapter();
    await adapter.applyConfig(anthropicProvider, 'glm-4.7');

    const entry = readWritten().custom_providers.find((p: any) => p.name === 'ZAI');
    expect(entry.api_mode).toBe('anthropic_messages');
  });

  it('adds opencode UA via extra_headers for opencode.ai gateway endpoints', async () => {
    const zenProvider = { ...testProvider, baseUrl: 'https://opencode.ai/zen/v1' };
    const adapter = new HermesAdapter();
    await adapter.applyConfig(zenProvider, 'deepseek-chat');

    const entry = readWritten().custom_providers.find((p: any) => p.name === 'DeepSeek');
    expect(entry.extra_headers).toEqual({ 'User-Agent': 'opencode/1.18.15' });
  });

  it('does not add extra_headers for non-opencode endpoints', async () => {
    const adapter = new HermesAdapter();
    await adapter.applyConfig(testProvider, 'deepseek-chat');

    const entry = readWritten().custom_providers.find((p: any) => p.name === 'DeepSeek');
    expect(entry.extra_headers).toBeUndefined();
  });

  it('sets model.default as provider-name/model-id string', async () => {
    const adapter = new HermesAdapter();
    await adapter.applyConfig(testProvider, 'deepseek-chat');

    expect(readWritten().model).toMatchObject({ default: 'DeepSeek/deepseek-chat' });
  });

  it('routes traffic to the custom endpoint via model.provider/base_url', async () => {
    const adapter = new HermesAdapter();
    await adapter.applyConfig(testProvider, 'deepseek-chat');

    expect(readWritten().model).toMatchObject({
      provider: 'custom',
      base_url: 'https://api.deepseek.com',
      api_key: 'sk-test-123',
    });
  });

  it('keeps api_mode off the model block for openai endpoints, on for anthropic', async () => {
    const adapter = new HermesAdapter();
    await adapter.applyConfig(testProvider, 'deepseek-chat');
    expect(readWritten().model.api_mode).toBeUndefined();

    const anthropicProvider = { ...testProvider, id: 'zai', name: 'ZAI', type: 'anthropic' as const };
    await adapter.applyConfig(anthropicProvider, 'glm-4.7');
    expect(readWritten().model).toMatchObject({ api_mode: 'anthropic_messages' });
  });

  it('replaces its own entry by name and preserves other providers + unrelated config', async () => {
    mocks.files.set(CONFIG_PATH, yaml.dump({
      custom_providers: [
        { name: 'User Custom', base_url: 'https://user.example', api_key: 'sk-user' },
        { name: 'DeepSeek', base_url: 'https://old.deepseek.com', api_key: 'sk-old' },
      ],
      model: { default: 'User Custom/foo' },
      memory: { enabled: true },
    }));

    const adapter = new HermesAdapter();
    await adapter.applyConfig(testProvider, 'deepseek-chat');

    const written = readWritten();
    expect(written.custom_providers).toHaveLength(2);
    expect(written.custom_providers.find((p: any) => p.name === 'User Custom')).toMatchObject({ base_url: 'https://user.example' });
    expect(written.custom_providers.find((p: any) => p.name === 'DeepSeek').base_url).toBe('https://api.deepseek.com');
    expect(written.memory).toEqual({ enabled: true });
    expect(written.model.default).toBe('DeepSeek/deepseek-chat');
  });

  it('records selection in user.json', async () => {
    const adapter = new HermesAdapter();
    await adapter.applyConfig(testProvider, 'deepseek-chat');

    expect(updateUserConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: { hermes: { providerId: 'deepseek', modelId: 'deepseek-chat' } },
      }),
    );
  });
});
