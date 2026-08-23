import { describe, it, expect, vi, beforeEach } from 'vitest';
import Module from 'module';
import os from 'os';

vi.spyOn(os, 'homedir').mockReturnValue('/tmp/test-okit-cloud-config');

const mockFs = vi.hoisted(() => ({
  readJson: vi.fn(),
  pathExists: vi.fn(),
  ensureDir: vi.fn(),
  writeJson: vi.fn(),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
}));

vi.mock('fs-extra', () => ({ default: mockFs, ...mockFs }));

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'fs-extra') return mockFs;
  return origRequire.apply(this, arguments);
};

const { loadConfig, saveConfig } = await import('../src/web/api/cloud-sync-core.js');

beforeEach(() => {
  vi.clearAllMocks();
  mockFs.pathExists.mockResolvedValue(true);
  mockFs.readJson.mockResolvedValue({});
  mockFs.ensureDir.mockResolvedValue(undefined);
  mockFs.writeJson.mockResolvedValue(undefined);
  mockFs.mkdirSync.mockReturnValue(undefined);
  mockFs.appendFileSync.mockReturnValue(undefined);
});

describe('loadConfig', () => {
  it('returns config when file exists', async () => {
    mockFs.readJson.mockResolvedValue({ sync: { password: 'x' } });
    const result = await loadConfig();
    expect(result).toEqual({ sync: { password: 'x' } });
  });

  it('returns empty object when file does not exist', async () => {
    mockFs.pathExists.mockResolvedValue(false);
    const result = await loadConfig();
    expect(result).toEqual({});
  });

  it('returns empty object when file is corrupted', async () => {
    mockFs.pathExists.mockResolvedValue(true);
    mockFs.readJson.mockRejectedValue(new Error('bad json'));
    const result = await loadConfig();
    expect(result).toEqual({});
  });
});

describe('saveConfig', () => {
  it('writes config to disk', async () => {
    const config = { sync: { password: 'new' } };
    await saveConfig(config);
    expect(mockFs.ensureDir).toHaveBeenCalled();
    expect(mockFs.writeJson).toHaveBeenCalled();
    const [, writtenConfig] = mockFs.writeJson.mock.calls[0];
    expect(writtenConfig).toEqual(config);
  });
});
