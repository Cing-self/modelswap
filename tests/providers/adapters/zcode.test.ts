import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';

const testRoot = vi.hoisted(() => {
  const p = require('path');
  const d = '/tmp/test-okit-zcode';
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

const userConfigStore: Record<string, any> = {};

vi.mock('../../../src/config/user', () => ({
  loadUserConfig: vi.fn(async function() { return userConfigStore; }),
  updateUserConfig: vi.fn(async function(patch: any) {
    if (patch.providers && typeof patch.providers === 'object') {
      userConfigStore.providers = {
        ...(userConfigStore.providers || {}),
        ...Object.fromEntries(Object.entries(patch.providers).map(([agent, sel]) => {
          const prev = userConfigStore.providers?.[agent] || {};
          return [agent, { ...prev, ...(sel as object) }];
        })),
      };
    }
    return patch;
  }),
}));

vi.mock('../../../src/vault/store', () => ({
  VaultStore: vi.fn().mockImplementation(function(this: any) {
    this.get = vi.fn(async function(key: string) { return key === 'TEST_API_KEY' ? 'sk-test-123' : undefined; });
  }),
}));

const { ZCodeAdapter } = await import('../../../src/providers/adapters/zcode');
const { loadUserConfig } = await import('../../../src/config/user');

const CONFIG_PATH = path.join(os.homedir(), '.zcode', 'v2', 'config.json');

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
  Object.keys(userConfigStore).forEach(k => delete userConfigStore[k]);
  userConfigStore.providers = {};
});

describe('ZCodeAdapter', () => {
  it('has correct id and name', () => {
    const adapter = new ZCodeAdapter();
    expect(adapter.id).toBe('zcode');
    expect(adapter.name).toBe('ZCode');
  });

  it('supports anthropic/openai types', () => {
    const adapter = new ZCodeAdapter();
    expect(adapter.supportedTypes).toEqual(['anthropic', 'openai']);
  });
});

describe('ZCodeAdapter.applyConfig (v2 config schema)', () => {
  it('writes to ~/.zcode/v2/config.json (not the legacy path)', async () => {
    const adapter = new ZCodeAdapter();
    await adapter.applyConfig(testProvider, 'deepseek-chat');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(written.provider.deepseek).toBeDefined();
  });

  it('writes a provider entry with kind/apiFormat/options/models (ZCode schema)', async () => {
    const adapter = new ZCodeAdapter();
    await adapter.applyConfig(testProvider, 'deepseek-chat');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    const entry = written.provider.deepseek;
    expect(entry.enabled).toBe(true);
    expect(entry.name).toBe('DeepSeek');
    expect(entry.source).toBe('custom');
    expect(entry.kind).toBe('openai-compatible');
    expect(entry.apiFormat).toBe('openai-chat-completions');
    expect(entry.options.baseURL).toBe('https://api.deepseek.com');
    expect(entry.options.apiKey).toBe('sk-test-123');
    expect(entry.models).toEqual({ 'deepseek-chat': { name: 'DeepSeek V4' } });
  });

  it('maps anthropic type to kind anthropic + anthropic-messages, stripping trailing /v1', async () => {
    const anthropicProvider = {
      ...testProvider,
      id: 'zai',
      type: 'anthropic' as const,
      baseUrl: 'https://api.z.ai',
      endpoints: [{ type: 'anthropic' as const, baseUrl: 'https://api.z.ai' }],
    };
    const adapter = new ZCodeAdapter();
    await adapter.applyConfig(anthropicProvider, 'glm-4.7');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    const entry = written.provider.zai;
    expect(entry.kind).toBe('anthropic');
    expect(entry.apiFormat).toBe('anthropic-messages');
    expect(entry.options.baseURL).toBe('https://api.z.ai');
  });

  it('maps openai responses protocol to kind openai + openai-responses', async () => {
    const responsesProvider = {
      ...testProvider,
      id: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      endpoints: [{ type: 'openai' as const, protocol: 'responses' as const, baseUrl: 'https://api.openai.com/v1' }],
    };
    const adapter = new ZCodeAdapter();
    await adapter.applyConfig(responsesProvider, 'gpt-5');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    const entry = written.provider.openai;
    expect(entry.kind).toBe('openai');
    expect(entry.apiFormat).toBe('openai-responses');
  });

  it('preserves existing providers (builtin + custom) when adding a new one', async () => {
    mocks.files.set(CONFIG_PATH, JSON.stringify({
      provider: {
        'builtin:bigmodel-coding-plan': { enabled: true, name: 'BigModel - Coding Plan', kind: 'anthropic', source: 'custom' },
      },
    }));

    const adapter = new ZCodeAdapter();
    await adapter.applyConfig(testProvider, 'deepseek-chat');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(Object.keys(written.provider).sort()).toEqual(['builtin:bigmodel-coding-plan', 'deepseek']);
    expect(written.provider['builtin:bigmodel-coding-plan'].kind).toBe('anthropic');
  });

  it('does not overwrite an existing provider entry OKIT does not own', async () => {
    mocks.files.set(CONFIG_PATH, JSON.stringify({
      provider: {
        deepseek: { enabled: true, name: 'My DeepSeek', kind: 'anthropic', options: { baseURL: 'https://other.example.com' } },
      },
    }));

    const adapter = new ZCodeAdapter();
    await expect(adapter.applyConfig(testProvider, 'deepseek-chat')).rejects.toThrow(/已跳过/);

    // File untouched.
    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(written.provider.deepseek.name).toBe('My DeepSeek');
  });

  it('adopts an existing entry pointing at the same endpoint (legacy OKIT write)', async () => {
    mocks.files.set(CONFIG_PATH, JSON.stringify({
      provider: {
        deepseek: { enabled: true, name: 'DeepSeek', kind: 'openai-compatible', options: { baseURL: 'https://api.deepseek.com' } },
      },
    }));

    const adapter = new ZCodeAdapter();
    await adapter.applyConfig(testProvider, 'deepseek-chat');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(written.provider.deepseek.options.apiKey).toBe('sk-test-123');
  });

  it('records selection + managedModels in user.json', async () => {
    const adapter = new ZCodeAdapter();
    await adapter.applyConfig(testProvider, 'deepseek-chat');

    const config = await loadUserConfig();
    expect(config.providers.zcode).toEqual({
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      managedModels: { deepseek: ['deepseek-chat'] },
    });
  });

  it('adds opencode UA headers for opencode.ai gateway endpoints', async () => {
    const opencodeProvider = {
      ...testProvider,
      id: 'opencode-zen',
      baseUrl: 'https://opencode.ai/zen/v1',
      endpoints: [{ type: 'openai' as const, protocol: 'chat' as const, baseUrl: 'https://opencode.ai/zen/v1' }],
    };
    const adapter = new ZCodeAdapter();
    await adapter.applyConfig(opencodeProvider, 'deepseek-v4-flash-free');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    const entry = written.provider['opencode-zen'];
    expect(entry.headers).toEqual({ 'User-Agent': 'opencode/1.18.15' });
    expect(entry.options.headers).toEqual({ 'User-Agent': 'opencode/1.18.15' });
  });

  it('does not add opencode UA headers to non-opencode endpoints', async () => {
    const adapter = new ZCodeAdapter();
    await adapter.applyConfig(testProvider, 'deepseek-chat');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    const entry = written.provider.deepseek;
    expect(entry.headers).toBeUndefined();
    expect(entry.options.headers).toBeUndefined();
  });

  it('writes explicit limits for opencode-zen free models so max_tokens stays under the gateway cap', async () => {
    const opencodeProvider = {
      ...testProvider,
      id: 'opencode-zen',
      baseUrl: 'https://opencode.ai/zen/v1',
      endpoints: [{ type: 'openai' as const, protocol: 'chat' as const, baseUrl: 'https://opencode.ai/zen/v1' }],
      models: [
        { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free' },
        { id: 'hy3-free', name: 'Hy3 Free' },
      ],
    };
    const adapter = new ZCodeAdapter();
    await adapter.applyConfig(opencodeProvider, 'deepseek-v4-flash-free');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    const entry = written.provider['opencode-zen'];
    expect(entry.models['deepseek-v4-flash-free'].limit).toEqual({ context: 200000, output: 128000 });
    expect(entry.models['hy3-free'].limit).toEqual({ context: 200000, output: 128000 });
  });

  it('does not write limits for non-opencode endpoints', async () => {
    const adapter = new ZCodeAdapter();
    await adapter.applyConfig(testProvider, 'deepseek-chat');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(written.provider.deepseek.models['deepseek-chat'].limit).toBeUndefined();
  });

  it('writes limits for OpenRouter :free models missing from the ZCode built-in catalog', async () => {
    const openrouterProvider = {
      ...testProvider,
      id: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      endpoints: [{ type: 'openai' as const, protocol: 'chat' as const, baseUrl: 'https://openrouter.ai/api/v1' }],
      models: [
        { id: 'cohere/north-mini-code:free', name: 'Cohere North Mini Code (Free)' },
        { id: 'google/gemma-4-26b-a4b-it:free', name: 'Gemma 4 26B (Free)' },
      ],
    };
    const adapter = new ZCodeAdapter();
    await adapter.applyConfig(openrouterProvider, 'cohere/north-mini-code:free');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    const entry = written.provider.openrouter;
    // ZCode knows gemma-4-26b-a4b-it:free itself — OKIT must not override it.
    expect(entry.models['google/gemma-4-26b-a4b-it:free'].limit).toBeUndefined();
    expect(entry.models['cohere/north-mini-code:free'].limit).toEqual({ context: 256000, output: 8192 });
  });
});

describe('ZCodeAdapter.applyModels (additive home-site write)', () => {
  it('writes entries for multiple providers into one provider map', async () => {
    const adapter = new ZCodeAdapter();
    const result = await adapter.applyModels([
      { provider: testProvider, modelId: 'deepseek-chat' },
      { provider: { ...testProvider, id: 'zai', name: 'Z.ai', baseUrl: 'https://api.z.ai' }, modelId: 'glm-4.7' },
    ]);

    expect(result.written).toEqual(['deepseek-chat', 'glm-4.7']);
    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(Object.keys(written.provider).sort()).toEqual(['deepseek', 'zai']);
  });

  it('skips providers whose existing entry OKIT does not own, keeps writing the rest', async () => {
    mocks.files.set(CONFIG_PATH, JSON.stringify({
      provider: {
        deepseek: { enabled: true, name: 'My DeepSeek', kind: 'anthropic', options: { baseURL: 'https://other.example.com' } },
      },
    }));

    const adapter = new ZCodeAdapter();
    const result = await adapter.applyModels([
      { provider: testProvider, modelId: 'deepseek-chat' },
      { provider: { ...testProvider, id: 'zai', name: 'Z.ai', baseUrl: 'https://api.z.ai' }, modelId: 'glm-4.7' },
    ]);

    expect(result.skipped).toEqual(['deepseek-chat']);
    expect(result.written).toEqual(['glm-4.7']);
    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(written.provider.deepseek.name).toBe('My DeepSeek');
    expect(written.provider.zai).toBeDefined();
  });

  it('does not touch the current selection in user.json', async () => {
    userConfigStore.providers.zcode = { providerId: 'old', modelId: 'old-model' };
    const adapter = new ZCodeAdapter();
    await adapter.applyModels([{ provider: testProvider, modelId: 'deepseek-chat' }]);

    const config = await loadUserConfig();
    expect(config.providers.zcode.providerId).toBe('old');
    expect(config.providers.zcode.modelId).toBe('old-model');
    expect(config.providers.zcode.managedModels.deepseek).toContain('deepseek-chat');
  });
});

describe('ZCodeAdapter.setProviderEnabled', () => {
  it('flips enabled to false but keeps the entry (models + options intact)', async () => {
    userConfigStore.providers.zcode = {
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      managedModels: { deepseek: ['deepseek-chat'] },
    };
    mocks.files.set(CONFIG_PATH, JSON.stringify({
      provider: {
        deepseek: {
          enabled: true,
          name: 'DeepSeek',
          source: 'custom',
          kind: 'openai-compatible',
          options: { baseURL: 'https://api.deepseek.com', apiKey: 'sk-test-123' },
          models: { 'deepseek-chat': { name: 'DeepSeek V4' } },
        },
      },
    }));

    const adapter = new ZCodeAdapter();
    await adapter.setProviderEnabled('deepseek', false);

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(written.provider.deepseek.enabled).toBe(false);
    // Entry survives with models + options.
    expect(written.provider.deepseek.models['deepseek-chat'].name).toBe('DeepSeek V4');
    expect(written.provider.deepseek.options.baseURL).toBe('https://api.deepseek.com');

    // Current selection cleared (site no longer active) — managedModels kept.
    const config = await loadUserConfig();
    expect(config.providers.zcode.providerId).toBeUndefined();
    expect(config.providers.zcode.managedModels.deepseek).toEqual(['deepseek-chat']);
  });

  it('re-enables by flipping enabled back to true', async () => {
    mocks.files.set(CONFIG_PATH, JSON.stringify({
      provider: {
        deepseek: { enabled: false, name: 'DeepSeek', source: 'custom', options: { baseURL: 'https://api.deepseek.com' } },
      },
    }));
    userConfigStore.providers.zcode = { managedModels: { deepseek: ['deepseek-chat'] } };

    const adapter = new ZCodeAdapter();
    await adapter.setProviderEnabled('deepseek', true);

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(written.provider.deepseek.enabled).toBe(true);
  });

  it('is a no-op when the provider is not managed and not current', async () => {
    mocks.files.set(CONFIG_PATH, JSON.stringify({
      provider: { 'builtin:bigmodel': { enabled: true, name: 'BigModel', kind: 'anthropic' } },
    }));

    const adapter = new ZCodeAdapter();
    await adapter.setProviderEnabled('unrelated', false);

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(written.provider['builtin:bigmodel'].enabled).toBe(true);
    expect(mocks.files.get(CONFIG_PATH)!.includes('unrelated')).toBe(false);
  });
});

describe('ZCodeAdapter.listEnabledProviders', () => {
  it('returns every enabled provider id, excluding disabled ones', async () => {
    mocks.files.set(CONFIG_PATH, JSON.stringify({
      provider: {
        'builtin:bigmodel-coding-plan': { enabled: true, name: 'BigModel', kind: 'anthropic' },
        deepseek: { enabled: true, name: 'DeepSeek', kind: 'openai-compatible' },
        zai: { enabled: false, name: 'Z.ai', kind: 'openai-compatible' },
        noref: { name: 'No flag', kind: 'anthropic' },
      },
    }));

    const adapter = new ZCodeAdapter();
    const enabled = await adapter.listEnabledProviders();
    expect(enabled.sort()).toEqual(['builtin:bigmodel-coding-plan', 'deepseek', 'noref']);
  });

  it('returns [] when config is missing or empty', async () => {
    const adapter = new ZCodeAdapter();
    expect(await adapter.listEnabledProviders()).toEqual([]);

    mocks.files.set(CONFIG_PATH, JSON.stringify({ provider: {} }));
    expect(await adapter.listEnabledProviders()).toEqual([]);
  });
});

describe('ZCodeAdapter.getActiveModel', () => {
  it('reads the most recent task model from the sqlite index', async () => {
    const sqlitePath = path.join(os.homedir(), '.zcode', 'v2', 'tasks-index.sqlite');
    const adapter = new ZCodeAdapter();
    const result = await adapter.getActiveModel();
    if (result) {
      expect(typeof result.providerId).toBe('string');
      expect(typeof result.modelId).toBe('string');
    }
  });

  it('falls back to the user.json selection when sqlite is unavailable', async () => {
    // Point the adapter's expected db path at a non-existent location by
    // deleting the tasks file beforehand (already absent in the test sandbox).
    const adapter = new ZCodeAdapter();
    userConfigStore.providers.zcode = { providerId: 'deepseek', modelId: 'deepseek-chat' };
    const result = await adapter.getActiveModel();
    expect(result).toEqual({ providerId: 'deepseek', modelId: 'deepseek-chat' });
  });
});

describe('ZCodeAdapter.removeProvider', () => {
  it('removes only the OKIT-managed provider entry, preserving builtin entries', async () => {
    await userConfigStore;
    mocks.files.set(CONFIG_PATH, JSON.stringify({
      provider: {
        'builtin:bigmodel-coding-plan': { enabled: true, name: 'BigModel', kind: 'anthropic' },
        deepseek: { enabled: true, name: 'DeepSeek', kind: 'openai-compatible' },
      },
    }));
    userConfigStore.providers.zcode = {
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      managedModels: { deepseek: ['deepseek-chat'] },
    };

    const adapter = new ZCodeAdapter();
    await adapter.removeProvider('deepseek');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(written.provider.deepseek).toBeUndefined();
    expect(written.provider['builtin:bigmodel-coding-plan']).toBeDefined();

    const config = await loadUserConfig();
    expect(config.providers.zcode.providerId).toBeUndefined();
    expect(config.providers.zcode.managedModels.deepseek).toBeUndefined();
  });

  it('is a no-op when the provider is not managed and not current', async () => {
    mocks.files.set(CONFIG_PATH, JSON.stringify({
      provider: { deepseek: { enabled: true, name: 'DeepSeek' } },
    }));

    const adapter = new ZCodeAdapter();
    await adapter.removeProvider('unrelated');

    const written = JSON.parse(mocks.files.get(CONFIG_PATH)!);
    expect(written.provider.deepseek).toBeDefined();
  });
});

describe('ZCodeAdapter media capability overrides (cli/config.json)', () => {
  const CLI_CONFIG_PATH = path.join(os.homedir(), '.zcode', 'cli', 'config.json');
  const zenProvider = {
    ...testProvider,
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    models: [
      { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free', capabilities: ['chat'] },
      { id: 'mimo-v2.5-free', name: 'MiMo V2.5 Free', capabilities: ['chat', 'vision'] },
      { id: 'muse-spark-1.2-contributor-free', name: 'Muse Spark 1.2 Free' },
    ],
  };

  it('writes supportsImages:false overrides for text-only models into cli/config.json', async () => {
    mocks.files.set(CLI_CONFIG_PATH, JSON.stringify({ mcp: { servers: {} } }));

    const adapter = new ZCodeAdapter();
    await adapter.applyConfig(zenProvider, 'deepseek-v4-flash-free');

    const cli = JSON.parse(mocks.files.get(CLI_CONFIG_PATH)!);
    expect(cli.mcp).toEqual({ servers: {} });  // user sections preserved
    expect(cli.modelCatalog.overrides['opencode-zen/deepseek-v4-flash-free'])
      .toEqual({ supportsImages: false, _okitManaged: true });
  });

  it('does not write overrides for vision or unknown-capability models', async () => {
    const adapter = new ZCodeAdapter();
    await adapter.applyConfig(zenProvider, 'deepseek-v4-flash-free');

    const cli = JSON.parse(mocks.files.get(CLI_CONFIG_PATH)!);
    expect(cli.modelCatalog.overrides['opencode-zen/mimo-v2.5-free']).toBeUndefined();
    expect(cli.modelCatalog.overrides['opencode-zen/muse-spark-1.2-contributor-free']).toBeUndefined();
  });

  it('does not create cli/config.json for providers without text-only models', async () => {
    const provider = {
      ...testProvider,
      models: [{ id: 'deepseek-chat', name: 'DeepSeek V4' }],  // no capabilities
    };
    const adapter = new ZCodeAdapter();
    await adapter.applyConfig(provider, 'deepseek-chat');

    expect(mocks.files.has(CLI_CONFIG_PATH)).toBe(false);
  });

  it('removes only OKIT-tagged overrides on removeProvider and keeps user overrides', async () => {
    mocks.files.set(CLI_CONFIG_PATH, JSON.stringify({
      modelCatalog: {
        overrides: {
          'opencode-zen/deepseek-v4-flash-free': { supportsImages: false, _okitManaged: true },
          'opencode-zen/mimo-v2.5-free': { supportsImages: true },  // user-written, untagged
          'other-provider/model': { supportsImages: false, _okitManaged: true },
        },
      },
    }));
    mocks.files.set(CONFIG_PATH, JSON.stringify({
      provider: { 'opencode-zen': { enabled: true, name: 'OpenCode Zen' } },
    }));
    userConfigStore.providers = { zcode: { providerId: 'opencode-zen', modelId: 'deepseek-v4-flash-free', managedModels: { 'opencode-zen': ['deepseek-v4-flash-free'] } } };

    const adapter = new ZCodeAdapter();
    await adapter.removeProvider('opencode-zen');

    const cli = JSON.parse(mocks.files.get(CLI_CONFIG_PATH)!);
    expect(cli.modelCatalog.overrides['opencode-zen/deepseek-v4-flash-free']).toBeUndefined();
    expect(cli.modelCatalog.overrides['opencode-zen/mimo-v2.5-free']).toEqual({ supportsImages: true });
    expect(cli.modelCatalog.overrides['other-provider/model']).toBeDefined();
  });

  it('re-syncs overrides on applyModels for added text-only sites', async () => {
    const adapter = new ZCodeAdapter();
    const result = await adapter.applyModels([
      { provider: zenProvider, modelId: 'deepseek-v4-flash-free' },
    ]);

    expect(result.written).toEqual(['deepseek-v4-flash-free']);
    const cli = JSON.parse(mocks.files.get(CLI_CONFIG_PATH)!);
    expect(cli.modelCatalog.overrides['opencode-zen/deepseek-v4-flash-free'].supportsImages).toBe(false);
  });
});
