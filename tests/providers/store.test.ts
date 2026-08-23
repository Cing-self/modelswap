import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import { PRESET_PROVIDERS } from '../../src/providers/presets';

const testRoot = vi.hoisted(() => {
  const p = require('path');
  const d = '/tmp/test-okit-providers';
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
    pathExists: vi.fn(async (p: string) => files.has(p)),
    readFile: vi.fn(async (p: string) => files.get(p) ?? ''),
    writeFile: vi.fn(async (p: string, c: string) => { files.set(p, c); }),
    rename: vi.fn(async (oldPath: string, newPath: string) => { const c = files.get(oldPath); if (c !== undefined) files.set(newPath, c); }),
    ensureDir: vi.fn(async () => {}),
  };
});

vi.mock('fs-extra', () => ({ default: mocks }));

vi.mock('../../src/config/registry', () => ({
  OKIT_DIR: testRoot.OKIT_DIR,
  REGISTRY_PATH: testRoot.REGISTRY_PATH,
  LOGS_DIR: testRoot.LOGS_DIR,
  CACHE_DIR: testRoot.CACHE_DIR,
}));

const { loadProviders, saveProviders, getProvider, addProvider, deleteProvider } = await import('../../src/providers/store');

const PROVIDERS_PATH = testRoot.PROVIDERS_PATH;

const sampleProvider = {
  id: 'test-provider',
  name: 'Test Provider',
  type: 'anthropic' as const,
  baseUrl: 'https://api.test.com',
  authMode: 'api_key' as const,
  models: [{ id: 'model-1' }, { id: 'model-2' }],
};

beforeEach(() => {
  mocks.files.clear();
});

describe('loadProviders', () => {
  it('returns preset providers when file does not exist', async () => {
    const result = await loadProviders();
    expect(result.length).toBeGreaterThan(0);
    // Verify presets were saved
    const saved = mocks.files.get(PROVIDERS_PATH);
    expect(saved).toBeTruthy();
  });

  it('loads providers from valid JSON', async () => {
    mocks.files.set(PROVIDERS_PATH, JSON.stringify({ providers: [sampleProvider] }));
    const result = await loadProviders();
    expect(result.length).toBe(PRESET_PROVIDERS.length + 1);
    expect(result[0].id).toBe('test-provider');
    expect(result[0].models.length).toBe(2);
  });

  it('updates only an unchanged stale Token Plan model snapshot', async () => {
    mocks.files.set(PROVIDERS_PATH, JSON.stringify({
      providers: [{
        id: 'qwen-token-plan',
        name: '阿里云百炼 Token Plan',
        type: 'openai',
        baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        authMode: 'api_key',
        models: [
          { id: 'qwen3.8-max' },
          { id: 'qwen3.7-max' },
          { id: 'qwen3.7-plus' },
          { id: 'qwen3.6-plus' },
          { id: 'qwen3-coder-plus' },
        ],
      }],
    }));

    const result = await loadProviders();
    const tokenPlan = result.find(provider => provider.id === 'qwen-token-plan')!;
    expect(tokenPlan.models.map(model => model.id)).toContain('qwen3.8-max-preview');
    expect(tokenPlan.models.map(model => model.id)).not.toContain('qwen3.8-max');
  });

  it('preserves a user-curated Token Plan model list', async () => {
    mocks.files.set(PROVIDERS_PATH, JSON.stringify({
      providers: [{
        id: 'qwen-token-plan',
        name: '阿里云百炼 Token Plan',
        type: 'openai',
        baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        authMode: 'api_key',
        models: [{ id: 'my-private-model' }],
      }],
    }));

    const result = await loadProviders();
    expect(result.find(provider => provider.id === 'qwen-token-plan')?.models)
      .toEqual([{ id: 'my-private-model' }]);
  });

  it('fails loudly for invalid JSON so corrupted data is not overwritten', async () => {
    mocks.files.set(PROVIDERS_PATH, 'not json');
    await expect(loadProviders()).rejects.toThrow('无法读取 providers.json');
  });

  it('filters out invalid providers', async () => {
    mocks.files.set(PROVIDERS_PATH, JSON.stringify({
      providers: [
        sampleProvider,
        { id: 'bad', name: 123 }, // invalid: name is not string
        { id: 'also-bad' },       // invalid: missing fields
      ],
    }));
    const result = await loadProviders();
    expect(result.length).toBe(PRESET_PROVIDERS.length + 1);
    expect(result[0].id).toBe('test-provider');
  });

  it('migrates Kimi’s stale base URL and saved endpoint together', async () => {
    mocks.files.set(PROVIDERS_PATH, JSON.stringify({
      providers: [{
        id: 'kimi-coding',
        name: 'Kimi',
        type: 'openai',
        baseUrl: 'https://api.kimi.com',
        endpoints: [{ type: 'openai', baseUrl: 'https://api.kimi.com', protocol: 'chat' }],
        vaultKey: 'KIMI_API_KEY-example',
        authMode: 'api_key',
        models: [{ id: 'kimi-k2.5' }],
      }],
    }));

    const result = await loadProviders();
    const kimi = result.find(provider => provider.id === 'kimi-coding');
    expect(kimi?.baseUrl).toBe('https://api.moonshot.cn/v1');
    expect(kimi?.endpoints).toEqual([
      { type: 'openai', baseUrl: 'https://api.moonshot.cn/v1', protocol: 'chat' },
      { type: 'anthropic', baseUrl: 'https://api.moonshot.cn/anthropic' },
    ]);
    expect(kimi?.vaultKey).toBe('KIMI_API_KEY-example');
  });

  it('moves the legacy Qianfan Coding endpoint to the dedicated preset', async () => {
    mocks.files.set(PROVIDERS_PATH, JSON.stringify({
      providers: [{
        id: 'qianfan',
        name: '百度千帆',
        type: 'openai',
        baseUrl: 'https://qianfan.baidubce.com/v2',
        endpoints: [
          { type: 'openai', baseUrl: 'https://qianfan.baidubce.com/v2' },
          { type: 'openai', baseUrl: 'https://qianfan.baidubce.com/v2/coding' },
        ],
        vaultKey: 'QIANFAN_API_KEY-example',
        authMode: 'api_key',
        models: [{ id: 'deepseek-v3.2' }],
      }],
    }));

    const result = await loadProviders();
    const qianfan = result.find(provider => provider.id === 'qianfan');
    const coding = result.find(provider => provider.id === 'qianfan-coding');
    expect(qianfan?.endpoints).toEqual([
      { type: 'openai', baseUrl: 'https://qianfan.baidubce.com/v2' },
      { type: 'anthropic', baseUrl: 'https://qianfan.baidubce.com/anthropic' },
    ]);
    expect(coding?.baseUrl).toBe('https://qianfan.baidubce.com/v2/tokenplan/personal');
    expect(coding?.vaultKey).toBeUndefined();
  });

  it('backfills missing plan metadata on an exact built-in endpoint URL', async () => {
    mocks.files.set(PROVIDERS_PATH, JSON.stringify({
      providers: [{
        id: 'qianfan-coding',
        name: '百度千帆 Token Plan',
        type: 'openai',
        baseUrl: 'https://qianfan.baidubce.com/v2/tokenplan/personal',
        endpoints: [
          { type: 'openai', protocol: 'chat', baseUrl: 'https://qianfan.baidubce.com/v2/tokenplan/personal' },
          { type: 'anthropic', baseUrl: 'https://qianfan.baidubce.com/anthropic/tokenplan/personal' },
        ],
        authMode: 'api_key',
        models: [{ id: 'qianfan-code-latest' }],
      }],
    }));

    const result = await loadProviders();
    const provider = result.find(item => item.id === 'qianfan-coding')!;
    expect(provider.endpoints?.every(endpoint => endpoint.plan === 'token')).toBe(true);
  });

  it('migrates the Xiaomi Token Plan endpoints to the signed-in region', async () => {
    mocks.files.set(PROVIDERS_PATH, JSON.stringify({
      providers: [{
        id: 'xiaomi-coding',
        name: '小米 MiMo Token Plan',
        type: 'openai',
        baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
        endpoints: [
          { type: 'openai', protocol: 'chat', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', plan: 'token' },
          { type: 'anthropic', baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic', plan: 'token' },
        ],
        authMode: 'api_key',
        models: [
          { id: 'mimo-v2.5' }, { id: 'mimo-v2.5-pro' },
          { id: 'mimo-v2.5-asr' }, { id: 'mimo-v2.5-tts' },
        ],
      }],
    }));

    const result = await loadProviders();
    const xiaomi = result.find(provider => provider.id === 'xiaomi-coding');
    expect(xiaomi?.baseUrl).toBe('https://token-plan-sgp.xiaomimimo.com/v1');
    expect(xiaomi?.endpoints).toEqual([
      { type: 'openai', protocol: 'chat', baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1', plan: 'token' },
      { type: 'anthropic', baseUrl: 'https://token-plan-sgp.xiaomimimo.com/anthropic', plan: 'token' },
    ]);
    expect(xiaomi?.models.map(model => model.id)).toContain('mimo-v2.5-tts-voiceclone');
  });

  it('migrates only the stale Bailian defaults to protocol-specific Base URLs', async () => {
    mocks.files.set(PROVIDERS_PATH, JSON.stringify({
      providers: [
        {
          id: 'qwen',
          name: '阿里云百炼',
          type: 'openai',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          endpoints: [
            { type: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
            { type: 'anthropic', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
          ],
          authMode: 'api_key',
          models: [{ id: 'qwen-plus' }],
        },
        {
          id: 'qwen-coding',
          name: '阿里云百炼 Coding Plan',
          type: 'openai',
          baseUrl: 'https://coding.dashscope.aliyuncs.com/compatible-mode/v1',
          endpoints: [
            { type: 'openai', protocol: 'chat', baseUrl: 'https://coding.dashscope.aliyuncs.com/compatible-mode/v1', plan: 'coding' },
            { type: 'anthropic', baseUrl: 'https://coding.dashscope.aliyuncs.com/compatible-mode/v1', plan: 'coding' },
          ],
          authMode: 'api_key',
          models: [{ id: 'qwen3-coder-plus' }],
        },
      ],
    }));

    const result = await loadProviders();
    expect(result.find(provider => provider.id === 'qwen')?.endpoints).toEqual([
      { type: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
      { type: 'anthropic', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic' },
    ]);
    expect(result.find(provider => provider.id === 'qwen-coding')).toMatchObject({
      baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
      endpoints: [
        { type: 'openai', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1' },
        { type: 'anthropic', baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic' },
      ],
    });
  });

  it('fails loudly when providers is not an array', async () => {
    mocks.files.set(PROVIDERS_PATH, JSON.stringify({ providers: 'not-array' }));
    await expect(loadProviders()).rejects.toThrow('providers 必须是数组');
  });

  it('migrates OAuth subscriptions to agent-native offerings without endpoints', async () => {
    mocks.files.set(PROVIDERS_PATH, JSON.stringify({
      providers: [{
        id: 'openai-codex',
        name: 'OpenAI Codex OAuth',
        type: 'openai',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        endpoints: [{ type: 'openai', baseUrl: 'https://chatgpt.com/backend-api/codex' }],
        authMode: 'oauth',
        models: [{ id: 'codex-1' }],
      }],
    }));

    const result = await loadProviders();
    const codex = result.find(provider => provider.id === 'openai-codex');
    expect(codex).toMatchObject({
      executionMode: 'agent_native',
      nativeAgentIds: ['codex'],
    });
    expect(codex?.endpoints).toBeUndefined();
  });
});

describe('saveProviders', () => {
  it('writes providers to disk', async () => {
    await saveProviders([sampleProvider]);
    expect(mocks.ensureDir).toHaveBeenCalled();
    const written = mocks.files.get(PROVIDERS_PATH);
    expect(written).toBeTruthy();
    const parsed = JSON.parse(written!);
    expect(parsed.providers.length).toBe(1);
    expect(parsed.providers[0].id).toBe('test-provider');
  });
});

describe('getProvider', () => {
  it('returns provider by id', async () => {
    mocks.files.set(PROVIDERS_PATH, JSON.stringify({ providers: [sampleProvider] }));
    const result = await getProvider('test-provider');
    expect(result).toBeDefined();
    expect(result!.name).toBe('Test Provider');
  });

  it('returns undefined for unknown id', async () => {
    mocks.files.set(PROVIDERS_PATH, JSON.stringify({ providers: [sampleProvider] }));
    const result = await getProvider('unknown');
    expect(result).toBeUndefined();
  });
});

describe('addProvider', () => {
  it('adds a new provider on top of presets', async () => {
    await addProvider(sampleProvider);
    const written = JSON.parse(mocks.files.get(PROVIDERS_PATH)!);
    // loadProviders creates presets, then addProvider appends
    expect(written.providers).toContainEqual(expect.objectContaining({ id: 'test-provider' }));
  });

  it('updates existing provider with same id', async () => {
    mocks.files.set(PROVIDERS_PATH, JSON.stringify({ providers: [sampleProvider] }));
    await addProvider({ ...sampleProvider, name: 'Updated' });
    const written = JSON.parse(mocks.files.get(PROVIDERS_PATH)!);
    expect(written.providers.length).toBe(PRESET_PROVIDERS.length + 1);
    expect(written.providers[0].name).toBe('Updated');
  });

  it('appends to existing providers', async () => {
    mocks.files.set(PROVIDERS_PATH, JSON.stringify({ providers: [sampleProvider] }));
    await addProvider({ id: 'second', name: 'Second', type: 'openai', baseUrl: 'https://second.com', authMode: 'api_key', models: [] });
    const written = JSON.parse(mocks.files.get(PROVIDERS_PATH)!);
    expect(written.providers.length).toBe(PRESET_PROVIDERS.length + 2);
  });
});

describe('deleteProvider', () => {
  it('removes provider by id', async () => {
    mocks.files.set(PROVIDERS_PATH, JSON.stringify({ providers: [sampleProvider] }));
    const result = await deleteProvider('test-provider');
    expect(result).toBe(true);
    const written = JSON.parse(mocks.files.get(PROVIDERS_PATH)!);
    expect(written.providers.length).toBe(PRESET_PROVIDERS.length);
    expect(written.providers.some((p: any) => p.id === 'test-provider')).toBe(false);
  });

  it('returns false for unknown id', async () => {
    mocks.files.set(PROVIDERS_PATH, JSON.stringify({ providers: [sampleProvider] }));
    const result = await deleteProvider('unknown');
    expect(result).toBe(false);
  });
});
