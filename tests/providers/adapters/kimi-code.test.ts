import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';

const testRoot = vi.hoisted(() => {
  const p = require('path');
  const d = '/tmp/test-okit-kimi-code';
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

const { KimiCodeAdapter } = await import('../../../src/providers/adapters/kimi-code');
const { updateUserConfig } = await import('../../../src/config/user');

const CONFIG_PATH = path.join(os.homedir(), '.kimi-code', 'config.toml');
const ENV_PATH = path.join(os.homedir(), '.kimi-code', '.env');

// A third-party OpenAI-compatible provider (the common case for kimi-code).
const customProvider = {
  id: 'custom-openai',
  name: 'Custom OpenAI',
  type: 'openai' as const,
  baseUrl: 'https://custom.api.com/v1',
  vaultKey: 'TEST_API_KEY',
  authMode: 'api_key' as const,
  models: [{ id: 'my-model' }],
};

// The official Kimi/Moonshot provider — should resolve to providerId "kimi".
const moonshotProvider = {
  id: 'moonshot',
  name: 'Moonshot',
  type: 'openai' as const,
  baseUrl: 'https://api.moonshot.ai/v1',
  vaultKey: 'TEST_API_KEY',
  authMode: 'api_key' as const,
  models: [{ id: 'moonshot-v1-128k' }],
};

beforeEach(() => {
  mocks.files.clear();
  vi.mocked(updateUserConfig).mockClear();
});

describe('KimiCodeAdapter', () => {
  it('has correct id and name', () => {
    const adapter = new KimiCodeAdapter();
    expect(adapter.id).toBe('kimi-code');
    expect(adapter.name).toBe('Kimi Code');
  });

  it('supports openai type only', () => {
    const adapter = new KimiCodeAdapter();
    expect(adapter.supportedTypes).toEqual(['openai']);
  });
});

describe('KimiCodeAdapter.applyConfig (v2 config format)', () => {
  it('writes default_model pointing at a [models.*] alias', async () => {
    const adapter = new KimiCodeAdapter();
    await adapter.applyConfig(customProvider, 'my-model');

    const toml = mocks.files.get(CONFIG_PATH)!;
    expect(toml).toContain('default_model = "okit-custom-openai-my-model"');
    expect(toml).toContain('[models.okit-custom-openai-my-model]');
    expect(toml).toContain('provider = "okit-custom-openai"');
    expect(toml).toContain('model = "my-model"');
    expect(toml).toContain('protocol = "openai"');
    expect(toml).toContain('max_context_size = 262144');
  });

  it('writes [providers.X] table with type/base_url/inline api_key', async () => {
    const adapter = new KimiCodeAdapter();
    await adapter.applyConfig(customProvider, 'my-model');

    const toml = mocks.files.get(CONFIG_PATH)!;
    expect(toml).toContain('[providers.okit-custom-openai]');
    expect(toml).toContain('type = "openai"');
    expect(toml).toContain('base_url = "https://custom.api.com/v1"');
    expect(toml).toContain('api_key = "sk-test-123"');
  });

  it('writes gateway token windows for opencode.ai / openrouter.ai free models', async () => {
    const zenProvider = { ...customProvider, baseUrl: 'https://opencode.ai/zen/v1', models: [{ id: 'deepseek-v4-flash-free' }] };
    const adapter = new KimiCodeAdapter();
    await adapter.applyConfig(zenProvider, 'deepseek-v4-flash-free');

    const toml = mocks.files.get(CONFIG_PATH)!;
    expect(toml).toContain('max_context_size = 200000');
    expect(toml).toContain('max_output_size = 128000');
    // custom_headers uses the sub-table form kimi itself normalizes to —
    // never the inline form (duplicate key breaks TOML parsing).
    expect(toml).toContain('[providers.okit-custom-openai.custom_headers]');
    expect(toml).toContain('User-Agent = "opencode/1.18.15"');
    expect(toml).not.toContain('custom_headers = {');
  });

  it('writes openrouter :free output cap of 8192', async () => {
    const orProvider = { ...customProvider, baseUrl: 'https://openrouter.ai/api/v1', models: [{ id: 'poolside/laguna-s-2.1:free' }] };
    const adapter = new KimiCodeAdapter();
    await adapter.applyConfig(orProvider, 'poolside/laguna-s-2.1:free');

    const toml = mocks.files.get(CONFIG_PATH)!;
    expect(toml).toContain('max_context_size = 262144');
    expect(toml).toContain('max_output_size = 8192');
    expect(toml).not.toContain('custom_headers');
  });

  it('registers every model of the provider so /model has choices', async () => {
    const multiModelProvider = {
      ...customProvider,
      models: [{ id: 'my-model' }, { id: 'my-model-lite' }, { id: 'my-model-pro' }],
    };
    const adapter = new KimiCodeAdapter();
    await adapter.applyConfig(multiModelProvider, 'my-model-pro');

    const toml = mocks.files.get(CONFIG_PATH)!;
    expect(toml).toContain('[models.okit-custom-openai-my-model]');
    expect(toml).toContain('[models.okit-custom-openai-my-model-lite]');
    expect(toml).toContain('[models.okit-custom-openai-my-model-pro]');
    expect(toml).toContain('default_model = "okit-custom-openai-my-model-pro"');
    expect(toml).toContain('display_name = "Custom OpenAI my-model-lite"');
  });

  it('includes the selected model even when it is not in the provider list', async () => {
    const adapter = new KimiCodeAdapter();
    await adapter.applyConfig(customProvider, 'remote-only-model');

    const toml = mocks.files.get(CONFIG_PATH)!;
    expect(toml).toContain('[models.okit-custom-openai-remote-only-model]');
    expect(toml).toContain('model = "remote-only-model"');
    expect(toml).toContain('default_model = "okit-custom-openai-remote-only-model"');
  });

  it('keeps OTHER sites tables intact when switching (multi-site additive)', async () => {
    mocks.files.set(CONFIG_PATH, [
      '[providers.okit-old-provider]',
      'type = "openai"',
      'base_url = "https://old.api.com/v1"',
      'api_key = "sk-old"',
      '',
      '[models.okit-old-provider-old-model]',
      'provider = "okit-old-provider"',
      'model = "old-model"',
      'protocol = "openai"',
      'max_context_size = 262144',
      '',
      '[thinking]',
      'enabled = true',
    ].join('\n'));

    const adapter = new KimiCodeAdapter();
    await adapter.applyConfig(customProvider, 'my-model');

    const toml = mocks.files.get(CONFIG_PATH)!;
    expect(toml).toContain('[providers.okit-old-provider]');
    expect(toml).toContain('sk-old');
    expect(toml).toContain('[models.okit-old-provider-old-model]');
    expect(toml).toContain('old-model');
    expect(toml).toContain('[thinking]');
    expect(toml).toContain('enabled = true');
    expect(toml).toContain('[providers.okit-custom-openai]');
    expect(toml).toContain('[models.okit-custom-openai-my-model]');
  });

  it('switching a provider rewrites only ITS OWN tables (stale same-provider models dropped)', async () => {
    mocks.files.set(CONFIG_PATH, [
      '[providers.okit-custom-openai]',
      'type = "openai"',
      'base_url = "https://old.api.com/v1"',
      'api_key = "sk-old"',
      '',
      '[models.okit-custom-openai-old-model]',
      'provider = "okit-custom-openai"',
      'model = "old-model"',
      'protocol = "openai"',
      'max_context_size = 262144',
      '',
      '[providers.okit-other-site]',
      'type = "openai"',
      'base_url = "https://other.api.com/v1"',
      'api_key = "sk-other"',
    ].join('\n'));

    const adapter = new KimiCodeAdapter();
    await adapter.applyConfig(customProvider, 'my-model');

    const toml = mocks.files.get(CONFIG_PATH)!;
    expect(toml).not.toContain('old-model');
    expect(toml).not.toContain('sk-old');
    expect(toml).toContain('[models.okit-custom-openai-my-model]');
    expect(toml).toContain('default_model = "okit-custom-openai-my-model"');
    expect(toml).toContain('[providers.okit-other-site]');
    expect(toml).toContain('sk-other');
  });

  it('does not write .env (api key lives inline in config.toml)', async () => {
    const adapter = new KimiCodeAdapter();
    await adapter.applyConfig(customProvider, 'my-model');

    expect(mocks.files.get(ENV_PATH)).toBeUndefined();
  });

  it('resolves official moonshot to providerId "kimi" with type kimi', async () => {
    const adapter = new KimiCodeAdapter();
    await adapter.applyConfig(moonshotProvider, 'moonshot-v1-128k');

    const toml = mocks.files.get(CONFIG_PATH)!;
    expect(toml).toContain('[providers.kimi]');
    expect(toml).toContain('type = "kimi"');
    expect(toml).toContain('protocol = "kimi"');
    expect(toml).toContain('api_key = "sk-test-123"');
    expect(toml).toContain('default_model = "okit-moonshot-moonshot-v1-128k"');
  });

  it('uses openai_responses type when endpoint protocol is responses', async () => {
    const responsesProvider = {
      ...customProvider,
      endpoints: [{ type: 'openai' as const, baseUrl: 'https://custom.api.com/v1', protocol: 'responses' as const }],
    };
    const adapter = new KimiCodeAdapter();
    await adapter.applyConfig(responsesProvider, 'my-model');

    const toml = mocks.files.get(CONFIG_PATH)!;
    expect(toml).toContain('type = "openai_responses"');
    expect(toml).toContain('protocol = "openai_responses"');
  });

  it('omits api_key line when the vault has no key', async () => {
    const noKeyProvider = { ...customProvider, vaultKey: 'MISSING_KEY' };
    const adapter = new KimiCodeAdapter();
    await adapter.applyConfig(noKeyProvider, 'my-model');

    const toml = mocks.files.get(CONFIG_PATH)!;
    expect(toml).toContain('type = "openai"');
    expect(toml).not.toContain('api_key =');
  });

  it('adds capabilities from model metadata', async () => {
    const reasoningProvider = {
      ...customProvider,
      models: [{ id: 'glm-5.2' }],
    };
    const adapter = new KimiCodeAdapter();
    await adapter.applyConfig(reasoningProvider, 'glm-5.2');

    const toml = mocks.files.get(CONFIG_PATH)!;
    expect(toml).toContain('capabilities = ["thinking"]');
    expect(toml).toContain('max_context_size = 1000000');

    const visionProvider = {
      ...customProvider,
      models: [{ id: 'glm-4.6v' }],
    };
    mocks.files.clear();
    await adapter.applyConfig(visionProvider, 'glm-4.6v');
    expect(mocks.files.get(CONFIG_PATH)!).toContain('capabilities = ["image_in"]');
  });

  it('pins max_output_size for qianfan ernie-5.1 (platform caps at 65536)', async () => {
    const qianfanProvider = {
      id: 'qianfan-coding',
      name: '百度千帆 Token Plan',
      type: 'openai' as const,
      baseUrl: 'https://qianfan.baidubce.com/v2/tokenplan/personal',
      vaultKey: 'TEST_API_KEY',
      authMode: 'api_key' as const,
      models: [{ id: 'ernie-5.1' }, { id: 'glm-5.2' }],
    };
    const adapter = new KimiCodeAdapter();
    await adapter.applyConfig(qianfanProvider, 'ernie-5.1');

    const toml = mocks.files.get(CONFIG_PATH)!;
    expect(toml).toContain('max_output_size = 65536');
    expect(toml).toContain('[models.okit-qianfan-coding-glm-5-2]');
    // Only capped models get the key — glm-5.2 stays uncapped.
    expect((toml.match(/max_output_size = 65536/g) || []).length).toBe(1);
  });

  it('maps thinking-named models to always_thinking', async () => {
    const provider = { ...customProvider, models: [{ id: 'kimi-k2-thinking-turbo' }] };
    const adapter = new KimiCodeAdapter();
    await adapter.applyConfig(provider, 'kimi-k2-thinking-turbo');

    const toml = mocks.files.get(CONFIG_PATH)!;
    expect(toml).toContain('"always_thinking"');
  });

  it('strips legacy v1 keys that the v2 engine ignores', async () => {
    mocks.files.set(CONFIG_PATH, [
      '# legacy v1 config',
      'default_thinking = true',
      'model = "glm-5.2"',
      'model_provider = "okit-qianfan-coding"',
      '',
      '[model_providers.okit-qianfan-coding]',
      'name = "百度千帆 Token Plan"',
      'base_url = "https://qianfan.baidubce.com/v2/tokenplan/personal"',
      'env_key = "OKIT_KIMI_CODE_QIANFAN_CODING_API_KEY"',
      'wire_api = "chat"',
    ].join('\n'));

    const adapter = new KimiCodeAdapter();
    await adapter.applyConfig(customProvider, 'my-model');

    const toml = mocks.files.get(CONFIG_PATH)!;
    expect(toml).not.toContain('model = "glm-5.2"');
    expect(toml).not.toContain('model_provider =');
    expect(toml).not.toContain('[model_providers');
    expect(toml).not.toContain('env_key =');
    expect(toml).not.toContain('wire_api =');
    expect(toml).toContain('default_thinking = true');
    expect(toml).toContain('default_model = "okit-custom-openai-my-model"');
  });

  it('records selection in user.json under "kimi-code" key', async () => {
    const adapter = new KimiCodeAdapter();
    await adapter.applyConfig(customProvider, 'my-model');

    expect(updateUserConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: { 'kimi-code': { providerId: 'custom-openai', modelId: 'my-model' } },
      }),
    );
  });
});

describe('KimiCodeAdapter multi-site (additive)', () => {
  it('applyModels writes provider + model tables without touching other sites or default_model', async () => {
    mocks.files.set(CONFIG_PATH, [
      '[providers.okit-other]',
      'type = "openai"',
      'base_url = "https://other.api.com/v1"',
      'api_key = "sk-other"',
      '',
      '[models.okit-other-other-model]',
      'provider = "okit-other"',
      'model = "other-model"',
      'protocol = "openai"',
      'max_context_size = 262144',
      '',
      'default_model = "okit-other-other-model"',
    ].join('\n'));

    const adapter = new KimiCodeAdapter();
    const result = await adapter.applyModels([
      { provider: customProvider, modelId: 'my-model' },
      { provider: customProvider, modelId: 'my-model-lite' },
    ]);

    expect(result.written).toEqual(['my-model', 'my-model-lite']);
    expect(result.skipped).toEqual([]);

    const toml = mocks.files.get(CONFIG_PATH)!;
    expect(toml).toContain('[providers.okit-custom-openai]');
    expect(toml).toContain('base_url = "https://custom.api.com/v1"');
    expect(toml).toContain('api_key = "sk-test-123"');
    expect(toml).toContain('[models.okit-custom-openai-my-model]');
    expect(toml).toContain('protocol = "openai"');
    expect(toml).toContain('[models.okit-custom-openai-my-model-lite]');
    // Other site untouched.
    expect(toml).toContain('[providers.okit-other]');
    expect(toml).toContain('sk-other');
    // Adding a site must not switch the default model.
    expect(toml).toContain('default_model = "okit-other-other-model"');
  });

  it('applyModels with empty entries returns empty', async () => {
    const adapter = new KimiCodeAdapter();
    const result = await adapter.applyModels([]);
    expect(result).toEqual({ written: [], skipped: [] });
  });

  it('listEnabledProviders returns provider ids present in config (kimi table → kimi-coding)', async () => {
    mocks.files.set(CONFIG_PATH, [
      '[providers.okit-custom-openai]',
      'type = "openai"',
      'base_url = "https://custom.api.com/v1"',
      'api_key = "sk-1"',
      '',
      '[providers.kimi]',
      'type = "kimi"',
      'base_url = "https://api.moonshot.ai/v1"',
      'api_key = "sk-2"',
      '',
      '[services.copilot]',
      'url = "https://example.com"',
    ].join('\n'));

    const adapter = new KimiCodeAdapter();
    const ids = await adapter.listEnabledProviders();
    expect(ids).toEqual(['custom-openai', 'kimi-coding']);
  });

  it('listEnabledProviders returns [] when config does not exist', async () => {
    const adapter = new KimiCodeAdapter();
    expect(await adapter.listEnabledProviders()).toEqual([]);
  });

  it('removeProvider strips only that provider and drops an owned default_model', async () => {
    mocks.files.set(CONFIG_PATH, [
      '[providers.okit-custom-openai]',
      'type = "openai"',
      'base_url = "https://custom.api.com/v1"',
      'api_key = "sk-1"',
      '',
      '[models.okit-custom-openai-my-model]',
      'provider = "okit-custom-openai"',
      'model = "my-model"',
      'protocol = "openai"',
      'max_context_size = 262144',
      '',
      '[providers.okit-other]',
      'type = "openai"',
      'base_url = "https://other.api.com/v1"',
      'api_key = "sk-other"',
      '',
      'default_model = "okit-custom-openai-my-model"',
      '',
      '[thinking]',
      'enabled = true',
    ].join('\n'));

    const adapter = new KimiCodeAdapter();
    await adapter.removeProvider('custom-openai');

    const toml = mocks.files.get(CONFIG_PATH)!;
    expect(toml).not.toContain('okit-custom-openai');
    expect(toml).not.toContain('sk-1');
    expect(toml).not.toContain('default_model');
    expect(toml).toContain('[providers.okit-other]');
    expect(toml).toContain('sk-other');
    expect(toml).toContain('[thinking]');
    expect(toml).toContain('enabled = true');
  });

  it('removeProvider for moonshot strips the kimi table + its models', async () => {
    mocks.files.set(CONFIG_PATH, [
      '[providers.kimi]',
      'type = "kimi"',
      'base_url = "https://api.moonshot.ai/v1"',
      'api_key = "sk-2"',
      '',
      '[models.okit-moonshot-moonshot-v1-128k]',
      'provider = "kimi"',
      'model = "moonshot-v1-128k"',
      'protocol = "kimi"',
      'max_context_size = 262144',
      '',
      'default_model = "okit-moonshot-moonshot-v1-128k"',
    ].join('\n'));

    const adapter = new KimiCodeAdapter();
    await adapter.removeProvider('moonshot');

    const toml = mocks.files.get(CONFIG_PATH)!;
    expect(toml).not.toContain('[providers.kimi]');
    expect(toml).not.toContain('okit-moonshot');
    expect(toml).not.toContain('default_model');
  });

  it('removeProvider is a no-op when the provider has no tables', async () => {
    mocks.files.set(CONFIG_PATH, '[thinking]\nenabled = true\n');
    const adapter = new KimiCodeAdapter();
    await adapter.removeProvider('custom-openai');
    expect(mocks.files.get(CONFIG_PATH)).toBe('[thinking]\nenabled = true\n');
  });

  describe('healModelFields', () => {
    const PROVIDERS_JSON = testRoot.PROVIDERS_PATH;

    it('restores model fields kimi stripped from non-default providers', async () => {
      mocks.files.set(PROVIDERS_JSON, JSON.stringify({
        providers: [
          {
            id: 'xiaomi-coding',
            name: '小米 MiMo',
            type: 'openai',
            baseUrl: 'https://x',
            vaultKey: 'TEST_API_KEY',
            authMode: 'api_key',
            models: [{ id: 'mimo-v2.5-pro' }, { id: 'mimo-v2.5' }],
          },
        ],
      }));
      // kimi's rewrite: default provider's entries keep `model`, others lose it.
      mocks.files.set(CONFIG_PATH, [
        'default_model = "okit-qianfan-coding-ernie-5-1"',
        '',
        '[providers.okit-xiaomi-coding]',
        'type = "openai"',
        'base_url = "https://x"',
        'api_key = "sk-1"',
        '',
        '[models.okit-xiaomi-coding-mimo-v2-5-pro]',
        'provider = "okit-xiaomi-coding"',
        'protocol = "openai"',
        'max_context_size = 1000000',
        'capabilities = [ "thinking" ]',
        '',
        '[models.okit-xiaomi-coding-mimo-v2-5]',
        'provider = "okit-xiaomi-coding"',
        'protocol = "openai"',
      ].join('\n'));

      const adapter = new KimiCodeAdapter();
      expect(await adapter.healModelFields()).toBe(true);

      const healed = mocks.files.get(CONFIG_PATH)!;
      expect(healed).toContain('[models.okit-xiaomi-coding-mimo-v2-5-pro]\nmodel = "mimo-v2.5-pro"');
      expect(healed).toContain('[models.okit-xiaomi-coding-mimo-v2-5]\nmodel = "mimo-v2.5"');
      expect(healed).toContain('capabilities = [ "thinking" ]');
      expect(healed).toContain('default_model = "okit-qianfan-coding-ernie-5-1"');
    });

    it('does not touch entries whose provider is unknown to OKIT', async () => {
      mocks.files.set(PROVIDERS_JSON, JSON.stringify({ providers: [] }));
      mocks.files.set(CONFIG_PATH, [
        '[models.okit-gone-ghost-1]',
        'provider = "okit-gone"',
        'protocol = "openai"',
      ].join('\n'));

      const adapter = new KimiCodeAdapter();
      expect(await adapter.healModelFields()).toBe(false);
      expect(mocks.files.get(CONFIG_PATH)).not.toContain('model =');
    });

    it('no-ops when nothing is stripped', async () => {
      mocks.files.set(PROVIDERS_JSON, JSON.stringify({ providers: [] }));
      mocks.files.set(CONFIG_PATH, [
        '[models.okit-xiaomi-coding-mimo-v2-5-pro]',
        'provider = "okit-xiaomi-coding"',
        'model = "mimo-v2.5-pro"',
        'protocol = "openai"',
      ].join('\n'));

      const adapter = new KimiCodeAdapter();
      expect(await adapter.healModelFields()).toBe(false);
    });

    it('prefers the longer provider id when one is a prefix of another', async () => {
      mocks.files.set(PROVIDERS_JSON, JSON.stringify({
        providers: [
          {
            id: 'xiaomi',
            name: '小米',
            type: 'openai',
            baseUrl: 'https://x',
            vaultKey: 'TEST_API_KEY',
            authMode: 'api_key',
            models: [{ id: 'mimo-v2.5' }],
          },
          {
            id: 'xiaomi-coding',
            name: '小米 MiMo',
            type: 'openai',
            baseUrl: 'https://x',
            vaultKey: 'TEST_API_KEY',
            authMode: 'api_key',
            models: [{ id: 'mimo-v2.5-pro' }],
          },
        ],
      }));
      mocks.files.set(CONFIG_PATH, [
        '[models.okit-xiaomi-coding-mimo-v2-5-pro]',
        'provider = "okit-xiaomi-coding"',
        'protocol = "openai"',
      ].join('\n'));

      const adapter = new KimiCodeAdapter();
      expect(await adapter.healModelFields()).toBe(true);
      expect(mocks.files.get(CONFIG_PATH)).toContain('model = "mimo-v2.5-pro"');
    });

    it('does not duplicate an existing model line', async () => {
      mocks.files.set(PROVIDERS_JSON, JSON.stringify({
        providers: [
          {
            id: 'xiaomi-coding',
            name: '小米 MiMo',
            type: 'openai',
            baseUrl: 'https://x',
            vaultKey: 'TEST_API_KEY',
            authMode: 'api_key',
            models: [{ id: 'mimo-v2.5-pro' }],
          },
        ],
      }));
      mocks.files.set(CONFIG_PATH, [
        '[models.okit-xiaomi-coding-mimo-v2-5-pro]',
        'provider = "okit-xiaomi-coding"',
        'model = "mimo-v2.5-pro"',
        'protocol = "openai"',
      ].join('\n'));

      const adapter = new KimiCodeAdapter();
      expect(await adapter.healModelFields()).toBe(false);
      const healed = mocks.files.get(CONFIG_PATH)!;
      expect((healed.match(/model = "mimo-v2\.5-pro"/g) || []).length).toBe(1);
    });
  });
});