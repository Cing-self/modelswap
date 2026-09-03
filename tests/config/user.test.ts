import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

const testRoot = vi.hoisted(() => {
  const p = require('path');
  const d = '/tmp/test-modelswap-user';
  return {
    MODELSWAP_DIR: d,
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
  MODELSWAP_DIR: testRoot.MODELSWAP_DIR,
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

describe('normalizeAgentModelSelectionNamespaces', () => {
  it('heals Google "models/" prefixed selections, active models and overrides', async () => {
    const { normalizeAgentModelSelectionNamespaces } = await import('../../src/config/user');
    const config: any = {
      agentProviders: {
        zcode: {
          activeProviderId: 'google',
          activeModelId: 'models/gemini-3.8-flash',
          sites: { google: { modelIds: ['models/gemini-3.8-flash', 'deepseek/model:free'], enabled: true } },
        },
      },
      modelOverrides: { google: { 'models/gemini-3.8-flash': { alias: 'flash' } } },
    };

    expect(normalizeAgentModelSelectionNamespaces(config)).toBe(true);
    expect(config.agentProviders.zcode.activeModelId).toBe('gemini-3.8-flash');
    expect(config.agentProviders.zcode.sites.google.modelIds).toEqual(['gemini-3.8-flash', 'deepseek/model:free']);
    expect(Object.keys(config.modelOverrides.google)).toEqual(['gemini-3.8-flash']);
    // Idempotent: a second pass reports no change.
    expect(normalizeAgentModelSelectionNamespaces(config)).toBe(false);
  });

  it('leaves route-shaped ids untouched when no prefix exists', async () => {
    const { normalizeAgentModelSelectionNamespaces } = await import('../../src/config/user');
    const config: any = {
      agentProviders: { opencode: { sites: { openrouter: { modelIds: ['anthropic/claude-sonnet-4', 'mistralai/voxtral-small-24b-2507'] } } } },
    };
    expect(normalizeAgentModelSelectionNamespaces(config)).toBe(false);
    expect(config.agentProviders.opencode.sites.openrouter.modelIds)
      .toEqual(['anthropic/claude-sonnet-4', 'mistralai/voxtral-small-24b-2507']);
  });

  it('loadUserConfig routes prefixed selections through the persisting migration', async () => {
    mocks.files.set(CONFIG_PATH, JSON.stringify({
      agentProviders: {
        zcode: {
          activeProviderId: 'google',
          sites: { google: { modelIds: ['models/gemini-3.8-flash'], enabled: true } },
        },
      },
    }));

    // A clean config is returned as-is; the prefixed one must not round-trip
    // verbatim (the load routes into the store's persisting migration, whose
    // healing is contract-tested in config-mutation-contract.test.js).
    const config = await loadUserConfig();
    expect((config as any).agentProviders?.zcode?.sites?.google?.modelIds ?? [])
      .not.toContain('models/gemini-3.8-flash');
  });
});
