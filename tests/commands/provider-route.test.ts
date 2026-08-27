import { beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  adapter: undefined as any,
  provider: {
    id: 'gateway', name: 'Gateway', type: 'openai' as const,
    baseUrl: 'https://gateway.example/v1', authMode: 'api_key' as const,
    endpoints: [{ id: 'gateway:openai', type: 'openai' as const, baseUrl: 'https://gateway.example/v1' }],
    models: [{
      id: 'canonical-model', name: 'Canonical Model',
      meta: {
        source: 'modelsdev' as const, context: 200000, output: 8192, reasoning: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
      },
      availability: [{
        executionMode: 'http_endpoint' as const, endpointId: 'gateway:openai', remoteModelId: 'remote-model-v2',
        status: 'available' as const, source: 'remote' as const,
      }],
    }],
  },
}));
const prompts = vi.hoisted(() => vi.fn());

vi.mock('fs-extra', () => ({ default: {
  pathExists: vi.fn(async (file: string) => state.files.has(file)),
  readFile: vi.fn(async (file: string) => state.files.get(file) || ''),
  writeFile: vi.fn(async (file: string, data: string) => { state.files.set(file, data); }),
  rename: vi.fn(async (from: string, to: string) => { const data = state.files.get(from); if (data !== undefined) state.files.set(to, data); }),
  ensureDir: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
} }));
vi.mock('prompts', () => ({ default: prompts }));
vi.mock('../../src/providers/store', () => ({
  loadProviders: vi.fn(async () => [state.provider]), addProvider: vi.fn(), deleteProvider: vi.fn(), getProvider: vi.fn(),
}));
vi.mock('../../src/providers/presets', () => ({ PRESET_PROVIDERS: [] }));
vi.mock('../../src/providers/registry', () => ({
  getAdapters: vi.fn(() => [state.adapter]), getAdapter: vi.fn(() => state.adapter),
}));
vi.mock('../../src/providers/auth', () => ({ checkAuthStatus: vi.fn() }));
vi.mock('../../src/config/user', () => ({
  loadUserConfig: vi.fn(async () => ({ modelOverrides: { gateway: { 'canonical-model': { context: 64000 } } } })),
  updateUserConfig: vi.fn(async () => undefined),
}));
vi.mock('../../src/providers/snapshots', () => ({ capturePreSwitchSnapshot: vi.fn(async () => undefined) }));
vi.mock('../../src/vault/store', () => ({ VaultStore: vi.fn() }));

const { OpenClawAdapter } = await import('../../src/providers/adapters/openclaw');
const { providerSwitch, providerUse } = await import('../../src/commands/provider');
const CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');

function expectRoutedConfig(): void {
  const written = JSON.parse(state.files.get(CONFIG_PATH)!);
  expect(written.agents.defaults.model.primary).toBe('gateway/remote-model-v2');
  expect(written.models.providers.gateway.models).toEqual([{
    id: 'remote-model-v2', name: 'Canonical Model', reasoning: true,
    input: ['text', 'image'], contextWindow: 64000, maxTokens: 8192,
  }]);
}

beforeEach(() => {
  state.files.clear();
  state.adapter = new OpenClawAdapter();
  prompts.mockReset();
});

describe('provider CLI remote-model writes', () => {
  it('provider switch writes the actual routed OpenClaw config, not only applyConfig arguments', async () => {
    prompts.mockResolvedValueOnce({ provider: 'gateway' }).mockResolvedValueOnce({ model: 'canonical-model' });

    await providerSwitch('openclaw');

    expectRoutedConfig();
  });

  it('provider use writes the actual routed OpenClaw config', async () => {
    await providerUse('gateway', { agent: 'openclaw', model: 'canonical-model' });

    expectRoutedConfig();
  });
});
