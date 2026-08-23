import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';

const testRoot = vi.hoisted(() => {
  const p = require('path');
  const d = '/tmp/test-okit-claude';
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

vi.mock('../../../src/providers/auth', () => ({
  checkClaudeOAuth: vi.fn(async function() { return false; }),
}));

// hasKeychainOAuth shells out to `/usr/bin/security`; without this mock the
// probe hits the real keychain, making the test machine-dependent (a developer
// machine with Claude OAuth logged in would take the apiKeyHelper path).
vi.mock('child_process', () => ({
  execFileSync: vi.fn(function() { throw new Error('no keychain entry'); }),
}));

const { ClaudeAdapter } = await import('../../../src/providers/adapters/claude');
const { updateUserConfig } = await import('../../../src/config/user');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

const testProvider = {
  id: 'volcengine',
  name: '火山引擎',
  type: 'anthropic' as const,
  baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
  vaultKey: 'TEST_API_KEY',
  authMode: 'api_key' as const,
  models: [{ id: 'glm-4.7' }],
};

const anthropicProvider = {
  id: 'anthropic',
  name: 'Anthropic',
  type: 'anthropic' as const,
  baseUrl: 'https://api.anthropic.com',
  authMode: 'both' as const,
  models: [{ id: 'claude-opus-4-7' }],
};

beforeEach(() => {
  mocks.files.clear();
  vi.mocked(updateUserConfig).mockClear();
});

describe('ClaudeAdapter', () => {
  it('has correct id and name', () => {
    const adapter = new ClaudeAdapter();
    expect(adapter.id).toBe('claude');
    expect(adapter.name).toBe('Claude Code');
  });

  it('supports anthropic type only', () => {
    const adapter = new ClaudeAdapter();
    expect(adapter.supportedTypes).toEqual(['anthropic']);
  });
});

describe('ClaudeAdapter.applyConfig', () => {
  it('writes ANTHROPIC_BASE_URL, MODEL, AUTH_TOKEN to settings.json', async () => {
    const adapter = new ClaudeAdapter();
    await adapter.applyConfig(testProvider, 'glm-4.7');

    const written = JSON.parse(mocks.files.get(SETTINGS_PATH)!);
    expect(written.env.ANTHROPIC_BASE_URL).toBe('https://ark.cn-beijing.volces.com/api/coding');
    expect(written.env.ANTHROPIC_MODEL).toBe('glm-4.7');
    expect(written.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test-123');
  });

  it('writes DEFAULT_HAIKU/SONNET/OPUS model keys (aligns with cc-switch)', async () => {
    // Claude Code resolves each tier via its DEFAULT_*_MODEL key; if a custom
    // provider only sets ANTHROPIC_MODEL, the CLI 404s when falling back to a
    // smaller variant. All four must map to the same backing model.
    const adapter = new ClaudeAdapter();
    await adapter.applyConfig(testProvider, 'glm-4.7');

    const written = JSON.parse(mocks.files.get(SETTINGS_PATH)!);
    expect(written.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-4.7');
    expect(written.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-4.7');
    expect(written.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-4.7');
  });

  it('uses apiKeyHelper for an x-api-key Anthropic gateway', async () => {
    const adapter = new ClaudeAdapter();
    await adapter.applyConfig({
      ...testProvider,
      id: 'kimi-coding-plan',
      baseUrl: 'https://api.kimi.com/coding',
    }, 'kimi-for-coding');

    const written = JSON.parse(mocks.files.get(SETTINGS_PATH)!);
    expect(written.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(written.apiKeyHelper).toBe(path.join(os.homedir(), '.claude', '.okit-key-helper.sh'));
  });

  it('clears env overrides for official Anthropic (no apiKey)', async () => {
    mocks.files.set(SETTINGS_PATH, JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://old-url.com',
        ANTHROPIC_MODEL: 'old-model',
        ANTHROPIC_AUTH_TOKEN: 'old-token',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'old-haiku',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'old-sonnet',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'old-opus',
      },
    }));

    const adapter = new ClaudeAdapter();
    await adapter.applyConfig(anthropicProvider, 'claude-opus-4-7');

    const written = JSON.parse(mocks.files.get(SETTINGS_PATH)!);
    // All provider env vars cleared → env key removed entirely
    const env = written.env || {};
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
  });

  it('clears custom routing for official Anthropic even when an API key is bound', async () => {
    // Regression: isOfficial must be decided by base URL alone, not by whether
    // a key is present. A user who set a key on the Anthropic preset must still
    // have BASE_URL/MODEL/AUTH_TOKEN cleared on switch-back (otherwise Claude
    // Code keeps routing to the previous third-party gateway). The key is kept
    // as the native ANTHROPIC_API_KEY field.
    const officialWithKey = { ...anthropicProvider, vaultKey: 'TEST_API_KEY' };
    mocks.files.set(SETTINGS_PATH, JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://gateway.com',
        ANTHROPIC_AUTH_TOKEN: 'gateway-token',
        ANTHROPIC_MODEL: 'gateway-model',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gw-haiku',
      },
    }));

    const adapter = new ClaudeAdapter();
    await adapter.applyConfig(officialWithKey, 'claude-opus-4-7');

    // The adapter drops an emptied env object, so fall back to {} when all
    // routing vars were cleared.
    const env = JSON.parse(mocks.files.get(SETTINGS_PATH)!).env ?? {};
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test-123');
  });

  it('preserves existing non-provider env vars', async () => {
    mocks.files.set(SETTINGS_PATH, JSON.stringify({
      env: {
        SOME_OTHER_VAR: 'keep-me',
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      },
    }));

    const adapter = new ClaudeAdapter();
    await adapter.applyConfig(testProvider, 'glm-4.7');

    const written = JSON.parse(mocks.files.get(SETTINGS_PATH)!);
    expect(written.env.SOME_OTHER_VAR).toBe('keep-me');
    expect(written.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
  });

  it('creates settings.json when it does not exist', async () => {
    const adapter = new ClaudeAdapter();
    await adapter.applyConfig(testProvider, 'glm-4.7');

    expect(mocks.ensureDir).toHaveBeenCalled();
    const written = JSON.parse(mocks.files.get(SETTINGS_PATH)!);
    expect(written.env.ANTHROPIC_BASE_URL).toBe('https://ark.cn-beijing.volces.com/api/coding');
  });

  it('updates user config with both new and legacy paths', async () => {
    const adapter = new ClaudeAdapter();
    await adapter.applyConfig(testProvider, 'glm-4.7');

    expect(updateUserConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: { claude: { providerId: 'volcengine', modelId: 'glm-4.7' } },
        claude: { name: '火山引擎', model: 'glm-4.7' },
      }),
    );
  });
});
