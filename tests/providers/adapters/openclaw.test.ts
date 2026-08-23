import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';

const testRoot = vi.hoisted(() => {
  const p = require('path');
  const d = '/tmp/test-okit-openclaw';
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

const { OpenClawAdapter } = await import('../../../src/providers/adapters/openclaw');
const { updateUserConfig } = await import('../../../src/config/user');

const CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');

const testProvider = {
  id: 'deepseek',
  name: 'DeepSeek',
  type: 'openai' as const,
  baseUrl: 'https://api.deepseek.com',
  vaultKey: 'TEST_API_KEY',
  authMode: 'api_key' as const,
  models: [{ id: 'deepseek-chat', name: 'DeepSeek V4' }],
};

beforeEach(() => {
  mocks.files.clear();
  vi.mocked(updateUserConfig).mockClear();
});

describe('OpenClawAdapter', () => {
  it('has correct id and name', () => {
    const adapter = new OpenClawAdapter();
    expect(adapter.id).toBe('openclaw');
    expect(adapter.name).toBe('OpenClaw');
  });

  it('supports anthropic/openai types', () => {
    const adapter = new OpenClawAdapter();
    expect(adapter.supportedTypes).toEqual(['anthropic', 'openai']);
  });
});

describe('OpenClawAdapter.applyConfig (cc-switch schema)', () => {
  it('writes provider into models.providers as an OBJECT keyed by id', async () => {
    const adapter = new OpenClawAdapter();
    await adapter.applyConfig(testProvider, 'deepseek-chat');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(written.models.mode).toBe('merge');
    expect(typeof written.models.providers).toBe('object');
    expect(written.models.providers.deepseek).toBeDefined();
    expect(written.models.providers.deepseek.baseUrl).toBe('https://api.deepseek.com');
    expect(written.models.providers.deepseek.apiKey).toBe('sk-test-123');
  });

  it('writes the api protocol field (openai-completions for openai type)', async () => {
    const adapter = new OpenClawAdapter();
    await adapter.applyConfig(testProvider, 'deepseek-chat');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(written.models.providers.deepseek.api).toBe('openai-completions');
  });

  it('maps anthropic type to api = "anthropic"', async () => {
    const anthropicProvider = { ...testProvider, id: 'zai', type: 'anthropic' as const };
    const adapter = new OpenClawAdapter();
    await adapter.applyConfig(anthropicProvider, 'glm-4.7');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(written.models.providers.zai.api).toBe('anthropic');
  });

  it('sets agents.defaults.model as object {primary, fallbacks} (plural "defaults")', async () => {
    const adapter = new OpenClawAdapter();
    await adapter.applyConfig(testProvider, 'deepseek-chat');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(written.agents.defaults.model).toEqual({
      primary: 'deepseek/deepseek-chat',
      fallbacks: [],
    });
  });

  it('preserves existing providers when adding a new one (additive merge)', async () => {
    mocks.files.set(CONFIG_PATH, JSON.stringify({
      models: { mode: 'merge', providers: { glm: { baseUrl: 'https://glm.com', api: 'openai-completions' } } },
      agents: { defaults: {} },
    }));

    const adapter = new OpenClawAdapter();
    await adapter.applyConfig(testProvider, 'deepseek-chat');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(Object.keys(written.models.providers)).toEqual(['glm', 'deepseek']);
  });

  it('models entry has id + name (no capabilities field)', async () => {
    const adapter = new OpenClawAdapter();
    await adapter.applyConfig(testProvider, 'deepseek-chat');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(written.models.providers.deepseek.models).toEqual([
      { id: 'deepseek-chat', name: 'DeepSeek V4' },
    ]);
  });

  it('records selection in user.json', async () => {
    const adapter = new OpenClawAdapter();
    await adapter.applyConfig(testProvider, 'deepseek-chat');

    expect(updateUserConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: { openclaw: { providerId: 'deepseek', modelId: 'deepseek-chat' } },
      }),
    );
  });
});
