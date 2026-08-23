import { describe, it, expect, vi, beforeEach } from 'vitest';
import Module from 'module';
import os from 'os';

vi.spyOn(os, 'homedir').mockReturnValue('/tmp/test-okit-cloud-platform');

const mockFs = vi.hoisted(() => ({
  readJson: vi.fn(),
  pathExists: vi.fn(),
  ensureDir: vi.fn(),
  writeJson: vi.fn(),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
}));

vi.mock('fs-extra', () => ({ default: mockFs, ...mockFs }));

const mockStore = { get: vi.fn(), exportAll: vi.fn(), set: vi.fn() };
function MockVaultStore() { return mockStore; }

const mockSupabaseAdapter = {
  name: 'Supabase',
  testConnection: vi.fn(),
  syncSecrets: vi.fn(),
  pushSync: vi.fn(),
  pullSync: vi.fn(),
};

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'fs-extra') return mockFs;
  if (id === '../../vault/store') return { VaultStore: MockVaultStore };
  if (id === './platform-adapters/supabase') return mockSupabaseAdapter;
  return origRequire.apply(this, arguments);
};

const { testConnection, peekRemote } = await import('../src/web/api/cloud-sync-core.js');

const _pw = 'test' + '-' + 'password';
const _token = 'SUPABASE' + '_API_TOKEN';
const VALID_CONFIG = {
  sync: {
    password: _pw,
    syncPlatform: 'supabase',
    machineId: 'machine-1',
    platforms: {
      supabase: { enabled: true, apiToken: _token, projectId: 'proj-123', storeId: 'store-1' },
    },
  },
};

const SAMPLE_SECRETS = [
  { key: 'OPEN_AI_KEY', value: 'sk-abc123', desc: 'Production', group: 'AI', updatedAt: '2026-01-01T00:00:00Z' },
  { key: 'SILICONFLOW_API_KEY', value: 'sk-xyz789', desc: '', group: 'AI', updatedAt: '2026-01-02T00:00:00Z' },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockFs.pathExists.mockResolvedValue(true);
  mockFs.readJson.mockResolvedValue({});
  mockFs.ensureDir.mockResolvedValue(undefined);
  mockFs.writeJson.mockResolvedValue(undefined);
  mockFs.mkdirSync.mockReturnValue(undefined);
  mockFs.appendFileSync.mockReturnValue(undefined);
});

describe('testConnection', () => {
  it('throws when platform not configured', async () => {
    mockFs.readJson.mockResolvedValue({ sync: { platforms: {} } });
    await expect(testConnection('supabase')).rejects.toThrow('平台 supabase 未配置');
  });

  it('calls adapter testConnection with resolved config', async () => {
    mockFs.readJson.mockResolvedValue(VALID_CONFIG);
    mockStore.get.mockResolvedValue('resolved-token');
    mockSupabaseAdapter.testConnection.mockResolvedValue('连接成功');

    const result = await testConnection('supabase');
    expect(result).toBe('连接成功');
    expect(mockSupabaseAdapter.testConnection).toHaveBeenCalledWith(
      expect.objectContaining({ apiToken: 'resolved-token' })
    );
  });
});

describe('peekRemote', () => {
  it('returns null when the remote has no data', async () => {
    mockFs.readJson.mockResolvedValue(VALID_CONFIG);
    mockStore.get.mockResolvedValue('resolved');
    mockSupabaseAdapter.pullSync.mockResolvedValue(null);

    await expect(peekRemote()).resolves.toBeNull();
  });

  it('reports the remote blob version without touching local state', async () => {
    // Push once to produce a valid encrypted blob
    const { syncPush } = await import('../src/web/api/cloud-sync-core.js');
    mockFs.readJson.mockResolvedValue(VALID_CONFIG);
    mockStore.exportAll.mockResolvedValue([]);
    mockStore.get.mockResolvedValue('resolved');
    let blob;
    mockSupabaseAdapter.pushSync.mockImplementation(async (_cfg, _userId, b) => { blob = b; });
    await syncPush();

    mockSupabaseAdapter.pullSync.mockResolvedValue(blob);
    const before = mockFs.writeJson.mock.calls.length;
    const info = await peekRemote();

    expect(info.updatedAt).toBeTruthy();
    expect(info.machineId).toBe('machine-1');
    // peek must not persist anything
    expect(mockFs.writeJson.mock.calls.length).toBe(before);
    expect(mockStore.set).not.toHaveBeenCalled();
  });
});
