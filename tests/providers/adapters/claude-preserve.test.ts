import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';

const testRoot = vi.hoisted(() => {
  const p = require('path');
  const d = '/tmp/test-okit-claude-preserve';
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

vi.mock('child_process', () => ({
  execFileSync: vi.fn(function() { throw new Error('no keychain entry'); }),
}));

const { ClaudeAdapter } = await import('../../../src/providers/adapters/claude');
const { updateUserConfig } = await import('../../../src/config/user');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

const thirdPartyProvider = {
  id: 'custom-gateway',
  name: 'Custom Gateway',
  type: 'anthropic' as const,
  baseUrl: 'https://custom-gateway.example.com/api/coding',
  vaultKey: 'TEST_API_KEY',
  authMode: 'api_key' as const,
  models: [{ id: 'custom-model' }],
};

beforeEach(() => {
  mocks.files.clear();
  vi.mocked(updateUserConfig).mockClear();
});

describe('ClaudeAdapter.applyConfig preserves custom top-level fields', () => {
  it('keeps hooks, statusLine, tui and writes ANTHROPIC_BASE_URL', async () => {
    mocks.files.set(SETTINGS_PATH, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash*', hooks: [{ type: 'command', command: 'echo hook' }] }],
      },
      statusLine: { type: 'command', command: 'echo status' },
      tui: { fontSize: 14, theme: 'dark' },
      env: {
        SOME_OTHER_VAR: 'keep-me',
      },
    }));

    const adapter = new ClaudeAdapter();
    await adapter.applyConfig(thirdPartyProvider, 'custom-model');

    const written = JSON.parse(mocks.files.get(SETTINGS_PATH)!);

    expect(written.hooks).toEqual({
      PreToolUse: [{ matcher: 'Bash*', hooks: [{ type: 'command', command: 'echo hook' }] }],
    });
    expect(written.statusLine).toEqual({ type: 'command', command: 'echo status' });
    expect(written.tui).toEqual({ fontSize: 14, theme: 'dark' });
    expect(written.env.ANTHROPIC_BASE_URL).toBe('https://custom-gateway.example.com/api/coding');
    expect(written.env.ANTHROPIC_MODEL).toBe('custom-model');
    expect(written.env.SOME_OTHER_VAR).toBe('keep-me');
  });
});