import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

const testRoot = vi.hoisted(() => {
  const p = require('path');
  const d = '/tmp/test-okit-user';
  return {
    OKIT_DIR: d,
    REGISTRY_PATH: p.join(d, 'registry.json'),
    LOGS_DIR: p.join(d, 'logs'),
    CACHE_DIR: p.join(d, 'cache'),
    CONFIG_PATH: p.join(d, 'user.json'),
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

const configCore = vi.hoisted(() => ({
  setPreference: vi.fn(async () => ({})),
  replaceAgentState: vi.fn(async () => ({})),
  applyLegacyMigration: vi.fn(async () => ({})),
  initializeLegacyClaude: vi.fn(async () => ({})),
  loadConfig: vi.fn(async () => ({})),
}));
vi.mock('../../src/web/api/cloud-sync-core', () => configCore);

const { loadUserConfig } = await import('../../src/config/user');

const CONFIG_PATH = testRoot.CONFIG_PATH;

beforeEach(() => {
  mocks.files.clear();
  vi.clearAllMocks();
});

describe('loadUserConfig', () => {
  it('returns empty object when no config file', async () => {
    const config = await loadUserConfig();
    expect(config).toEqual({});
  });

  it('loads config from file', async () => {
    mocks.files.set(CONFIG_PATH, JSON.stringify({ language: 'en' }));
    const config = await loadUserConfig();
    expect(config.language).toBe('en');
  });

  it('returns empty object for invalid JSON', async () => {
    mocks.files.set(CONFIG_PATH, 'not json');
    const config = await loadUserConfig();
    expect(config).toEqual({});
  });
});
