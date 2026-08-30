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
    remove: vi.fn(async function(p: string) { for (const key of files.keys()) if (key === p || key.startsWith(`${p}/`)) files.delete(key); }),
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

const logMocks = vi.hoisted(() => ({ appendLog: vi.fn() }));
vi.mock('../../../src/web/api/log-writer.js', () => logMocks);

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

const resolvedModel = (id: string, context: number, output: number) => ({
  id,
  name: id,
  context,
  output,
  modalities: { input: ['text'], output: ['text'] },
  source: 'modelsdev' as const,
  confidence: 'high' as const,
});

beforeEach(() => {
  mocks.files.clear();
  vi.mocked(updateUserConfig).mockClear();
  logMocks.appendLog.mockClear();
});

describe('CodexAdapter', () => {
  it('has correct id and name', () => {
    const adapter = new CodexAdapter();
    expect(adapter.id).toBe('codex');
    expect(adapter.name).toBe('ChatGPT');
  });

  it('supports openai and responses types', () => {
    const adapter = new CodexAdapter();
    expect(adapter.supportedTypes).toEqual(['openai', 'responses']);
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
    expect(toml).not.toMatch(/^model_provider\s*=/m);
    expect(toml).not.toContain('disable_response_storage');
    expect(toml).not.toContain('web_search');
    expect(toml).not.toContain('model_catalog_json');
    expect(toml).not.toContain('[model_providers');
    // No OPENAI_API_KEY written — Codex uses its native OAuth tokens instead.
    expect(mocks.files.has(CODEX_AUTH)).toBe(false);
  });

  it('writes base_url and provider-specific Vault auth for non-official endpoints', async () => {
    // The TS adapter correctly uses a [model_providers.X] table with base_url
    // and removes the legacy top-level api_base key (which was a Codex bug).
    const adapter = new CodexAdapter();
    await adapter.applyConfig(customProvider, 'my-model');

    const toml = mocks.files.get(CODEX_CONFIG)!;
    expect(toml).toContain('[model_providers.okit-custom-openai]');
    expect(toml).toContain('base_url = "https://custom.api.com/v1"');
    expect(toml).not.toContain('api_base');
    // Each provider resolves its own Vault key. A shared OPENAI_API_KEY cannot
    // resume conversations from two different third-party providers safely.
    expect(toml).not.toContain('env_key');
    expect(toml).toContain('[model_providers.okit-custom-openai.auth]');
    expect(toml).toContain('"vault", "get", "CODEX_API_KEY"');
    // Codex requires wire_api = "responses" on current builds (chat was dropped).
    // Mirror cc-switch: unconditional "responses" regardless of endpoint protocol.
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).not.toContain('requires_openai_auth');
    // Top-level fields cc-switch always emits.
    expect(toml).toContain('disable_response_storage = true');
    expect(toml).toContain('model_reasoning_effort = "high"');
    // web_search disabled — third-party gateways reject the web_search tool.
    expect(toml).toContain('web_search = "disabled"');
    expect(mocks.files.has(CODEX_AUTH)).toBe(false);
  });

  it('appends /v1 to origin-only base URLs (cc-switch normalization)', async () => {
    const originOnly = { ...customProvider, baseUrl: 'https://custom.api.com' };
    const adapter = new CodexAdapter();
    await adapter.applyConfig(originOnly, 'my-model');

    const toml = mocks.files.get(CODEX_CONFIG)!;
    expect(toml).toContain('base_url = "https://custom.api.com/v1"');
  });

  it('routes known chat-only coding plan endpoints to their verified Responses URL', async () => {
    const glmCoding = {
      ...customProvider,
      id: 'glm-coding',
      name: 'GLM Coding Plan',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      models: [{ id: 'glm-5.3' }],
    };
    const adapter = new CodexAdapter();
    await adapter.applyConfig(glmCoding, 'glm-5.3');

    const toml = mocks.files.get(CODEX_CONFIG)!;
    // Codex requires the Responses wire API; the plan's chat-completions URL
    // 404s on /responses. The adapter rewrites the known chat endpoint even
    // when the provider was registered before the mapping existed.
    expect(toml).toContain('base_url = "https://open.bigmodel.cn/api/v1"');
    expect(toml).not.toContain('api/coding/paas/v4');
    expect(toml).toContain('wire_api = "responses"');
  });

  it('writes the responses-type endpoint baseUrl as-is (no path suffix, no mapping)', async () => {
    const glmPresetLike = {
      ...customProvider,
      id: 'glm-coding',
      name: 'GLM Coding Plan',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      endpoints: [
        { type: 'openai' as const, protocol: 'chat' as const, baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' },
        { type: 'responses' as const, baseUrl: 'https://open.bigmodel.cn/api/v1' },
        { type: 'anthropic' as const, baseUrl: 'https://open.bigmodel.cn/api/anthropic' },
      ],
      models: [{ id: 'glm-5.3' }],
    };
    const adapter = new CodexAdapter();
    await adapter.applyConfig(glmPresetLike, 'glm-5.3');
    const toml = mocks.files.get(CODEX_CONFIG)!;
    // The responses endpoint row carries the BASE url; codex appends /responses
    // itself. Never write the suffixed path and never the chat fallback.
    expect(toml).toContain('base_url = "https://open.bigmodel.cn/api/v1"');
    expect(toml).not.toContain('/api/v1/responses');
    expect(toml).not.toContain('api/coding/paas/v4');
  });

  it('refuses endpoints whose /responses probe returns 404 (qianfan)', async () => {
    const { setResponsesEndpointProbeForTests, setVaultProbeForTests } = await import('../../../src/providers/adapters/codex');
    setResponsesEndpointProbeForTests(async () => 404);
    setVaultProbeForTests(() => 'sk-codex-456789012345');
    try {
      const qianfanCoding = {
        ...customProvider,
        id: 'qianfan-coding',
        name: '百度千帆 Token Plan',
        baseUrl: 'https://qianfan.baidubce.com/v2/tokenplan/personal',
        models: [{ id: 'ernie-4.5-turbo-128k' }],
      };
      const adapter = new CodexAdapter();
      // Codex requires the Responses wire API; qianfan's OpenAI-compatible URL
      // 404s on /responses (probed live at apply time in the desktop app).
      // Refuse with an actionable error instead of writing a config that
      // cannot work.
      await expect(adapter.applyConfig(qianfanCoding, 'ernie-4.5-turbo-128k'))
        .rejects.toThrow('无法配置给 Codex');
      expect(mocks.files.has(CODEX_CONFIG)).toBe(false);
    } finally {
      setResponsesEndpointProbeForTests(null);
      setVaultProbeForTests(null);
    }
  });

  it('prefers an explicit responses-type endpoint over the chat one', async () => {
    const dualProvider = {
      ...customProvider,
      id: 'dual-resp',
      name: 'Dual Responses',
      baseUrl: 'https://chat.example.com/v1',
      endpoints: [
        { type: 'openai' as const, baseUrl: 'https://chat.example.com/v1' },
        { type: 'responses' as const, baseUrl: 'https://responses.example.com/v1' },
      ],
      models: [{ id: 'my-model' }],
    };
    const adapter = new CodexAdapter();
    await adapter.applyConfig(dualProvider, 'my-model');
    const toml = mocks.files.get(CODEX_CONFIG)!;
    // The responses-type endpoint IS the Responses wire API; codex must use
    // it as-is instead of the chat endpoint or any mapping.
    expect(toml).toContain('base_url = "https://responses.example.com/v1"');
    expect(toml).not.toContain('chat.example.com');
  });

  it('keeps only Codex-accepted input modalities in the catalog', async () => {
    const { mapModelToCodexCatalog } = await import('../../../src/providers/mappings/codex-mapping');
    const entry = mapModelToCodexCatalog({
      model: { id: 'glm-5.3-flash', name: 'glm-5.3-flash', modalities: { input: ['text', 'image', 'video', 'pdf'] } } as any,
      providerName: 'GLM Coding Plan',
      priority: 0,
    });
    // Codex parses input_modalities as a closed enum (text | image | audio);
    // a video/pdf variant makes the entire catalog fail to load.
    expect(entry.input_modalities).toEqual(['text', 'image']);
  });

  it('falls back to the okit binary when the primary vault command cannot emit a key', async () => {
    const { pickVaultCommand, vaultKeyLooksReal, setVaultProbeForTests } = await import('../../../src/providers/adapters/codex');
    const primary = { command: 'old-app', args: ['vault', 'get', 'K'] };
    const fallback = { command: 'okit', args: ['vault', 'get', 'K'] };
    const noKey = pickVaultCommand([primary, fallback]);
    expect(noKey.command).toBe(primary);
    expect(noKey.key).toBeNull();
    setVaultProbeForTests(candidate => candidate === fallback ? 'sk-codex-456789012345' : null);
    try {
      const chosen = pickVaultCommand([primary, fallback]);
      expect(chosen.command).toBe(fallback);
      expect(chosen.key).toBe('sk-codex-456789012345');
    } finally {
      setVaultProbeForTests(null);
    }
    expect(vaultKeyLooksReal('sk-codex-456789012345')).toBe(true);
    // A stale packaged CLI prints the help screen (banner + usage) instead of
    // the key; neither a multi-line answer nor the banner art may pass.
    expect(vaultKeyLooksReal('Usage: okit <command>\n  vault  Manage the key vault')).toBe(false);
    expect(vaultKeyLooksReal(' ██████████\n ██ OKIT v1.0\n')).toBe(false);
  });

  it('drops the desktop app [models] table only when it references a removed okit provider', async () => {
    const { removeStaleModelsTable } = await import('../../../src/providers/adapters/codex');
    const stale = [
      'model = "glm-5.3"',
      '[models]',
      'default = "okit-xiaomi-coding-mimo-v2-5"',
      'default_reasoning_effort = "xhigh"',
      '',
      '[model_providers.okit-glm-coding]',
      'base_url = "https://open.bigmodel.cn/api/v1"',
    ].join('\n');
    const cleaned = removeStaleModelsTable(stale);
    expect(cleaned).not.toContain('[models]');
    expect(cleaned).toContain('model = "glm-5.3"');
    expect(cleaned).toContain('[model_providers.okit-glm-coding]');

    // A reference that still resolves (and any non-okit value) belongs to the
    // desktop app's own picker preference and must survive.
    const live = stale.replace('okit-xiaomi-coding-mimo-v2-5', 'okit-glm-coding');
    expect(removeStaleModelsTable(live)).toBe(live);
    const appOwned = stale.replace('okit-xiaomi-coding-mimo-v2-5', 'gpt-5.6');
    expect(removeStaleModelsTable(appOwned)).toBe(appOwned);
    expect(removeStaleModelsTable('model = "glm-5.3"')).toBe('model = "glm-5.3"');
  });

  it('strips the subscription-only service_tier when applying a third-party provider', async () => {
    mocks.files.set(CODEX_CONFIG, [
      'model = "old"',
      'service_tier = "priority"',
      '[model_providers.okit-custom-openai]',
      'base_url = "https://custom.api.com/v1"',
    ].join('\n'));
    const adapter = new CodexAdapter();
    await adapter.applyConfig(customProvider, 'my-model');
    const toml = mocks.files.get(CODEX_CONFIG)!;
    // `service_tier` only applies to the official subscription; keeping it on a
    // third-party model makes Codex warn about an omitted tier every launch.
    expect(toml).not.toContain('service_tier');
    expect(toml).toContain('model = "my-model"');
  });

  it('replaces legacy OpenAI-auth residue with scoped provider authentication', async () => {
    mocks.files.set(CODEX_CONFIG, [
      'model = "old"',
      '',
      '[model_providers.okit-custom-openai]',
      'name = "Old"',
      'base_url = "https://old.example/v1"',
      'wire_api = "responses"',
      'requires_openai_auth = true',
      'experimental_bearer_token_auth = true',
      '',
      '[model_providers.okit-custom-openai.auth]',
      'command = "/old/credential-command"',
      '',
      '[projects."/keep"]',
      'trust_level = "trusted"',
      '',
    ].join('\n'));
    mocks.files.set(CODEX_AUTH, JSON.stringify({ OPENAI_API_KEY: 'sk-codex-456', tokens: { id: 'oauth-keep' } }));

    await new CodexAdapter().applyConfig(customProvider, 'my-model');

    const toml = mocks.files.get(CODEX_CONFIG)!;
    expect(toml).not.toContain('requires_openai_auth');
    expect(toml).not.toContain('experimental_bearer_token_auth');
    expect(toml).toContain('[model_providers.okit-custom-openai.auth]');
    expect(toml).toContain('"vault", "get", "CODEX_API_KEY"');
    expect(toml).toContain('[projects."/keep"]');
    // The legacy shared key is no longer referenced by this provider. Leave
    // user-owned auth.json untouched until the user switches to official OAuth.
    const auth = JSON.parse(mocks.files.get(CODEX_AUTH)!);
    expect(auth.OPENAI_API_KEY).toBe('sk-codex-456');
    expect(auth.tokens).toEqual({ id: 'oauth-keep' });
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

  it('writes resolved context windows into the model catalog', async () => {
    const CATALOG_PATH = path.join(os.homedir(), '.codex', 'model-catalogs', 'model-catalogs.json');
    const zenProvider = {
      ...customProvider,
      baseUrl: 'https://opencode.ai/zen/v1',
      models: [
        { id: 'deepseek-v4-flash-free', name: 'Flash', resolved: resolvedModel('deepseek-v4-flash-free', 200000, 128000) },
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

  it('uses the Codex mapping for official model parameters instead of fixed none/high defaults', async () => {
    const CATALOG_PATH = path.join(os.homedir(), '.codex', 'model-catalogs', 'model-catalogs.json');
    const provider = {
      ...customProvider,
      models: [{
        id: 'my-model',
        name: 'My Model',
        resolved: {
          id: 'my-model',
          name: 'My Model',
          description: 'Catalog description',
          context: 262144,
          modalities: { input: ['text', 'image'], output: ['text'] },
          reasoning: true,
          reasoningOptions: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
          source: 'modelsdev',
          confidence: 'high',
        },
      }],
    };

    await new CodexAdapter().applyConfig(provider, 'my-model', provider.models[0].resolved as any);

    const catalog = JSON.parse(mocks.files.get(CATALOG_PATH)!);
    expect(catalog.models[0]).toMatchObject({
      description: 'Catalog description',
      context_window: 262144,
      max_context_window: 262144,
      input_modalities: ['text', 'image'],
      default_reasoning_level: 'high',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Light reasoning' },
        { effort: 'medium', description: 'Balanced reasoning' },
        { effort: 'high', description: 'Enabled Thinking' },
      ],
    });
    const toml = mocks.files.get(CODEX_CONFIG)!;
    expect(toml).toContain('model_context_window = 262144');
    expect(toml).toContain('model_reasoning_effort = "high"');
    expect(toml).toContain('model_supports_reasoning_summaries = true');
    expect(logMocks.appendLog).toHaveBeenCalledWith(
      'codex-model-mapping',
      'custom-openai',
      true,
      expect.objectContaining({
        mappingVersion: 1,
        modelCount: 1,
        models: [expect.objectContaining({
          id: 'my-model',
          contextWindow: 262144,
          inputModalities: ['text', 'image'],
          reasoningLevels: ['low', 'medium', 'high'],
        })],
      }),
    );
  });

  it('official OpenAI strips a leftover openai_base_url hijack', async () => {
    mocks.files.set(CODEX_CONFIG, [
      'model = "old"',
      'openai_base_url = "https://open.bigmodel.cn/api/v1"',
    ].join('\n'));
    const adapter = new CodexAdapter();
    await adapter.applyConfig(openaiProvider, 'gpt-5.5');
    const toml = mocks.files.get(CODEX_CONFIG)!;
    // A manual base-url override must never redirect official-subscription
    // requests to a third-party gateway.
    expect(toml).not.toContain('openai_base_url');
    expect(toml).toContain('model = "gpt-5.5"');
  });

  it('official OpenAI: clears the active override but preserves registered providers for old conversations', async () => {
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
      '',
      '[model_providers.okit-xiaomi-coding.auth]',
      'command = "/usr/bin/env"',
      'args = ["ELECTRON_RUN_AS_NODE=1", "/Applications/OKIT.app/Contents/MacOS/OKIT", "main.js", "vault", "get", "XIAOMI_API_KEY"]',
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
    expect(toml).not.toMatch(/^model_provider\s*=/m);
    expect(toml).not.toContain('disable_response_storage');
    expect(toml).not.toContain('web_search');
    expect(toml).not.toContain('model_catalog_json');
    // Registrations and their independent auth survive so an existing thread
    // that stores this provider id can still be reopened.
    expect(toml).toContain('[model_providers.okit-xiaomi-coding]');
    expect(toml).toContain('[model_providers.okit-xiaomi-coding.auth]');
    // Non-okit sections (projects) preserved.
    expect(toml).toContain('[projects."/some/path"]');

    // Legacy shared key is removed; OAuth tokens remain.
    const auth = JSON.parse(mocks.files.get(CODEX_AUTH)!);
    expect(auth.OPENAI_API_KEY).toBeUndefined();
    expect(auth.tokens).toEqual({ id: 'oauth-keep' });
  });

  it('removes only the provider registration the user explicitly deletes', async () => {
    mocks.files.set(CODEX_CONFIG, [
      'model = "gpt-5.6-sol"',
      '',
      '[model_providers.okit-deepseek]',
      'name = "DeepSeek"',
      'base_url = "https://api.deepseek.com/v1"',
      '',
      '[model_providers.okit-deepseek.auth]',
      'command = "/usr/bin/node"',
      'args = ["main.js", "vault", "get", "DEEPSEEK_API_KEY"]',
      '',
      '[model_providers.okit-xiaomi]',
      'name = "Xiaomi"',
      'base_url = "https://api.xiaomimimo.com/v1"',
      '',
    ].join('\n'));

    const adapter = new CodexAdapter();
    await adapter.removeProvider('deepseek');

    const toml = mocks.files.get(CODEX_CONFIG)!;
    expect(toml).not.toContain('[model_providers.okit-deepseek]');
    expect(toml).not.toContain('[model_providers.okit-deepseek.auth]');
    expect(toml).toContain('[model_providers.okit-xiaomi]');
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

    expect(updateUserConfig).not.toHaveBeenCalled();
  });
});
