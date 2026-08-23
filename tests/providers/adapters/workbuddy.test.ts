import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';

const testRoot = vi.hoisted(() => {
  const p = require('path');
  const d = '/tmp/test-okit-workbuddy';
  return {
    OKIT_DIR: d,
    REGISTRY_PATH: p.join(d, 'registry.json'),
    LOGS_DIR: p.join(d, 'logs'),
    CACHE_DIR: p.join(d, 'cache'),
  };
});

const mocks = vi.hoisted(() => {
  const files = new Map<string, string>();
  // Stateful stand-in for ~/.okit/user.json so managedModels tracking
  // persists across adapter calls within a test, like the real config.
  const userConfig: any = { providers: {} };
  return {
    files,
    userConfig,
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
  loadUserConfig: vi.fn(async function() { return mocks.userConfig; }),
  updateUserConfig: vi.fn(async function(patch: any) {
    // Mirror the real per-agent-key merge under `providers`.
    if (patch?.providers) {
      mocks.userConfig.providers = mocks.userConfig.providers || {};
      for (const [key, value] of Object.entries(patch.providers)) {
        mocks.userConfig.providers[key] = value;
      }
    }
    return mocks.userConfig;
  }),
}));

vi.mock('../../../src/vault/store', () => ({
  VaultStore: vi.fn().mockImplementation(function(this: any) {
    this.get = vi.fn(async function(key: string) { return key === 'TEST_API_KEY' ? 'sk-test-123' : undefined; });
  }),
}));

const { WorkBuddyAdapter } = await import('../../../src/providers/adapters/workbuddy');
const { resolveModelCapabilities } = await import('../../../src/providers/capabilities');

const MODELS_PATH = path.join(os.homedir(), '.workbuddy', 'models.json');

const testProvider = {
  id: 'glm-coding',
  name: 'GLM Coding Plan',
  type: 'openai' as const,
  baseUrl: 'https://open.bigmodel.cn/api/coding',
  vaultKey: 'TEST_API_KEY',
  authMode: 'api_key' as const,
  models: [{ id: 'glm-4.7', name: 'GLM-4.7' }, { id: 'glm-4.6', name: 'GLM-4.6' }],
};

const deepseekProvider = {
  ...testProvider,
  id: 'deepseek',
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek-V4 Pro' }],
};

const otherProvider = {
  ...testProvider,
  id: 'glm-coding-alt',
  name: 'GLM Coding Alt',
  models: [{ id: 'glm-4.7', name: 'GLM-4.7' }, { id: 'glm-x', name: 'GLM X' }],
};

function readModelsFile(): any[] {
  return JSON.parse(mocks.files.get(MODELS_PATH)!);
}

beforeEach(() => {
  mocks.files.clear();
  mocks.userConfig.providers = {};
});

describe('resolveModelCapabilities', () => {
  it('returns template-verified data for deepseek-v4-pro', () => {
    const caps = resolveModelCapabilities('deepseek-v4-pro');
    expect(caps).toEqual({
      supportsToolCall: true,
      supportsImages: false,
      supportsReasoning: true,
      reasoningEfforts: ['high', 'max'],
      defaultReasoningEffort: 'high',
      maxInputTokens: 1_000_000,
    });
  });

  it('applies family prefixes and conservative defaults', () => {
    expect(resolveModelCapabilities('glm-4.7').supportsReasoning).toBe(true);
    expect(resolveModelCapabilities('qwen-turbo').supportsReasoning).toBe(false);
    expect(resolveModelCapabilities('totally-unknown-model')).toEqual({
      supportsToolCall: true,
      supportsImages: false,
      supportsReasoning: false,
    });
  });
});

describe('WorkBuddyAdapter', () => {
  it('has correct id and name', () => {
    const adapter = new WorkBuddyAdapter();
    expect(adapter.id).toBe('workbuddy');
    expect(adapter.name).toBe('WorkBuddy');
  });

  it('supports anthropic/openai types', () => {
    const adapter = new WorkBuddyAdapter();
    expect(adapter.supportedTypes).toEqual(['anthropic', 'openai']);
  });
});

describe('WorkBuddyAdapter.applyConfig', () => {
  it('writes a top-level array entry with vendor, URL, key and capability flags', async () => {
    const adapter = new WorkBuddyAdapter();
    await adapter.applyConfig(testProvider, 'glm-4.7');

    const written = readModelsFile();
    expect(Array.isArray(written)).toBe(true);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      id: 'glm-4.7',
      name: 'GLM-4.7',
      vendor: 'GLM Coding Plan',
      url: 'https://open.bigmodel.cn/api/coding/chat/completions',
      apiKey: 'sk-test-123',
      supportsToolCall: true,
      supportsImages: false,
      supportsReasoning: true,
    });
    // No efforts configured for glm-4.7 → no reasoning object.
    expect(written[0].reasoning).toBeUndefined();
  });

  it('writes reasoning efforts and token limits where known', async () => {
    const adapter = new WorkBuddyAdapter();
    await adapter.applyConfig(deepseekProvider, 'deepseek-v4-pro');

    const written = readModelsFile();
    expect(written[0].reasoning).toEqual({ defaultEffort: 'high', supportedEfforts: ['high', 'max'] });
    expect(written[0].maxInputTokens).toBe(1_000_000);
  });

  it('overrides token windows with gateway limits for opencode.ai free models', async () => {
    const zenProvider = {
      ...testProvider,
      baseUrl: 'https://opencode.ai/zen/v1',
      models: [{ id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash' }],
    };
    const adapter = new WorkBuddyAdapter();
    await adapter.applyConfig(zenProvider, 'deepseek-v4-flash-free');

    const written = readModelsFile();
    // deepseek-v4 family caps would otherwise claim 1M input — gateway wins.
    expect(written[0].maxInputTokens).toBe(200000);
    expect(written[0].maxOutputTokens).toBe(128000);
  });

  it('writes openrouter :free output cap of 8192', async () => {
    const orProvider = {
      ...testProvider,
      baseUrl: 'https://openrouter.ai/api/v1',
      models: [{ id: 'cohere/north-mini-code:free' }],
    };
    const adapter = new WorkBuddyAdapter();
    await adapter.applyConfig(orProvider, 'cohere/north-mini-code:free');

    const written = readModelsFile();
    expect(written[0].maxInputTokens).toBe(256000);
    expect(written[0].maxOutputTokens).toBe(8192);
  });

  it('NEVER writes an availableModels field (whitelist semantics)', async () => {
    const adapter = new WorkBuddyAdapter();
    await adapter.applyConfig(testProvider, 'glm-4.7');
    const raw = JSON.parse(mocks.files.get(MODELS_PATH)!);
    expect(raw.availableModels).toBeUndefined();
    expect(raw.models).toBeUndefined();
  });

  it('normalizes a legacy {models, availableModels} wrapper to the native array', async () => {
    mocks.files.set(MODELS_PATH, JSON.stringify({
      models: [{ id: 'glm-4.7', name: 'Old', vendor: 'Old', url: 'https://open.bigmodel.cn/api/coding/chat/completions' }],
      availableModels: ['glm-4.7'],
    }));

    const adapter = new WorkBuddyAdapter();
    await adapter.applyConfig(testProvider, 'glm-4.7');

    const raw = JSON.parse(mocks.files.get(MODELS_PATH)!);
    expect(Array.isArray(raw)).toBe(true);
    expect(raw.availableModels).toBeUndefined();
    expect(raw[0].vendor).toBe('GLM Coding Plan');
  });

  it('does NOT append baseUrl /chat/completions if it already ends with it', async () => {
    const provider = { ...testProvider, baseUrl: 'https://open.bigmodel.cn/api/coding/chat/completions' };
    const adapter = new WorkBuddyAdapter();
    await adapter.applyConfig(provider, 'glm-4.7');

    const written = readModelsFile();
    expect(written[0].url).toBe('https://open.bigmodel.cn/api/coding/chat/completions');
  });

  it('records selection and managedModels in user.json', async () => {
    const adapter = new WorkBuddyAdapter();
    await adapter.applyConfig(testProvider, 'glm-4.7');

    expect(mocks.userConfig.providers.workbuddy).toEqual({
      providerId: 'glm-coding',
      modelId: 'glm-4.7',
      managedModels: { 'glm-coding': ['glm-4.7'] },
    });
  });

  it('REFUSES to overwrite an entry at a different endpoint (not written by OKIT)', async () => {
    mocks.files.set(MODELS_PATH, JSON.stringify([
      { id: 'glm-4.7', name: 'Official', vendor: 'WorkBuddy', url: 'https://old.com/chat/completions' },
    ]));

    const adapter = new WorkBuddyAdapter();
    await expect(adapter.applyConfig(testProvider, 'glm-4.7')).rejects.toThrow(/非 OKIT 写入/);

    const written = readModelsFile();
    expect(written[0].vendor).toBe('WorkBuddy');
    expect(mocks.userConfig.providers.workbuddy).toBeUndefined();
  });

  it('adopts an entry whose URL lacks the /chat/completions suffix (same endpoint base)', async () => {
    // WorkBuddy's template UI writes base URLs without the suffix.
    mocks.files.set(MODELS_PATH, JSON.stringify([
      { id: 'glm-4.7', name: 'Legacy', vendor: 'Old Name', url: 'https://open.bigmodel.cn/api/coding' },
    ]));

    const adapter = new WorkBuddyAdapter();
    await adapter.applyConfig(testProvider, 'glm-4.7');

    const written = readModelsFile();
    expect(written).toHaveLength(1);
    expect(written[0].vendor).toBe('GLM Coding Plan');
    expect(written[0].url).toBe('https://open.bigmodel.cn/api/coding/chat/completions');
    expect(mocks.userConfig.providers.workbuddy.managedModels).toEqual({ 'glm-coding': ['glm-4.7'] });
  });

  it('updates a managed entry in place (idempotent upsert)', async () => {
    const adapter = new WorkBuddyAdapter();
    await adapter.applyConfig(testProvider, 'glm-4.7');
    await adapter.applyConfig(testProvider, 'glm-4.7');

    const written = readModelsFile();
    expect(written).toHaveLength(1);
    expect(mocks.userConfig.providers.workbuddy.managedModels).toEqual({ 'glm-coding': ['glm-4.7'] });
  });
});

describe('WorkBuddyAdapter.applyModels', () => {
  it('writes every entry with capability flags, without moving the selection', async () => {
    const adapter = new WorkBuddyAdapter();
    const result = await adapter.applyModels([
      { provider: testProvider, modelId: 'glm-4.7' },
      { provider: testProvider, modelId: 'glm-4.6' },
    ]);

    expect(result.written).toEqual(['glm-4.7', 'glm-4.6']);
    expect(result.skipped).toEqual([]);

    const written = readModelsFile();
    expect(written.map(m => m.id).sort()).toEqual(['glm-4.6', 'glm-4.7']);
    for (const entry of written) {
      expect(entry.supportsToolCall).toBe(true);
      expect(typeof entry.supportsImages).toBe('boolean');
      expect(typeof entry.supportsReasoning).toBe('boolean');
    }
    expect(mocks.userConfig.providers.workbuddy.providerId).toBeUndefined();
    expect(mocks.userConfig.providers.workbuddy.managedModels).toEqual({
      'glm-coding': ['glm-4.7', 'glm-4.6'],
    });
  });

  it('preserves an existing selection', async () => {
    const adapter = new WorkBuddyAdapter();
    await adapter.applyConfig(testProvider, 'glm-4.7');
    await adapter.applyModels([{ provider: otherProvider, modelId: 'glm-x' }]);

    expect(mocks.userConfig.providers.workbuddy.providerId).toBe('glm-coding');
    expect(mocks.userConfig.providers.workbuddy.modelId).toBe('glm-4.7');
  });

  it('skips foreign id collisions instead of overwriting them', async () => {
    mocks.files.set(MODELS_PATH, JSON.stringify([
      { id: 'glm-4.7', name: 'Official', vendor: 'WorkBuddy', url: 'https://old.com/chat/completions', supportsToolCall: true },
    ]));

    const adapter = new WorkBuddyAdapter();
    const result = await adapter.applyModels([
      { provider: testProvider, modelId: 'glm-4.7' },
      { provider: testProvider, modelId: 'glm-4.6' },
    ]);

    expect(result.skipped).toEqual(['glm-4.7']);
    expect(result.written).toEqual(['glm-4.6']);

    const written = readModelsFile();
    expect(written.find(m => m.id === 'glm-4.7').vendor).toBe('WorkBuddy');
  });
});

describe('WorkBuddyAdapter.removeProvider', () => {
  it('removes the provider entries, managed record and clears the selection', async () => {
    const adapter = new WorkBuddyAdapter();
    await adapter.applyConfig(testProvider, 'glm-4.7');

    await adapter.removeProvider('glm-coding');

    const written = readModelsFile();
    expect(written).toEqual([]);
    expect(mocks.userConfig.providers.workbuddy.managedModels).toEqual({});
    expect(mocks.userConfig.providers.workbuddy.providerId).toBeUndefined();
  });

  it('keeps entries still claimed by another provider (shared model id)', async () => {
    const adapter = new WorkBuddyAdapter();
    await adapter.applyConfig(testProvider, 'glm-4.7');
    await adapter.applyModels([
      { provider: otherProvider, modelId: 'glm-4.7' },
      { provider: otherProvider, modelId: 'glm-x' },
    ]);

    await adapter.removeProvider('glm-coding');

    const written = readModelsFile();
    expect(written.map(m => m.id).sort()).toEqual(['glm-4.7', 'glm-x']);
    expect(mocks.userConfig.providers.workbuddy.managedModels).toEqual({
      'glm-coding-alt': ['glm-4.7', 'glm-x'],
    });
    expect(mocks.userConfig.providers.workbuddy.providerId).toBeUndefined();
  });

  it('does not touch foreign entries when removing', async () => {
    mocks.files.set(MODELS_PATH, JSON.stringify([
      { id: 'official-model', name: 'Official', vendor: 'WorkBuddy', url: 'https://official.example/chat/completions' },
    ]));
    const adapter = new WorkBuddyAdapter();
    await adapter.applyConfig(testProvider, 'glm-4.7');

    await adapter.removeProvider('glm-coding');

    const written = readModelsFile();
    expect(written.map(m => m.id)).toEqual(['official-model']);
  });

  it('is a no-op for an unknown provider', async () => {
    const adapter = new WorkBuddyAdapter();
    await adapter.removeProvider('never-added');

    expect(mocks.files.has(MODELS_PATH)).toBe(false);
    expect(mocks.userConfig.providers.workbuddy).toBeUndefined();
  });
});
