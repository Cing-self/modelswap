import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';

const testRoot = vi.hoisted(() => {
  const p = require('path');
  const d = '/tmp/test-okit-codex';
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
    this.get = vi.fn(async function(key: string) { return key === 'CODEX_API_KEY' ? 'sk-codex-456' : undefined; });
  }),
}));

vi.mock('../../../src/providers/auth', () => ({
  checkCodexOAuth: vi.fn(async function() { return false; }),
}));

const { CodexAdapter } = await import('../../../src/providers/adapters/codex');
const { updateUserConfig } = await import('../../../src/config/user');

const CODEX_DIR = path.join(os.homedir(), '.codex');
const CODEX_CONFIG = path.join(CODEX_DIR, 'config.toml');
const CODEX_AUTH = path.join(CODEX_DIR, 'auth.json');

const openaiProvider = {
  id: 'openai',
  name: 'OpenAI',
  type: 'openai' as const,
  baseUrl: 'https://api.openai.com/v1',
  vaultKey: 'CODEX_API_KEY',
  authMode: 'both' as const,
  models: [{ id: 'gpt-5.5' }],
};

const customProvider = {
  id: 'custom-openai',
  name: 'Custom OpenAI',
  type: 'openai' as const,
  baseUrl: 'https://custom.api.com/v1',
  vaultKey: 'CODEX_API_KEY',
  authMode: 'api_key' as const,
  models: [{ id: 'my-model' }],
};

beforeEach(() => {
  mocks.files.clear();
  vi.mocked(updateUserConfig).mockClear();
});

describe('CodexAdapter', () => {
  it('has correct id and name', () => {
    const adapter = new CodexAdapter();
    expect(adapter.id).toBe('codex');
    expect(adapter.name).toBe('ChatGPT');
  });

  it('supports openai type only', () => {
    const adapter = new CodexAdapter();
    expect(adapter.supportedTypes).toEqual(['openai']);
  });
});

describe('CodexAdapter.applyConfig', () => {
  it('writes model to config.toml', async () => {
    const adapter = new CodexAdapter();
    await adapter.applyConfig(openaiProvider, 'gpt-5.5');

    const toml = mocks.files.get(CODEX_CONFIG)!;
    expect(toml).toContain('model = "gpt-5.5"');
  });

  it('official OpenAI subscription: writes ONLY model, strips third-party residue, no auth.json key', async () => {
    const adapter = new CodexAdapter();
    await adapter.applyConfig(openaiProvider, 'gpt-5.5');

    const toml = mocks.files.get(CODEX_CONFIG)!;
    expect(toml).toContain('model = "gpt-5.5"');
    // Official OAuth mode: no model_provider, no third-party-only fields.
    expect(toml).not.toContain('model_provider');
    expect(toml).not.toContain('disable_response_storage');
    expect(toml).not.toContain('web_search');
    expect(toml).not.toContain('model_catalog_json');
    expect(toml).not.toContain('[model_providers');
    // No OPENAI_API_KEY written — Codex uses its native OAuth tokens instead.
    expect(mocks.files.has(CODEX_AUTH)).toBe(false);
  });

  it('writes base_url under [model_providers.X] for non-official endpoints (not top-level api_base)', async () => {
    // The TS adapter correctly uses a [model_providers.X] table with base_url
    // and removes the legacy top-level api_base key (which was a Codex bug).
    const adapter = new CodexAdapter();
    await adapter.applyConfig(customProvider, 'my-model');

    const toml = mocks.files.get(CODEX_CONFIG)!;
    expect(toml).toContain('[model_providers.okit-custom-openai]');
    expect(toml).toContain('base_url = "https://custom.api.com/v1"');
    expect(toml).not.toContain('api_base');
    // No env_key — credentials go via auth.json (requires_openai_auth=true),
    // so the ChatGPT desktop app can find them too.
    expect(toml).not.toContain('env_key');
    // Codex requires wire_api = "responses" on current builds (chat was dropped).
    // Mirror cc-switch: unconditional "responses" regardless of endpoint protocol.
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).toContain('requires_openai_auth = true');
    // Top-level fields cc-switch always emits.
    expect(toml).toContain('disable_response_storage = true');
    expect(toml).toContain('model_reasoning_effort = "high"');
    // web_search disabled — third-party gateways reject the web_search tool.
    expect(toml).toContain('web_search = "disabled"');
    // auth.json gets the key for third-party providers too.
    const auth = JSON.parse(mocks.files.get(CODEX_AUTH)!);
    expect(auth.OPENAI_API_KEY).toBe('sk-codex-456');
  });

  it('appends /v1 to origin-only base URLs (cc-switch normalization)', async () => {
    const originOnly = { ...customProvider, baseUrl: 'https://custom.api.com' };
    const adapter = new CodexAdapter();
    await adapter.applyConfig(originOnly, 'my-model');

    const toml = mocks.files.get(CODEX_CONFIG)!;
    expect(toml).toContain('base_url = "https://custom.api.com/v1"');
  });

  it('adds opencode UA via http_headers for opencode.ai gateway endpoints', async () => {
    const zenProvider = { ...customProvider, baseUrl: 'https://opencode.ai/zen/v1' };
    const adapter = new CodexAdapter();
    await adapter.applyConfig(zenProvider, 'my-model');

    const toml = mocks.files.get(CODEX_CONFIG)!;
    expect(toml).toContain('[model_providers.okit-custom-openai]');
    expect(toml).toContain('http_headers = { "User-Agent" = "opencode/1.18.15" }');
    expect(toml).toContain('base_url = "https://opencode.ai/zen/v1"');
  });

  it('does not add http_headers for non-opencode endpoints', async () => {
    const adapter = new CodexAdapter();
    await adapter.applyConfig(customProvider, 'my-model');

    const toml = mocks.files.get(CODEX_CONFIG)!;
    expect(toml).not.toContain('http_headers');
  });

  it('writes gateway context windows into the model catalog', async () => {
    const CATALOG_PATH = path.join(os.homedir(), '.codex', 'model-catalogs', 'model-catalogs.json');
    const zenProvider = {
      ...customProvider,
      baseUrl: 'https://opencode.ai/zen/v1',
      models: [
        { id: 'deepseek-v4-flash-free', name: 'Flash' },
        { id: 'plain-model', name: 'Plain' },
      ],
    };
    const adapter = new CodexAdapter();
    await adapter.applyConfig(zenProvider, 'deepseek-v4-flash-free');

    const catalog = JSON.parse(mocks.files.get(CATALOG_PATH)!);
    const bySlug = Object.fromEntries(catalog.models.map((m: any) => [m.slug, m]));
    expect(bySlug['deepseek-v4-flash-free'].context_window).toBe(200000);
    expect(bySlug['deepseek-v4-flash-free'].max_context_window).toBe(200000);
    // Unknown models keep the conservative default.
    expect(bySlug['plain-model'].context_window).toBe(128000);
  });

  it('writes model-catalogs.json with all provider models for /model switching', async () => {
    const CATALOG_PATH = path.join(os.homedir(), '.codex', 'model-catalogs', 'model-catalogs.json');
    const multiModel = {
      ...customProvider,
      models: [
        { id: 'm-flash', name: 'Flash' },
        { id: 'm-pro', name: 'Pro' },
      ],
    };
    const adapter = new CodexAdapter();
    await adapter.applyConfig(multiModel, 'm-flash');

    // catalog file written
    const catalog = JSON.parse(mocks.files.get(CATALOG_PATH)!);
    expect(catalog.models).toHaveLength(2);
    expect(catalog.models[0].slug).toBe('m-flash');
    expect(catalog.models[0].display_name).toBe('Flash');
    expect(catalog.models[1].slug).toBe('m-pro');
    // web_search tool disabled for third-party compatibility
    expect(catalog.models[0].supports_search_tool).toBe(false);

    // config.toml points at the catalog
    const toml = mocks.files.get(CODEX_CONFIG)!;
    expect(toml).toContain('model_catalog_json = "~/.codex/model-catalogs/model-catalogs.json"');
  });

  it('official OpenAI: strips third-party residue when switching back to subscription', async () => {
    // Start with a config that has third-party gunk from a previous provider.
    mocks.files.set(CODEX_CONFIG, [
      'model = "mimo-v2.5"',
      'model_provider = "okit-xiaomi-coding"',
      'model_reasoning_effort = "high"',
      'disable_response_storage = true',
      'web_search = "disabled"',
      'model_catalog_json = "~/.codex/model-catalogs/model-catalogs.json"',
      '',
      '[model_providers.okit-xiaomi-coding]',
      'name = "小米 MiMo Token Plan"',
      'base_url = "https://token-plan-sgp.xiaomimimo.com/v1"',
      'wire_api = "responses"',
      'requires_openai_auth = true',
      '',
      '[projects."/some/path"]',
      'trust_level = "trusted"',
      '',
    ].join('\n'));
    // And auth.json has a third-party key.
    mocks.files.set(CODEX_AUTH, JSON.stringify({ OPENAI_API_KEY: 'sk-third-party', tokens: { id: 'oauth-keep' } }));

    const adapter = new CodexAdapter();
    await adapter.applyConfig(openaiProvider, 'gpt-5.6-sol');

    const toml = mocks.files.get(CODEX_CONFIG)!;
    expect(toml).toContain('model = "gpt-5.6-sol"');
    // Third-party fields removed.
    expect(toml).not.toContain('model_provider');
    expect(toml).not.toContain('disable_response_storage');
    expect(toml).not.toContain('web_search');
    expect(toml).not.toContain('model_catalog_json');
    // All okit-* provider tables purged.
    expect(toml).not.toContain('[model_providers.okit-');
    // Non-okit sections (projects) preserved.
    expect(toml).toContain('[projects."/some/path"]');

    // auth.json: OPENAI_API_KEY removed, OAuth tokens preserved.
    const auth = JSON.parse(mocks.files.get(CODEX_AUTH)!);
    expect(auth.OPENAI_API_KEY).toBeUndefined();
    expect(auth.tokens).toEqual({ id: 'oauth-keep' });
  });

  it('removes api_base for official OpenAI', async () => {
    mocks.files.set(CODEX_CONFIG, 'model = "old"\napi_base = "https://old.com"\n');

    const adapter = new CodexAdapter();
    await adapter.applyConfig(openaiProvider, 'gpt-5.5');

    const toml = mocks.files.get(CODEX_CONFIG)!;
    expect(toml).toContain('model = "gpt-5.5"');
    expect(toml).not.toContain('api_base');
  });

  it('updates existing model field in toml', async () => {
    mocks.files.set(CODEX_CONFIG, 'model = "old-model"\nsome_other = "value"\n');

    const adapter = new CodexAdapter();
    await adapter.applyConfig(openaiProvider, 'gpt-5.5');

    const toml = mocks.files.get(CODEX_CONFIG)!;
    expect(toml).toContain('model = "gpt-5.5"');
    expect(toml).toContain('some_other = "value"');
  });

  it('updates user config with codex selection', async () => {
    const adapter = new CodexAdapter();
    await adapter.applyConfig(openaiProvider, 'gpt-5.5');

    expect(updateUserConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: { codex: { providerId: 'openai', modelId: 'gpt-5.5' } },
      }),
    );
  });
});
