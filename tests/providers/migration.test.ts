import { describe, it, expect, vi, beforeEach } from 'vitest';

const testRoot = vi.hoisted(() => {
  const p = require('path');
  const d = '/tmp/test-okit-migration';
  return {
    OKIT_DIR: d,
    REGISTRY_PATH: p.join(d, 'registry.json'),
    LOGS_DIR: p.join(d, 'logs'),
    CACHE_DIR: p.join(d, 'cache'),
    PROVIDERS_PATH: p.join(d, 'providers.json'),
    CLAUDE_PROFILES_PATH: p.join(d, 'claude-profiles.json'),
  };
});

const mocks = vi.hoisted(() => {
  const files = new Map<string, string>();
  const mockSet = vi.fn(async function() {});
  return {
    files,
    mockSet,
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

vi.mock('../../src/vault/store', () => ({
  VaultStore: vi.fn().mockImplementation(function(this: any) {
    this.set = mocks.mockSet;
  }),
}));

const { migrateIfNeeded } = await import('../../src/providers/migration');

const PROVIDERS_PATH = testRoot.PROVIDERS_PATH;
const CLAUDE_PROFILES_PATH = testRoot.CLAUDE_PROFILES_PATH;

beforeEach(() => {
  mocks.files.clear();
  mocks.mockSet.mockClear();
});

describe('migrateIfNeeded', () => {
  it('skips when providers.json already exists', async () => {
    mocks.files.set(PROVIDERS_PATH, JSON.stringify({ providers: [] }));
    mocks.files.set(CLAUDE_PROFILES_PATH, JSON.stringify([
      { name: 'Anthropic', baseUrl: 'https://api.anthropic.com', authToken: '', models: ['opus'] },
    ]));

    const result = await migrateIfNeeded();
    expect(result).toBe(false);
    expect(mocks.mockSet).not.toHaveBeenCalled();
  });

  it('skips when no claude-profiles.json', async () => {
    const result = await migrateIfNeeded();
    expect(result).toBe(false);
  });

  it('migrates claude profiles to providers', async () => {
    mocks.files.set(CLAUDE_PROFILES_PATH, JSON.stringify([
      { name: 'Anthropic', baseUrl: 'https://api.anthropic.com', authToken: '', models: ['opus-4'] },
      { name: 'Volcengine', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding', authToken: 'ark-secret-key', models: ['glm-4.7', 'deepseek-v3'] },
    ]));

    const result = await migrateIfNeeded();
    expect(result).toBe(true);

    const written = JSON.parse(mocks.files.get(PROVIDERS_PATH)!);
    expect(written.providers.length).toBe(2);

    // Anthropic profile (no authToken)
    const anthropic = written.providers.find((p: any) => p.id === 'anthropic');
    expect(anthropic).toBeDefined();
    expect(anthropic.type).toBe('anthropic');
    expect(anthropic.authMode).toBe('oauth');
    expect(anthropic.models.length).toBe(1);
    expect(anthropic.models[0].id).toBe('opus-4');

    // Volcengine profile (with authToken → stored in vault)
    const volcengine = written.providers.find((p: any) => p.id === 'volcengine');
    expect(volcengine).toBeDefined();
    expect(volcengine.authMode).toBe('api_key');
    expect(volcengine.vaultKey).toBe('VOLCENGINE_API_KEY');
    expect(volcengine.models.length).toBe(2);
    expect(mocks.mockSet).toHaveBeenCalledWith('VOLCENGINE_API_KEY', 'ark-secret-key', 'providers');
  });

  it('skips profiles with missing name or baseUrl', async () => {
    mocks.files.set(CLAUDE_PROFILES_PATH, JSON.stringify([
      { name: 'Valid', baseUrl: 'https://valid.com', authToken: '', models: [] },
      { name: '', baseUrl: 'https://no-name.com', authToken: '', models: [] },
      { name: 'No URL', baseUrl: '', authToken: '', models: [] },
    ]));

    const result = await migrateIfNeeded();
    expect(result).toBe(true);

    const written = JSON.parse(mocks.files.get(PROVIDERS_PATH)!);
    expect(written.providers.length).toBe(1);
    expect(written.providers[0].id).toBe('valid');
  });

  it('handles empty array gracefully', async () => {
    mocks.files.set(CLAUDE_PROFILES_PATH, JSON.stringify([]));
    const result = await migrateIfNeeded();
    expect(result).toBe(true);

    const written = JSON.parse(mocks.files.get(PROVIDERS_PATH)!);
    expect(written.providers.length).toBe(0);
  });

  it('handles non-array JSON gracefully', async () => {
    mocks.files.set(CLAUDE_PROFILES_PATH, JSON.stringify({ not: 'array' }));
    const result = await migrateIfNeeded();
    expect(result).toBe(false);
  });
});
