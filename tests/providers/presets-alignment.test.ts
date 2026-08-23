import { describe, it, expect } from 'vitest';
import { PRESET_PROVIDERS } from '../../src/providers/presets';

describe('PRESET_PROVIDERS alignment', () => {
  const EXPECTED_IDS = [
    'anthropic', 'anthropic-agent', 'openai', 'openai-codex', 'volcengine',
    'zai', 'zai-global', 'zai-global-coding', 'glm-coding', 'minimax', 'minimax-global',
    'minimax-global-coding', 'minimax-coding', 'deepseek', 'moonshot', 'kimi-coding',
    'kimi-coding-plan', 'qwen', 'qwen-coding', 'qianfan', 'qianfan-coding', 'volcengine-coding',
    'volcengine-agent', 'tencent', 'tencent-token-plan', 'siliconflow', 'xai', 'xai-grok-build', 'github-copilot',
    'mistral', 'stepfun', 'stepfun-global', 'xiaomi', 'xiaomi-coding', 'openrouter',
    'opencode-go', 'opencode-zen', 'qwen-token-plan', 'ollama', 'litellm',
  ];

  it('has exactly 40 presets', () => {
    expect(PRESET_PROVIDERS.length).toBe(40);
  });

  it('contains all expected provider IDs', () => {
    const ids = PRESET_PROVIDERS.map(p => p.id);
    for (const id of EXPECTED_IDS) {
      expect(ids).toContain(id);
    }
  });

  it('keeps OpenRouter as the only bundled aggregator', () => {
    const ids = PRESET_PROVIDERS.map(p => p.id);
    expect(ids).toContain('openrouter');
    expect(ids).not.toContain('groq');
    expect(ids).not.toContain('fireworks');
    expect(ids).not.toContain('together');
  });

  it('has no duplicate IDs', () => {
    const ids = PRESET_PROVIDERS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the legacy Kimi Coding ID while using the Kimi product name', () => {
    const kimi = PRESET_PROVIDERS.find(provider => provider.id === 'kimi-coding');
    expect(kimi?.name).toBe('Kimi（国内站）');
    expect(kimi?.baseUrl).toBe('https://api.moonshot.cn/v1');
    const moonshot = PRESET_PROVIDERS.find(provider => provider.id === 'moonshot');
    expect(moonshot?.name).toBe('Moonshot');
    expect(moonshot?.baseUrl).toBe('https://api.moonshot.ai/v1');
  });

  it('multi-endpoint providers have endpoints array', () => {
    const multiEndpoint = [
      'zai', 'deepseek', 'xiaomi', 'moonshot', 'kimi-coding',
      'kimi-coding-plan', 'glm-coding', 'minimax-coding', 'qwen-coding', 'qwen-token-plan', 'tencent-token-plan',
      'volcengine-coding', 'xiaomi-coding',
    ];
    for (const id of multiEndpoint) {
      const p = PRESET_PROVIDERS.find(p => p.id === id);
      expect(p, `${id} should have endpoints`).toBeDefined();
      expect(p!.endpoints!.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('each endpoint has valid type and baseUrl', () => {
    for (const p of PRESET_PROVIDERS) {
      if (!p.endpoints) continue;
      for (const ep of p.endpoints) {
        expect(ep.type).toMatch(/^(anthropic|openai)$/);
        expect(ep.baseUrl).toMatch(/^https?:\/\//);
      }
    }
  });

  it('non-local providers have at least 1 model', () => {
    const localProviders = ['ollama', 'litellm'];
    for (const p of PRESET_PROVIDERS) {
      if (localProviders.includes(p.id)) continue;
      expect(p.models.length, `${p.id} should have models`).toBeGreaterThan(0);
    }
  });

  it('all model IDs are unique within each provider', () => {
    for (const p of PRESET_PROVIDERS) {
      const ids = p.models.map(m => m.id);
      expect(new Set(ids).size, `${p.id} has duplicate model IDs`).toBe(ids.length);
    }
  });

  it('openai has 5 models', () => {
    const p = PRESET_PROVIDERS.find(p => p.id === 'openai')!;
    expect(p.models.length).toBe(5);
  });

  it('marks Coding and Token Plan endpoints explicitly', () => {
    const codingIds = ['kimi-coding-plan', 'glm-coding', 'volcengine-coding', 'qwen-coding', 'zai-global-coding'];
    for (const id of codingIds) {
      const provider = PRESET_PROVIDERS.find(p => p.id === id)!;
      expect(provider.endpoints?.every(endpoint => endpoint.plan === 'coding'), id).toBe(true);
    }
    for (const id of ['minimax-coding', 'minimax-global-coding', 'xiaomi-coding', 'qianfan-coding', 'qwen-token-plan', 'tencent-token-plan']) {
      const provider = PRESET_PROVIDERS.find(p => p.id === id)!;
      expect(provider.endpoints?.every(endpoint => endpoint.plan === 'token'), id).toBe(true);
    }
    const openCodeGo = PRESET_PROVIDERS.find(provider => provider.id === 'opencode-go')!;
    expect(openCodeGo.endpoints?.every(endpoint => endpoint.plan === 'coding')).toBe(true);
  });

  it('matches the signed-in MiMo Token Plan Base URLs and model list', () => {
    const provider = PRESET_PROVIDERS.find(p => p.id === 'xiaomi-coding')!;
    expect(provider.baseUrl).toBe('https://token-plan-sgp.xiaomimimo.com/v1');
    expect(provider.endpoints).toEqual([
      { type: 'openai', protocol: 'chat', baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1', plan: 'token' },
      { type: 'anthropic', baseUrl: 'https://token-plan-sgp.xiaomimimo.com/anthropic', plan: 'token' },
    ]);
    expect(provider.models.map(model => model.id)).toEqual([
      'mimo-v2.5', 'mimo-v2.5-pro', 'mimo-v2.5-asr', 'mimo-v2.5-tts',
      'mimo-v2.5-tts-voiceclone', 'mimo-v2.5-tts-voicedesign',
    ]);
  });

  it('keeps Bailian API and Coding Plan protocols on their official distinct Base URLs', () => {
    const api = PRESET_PROVIDERS.find(provider => provider.id === 'qwen')!;
    expect(api.endpoints).toEqual([
      { type: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
      { type: 'anthropic', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic' },
    ]);

    const coding = PRESET_PROVIDERS.find(provider => provider.id === 'qwen-coding')!;
    expect(coding.baseUrl).toBe('https://coding.dashscope.aliyuncs.com/v1');
    expect(coding.endpoints).toEqual([
      { type: 'openai', protocol: 'chat', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1', plan: 'coding' },
      { type: 'anthropic', baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic', plan: 'coding' },
    ]);
    expect(coding.models.map(model => model.id)).toContain('qwen3.7-plus');

    const tokenPlan = PRESET_PROVIDERS.find(provider => provider.id === 'qwen-token-plan')!;
    expect(tokenPlan.models.map(model => model.id)).toContain('qwen3.8-max-preview');
    expect(tokenPlan.models.map(model => model.id)).not.toContain('qwen3.8-max');
  });

  it('uses current Tencent Token Plan model IDs', () => {
    const provider = PRESET_PROVIDERS.find(item => item.id === 'tencent-token-plan')!;
    expect(provider.models.map(model => model.id)).toEqual([
      'tc-code-latest',
      'deepseek-v4-flash-202605',
      'deepseek-v4-pro-202606',
      'minimax-m2.7',
      'glm-5.1',
      'glm-5',
      'hy3',
      'hy3-preview',
    ]);
  });

  it('authMode is valid for all providers', () => {
    for (const p of PRESET_PROVIDERS) {
      expect(p.authMode).toMatch(/^(api_key|oauth|both|none)$/);
    }
  });

  it('keeps OAuth subscriptions agent-native and endpoint-free', () => {
    for (const id of ['anthropic-agent', 'openai-codex', 'xai-grok-build', 'github-copilot']) {
      const provider = PRESET_PROVIDERS.find(item => item.id === id)!;
      expect(provider.executionMode, id).toBe('agent_native');
      expect(provider.endpoints, id).toBeUndefined();
    }
  });
});
