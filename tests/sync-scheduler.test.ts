import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Module from 'module';

const mockCore = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
  appendLog: vi.fn(),
  syncPush: vi.fn(),
  syncPull: vi.fn(),
  peekRemote: vi.fn(),
}));

const origRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === './cloud-sync-core') return mockCore;
  return origRequire.apply(this, arguments);
};

const scheduler = await import('../src/web/api/sync-scheduler.js');

const ENABLED_SYNC = {
  sync: {
    autoSync: true,
    password: 'pw',
    syncPlatform: 'icloud',
    machineId: 'm1',
    platforms: { icloud: { enabled: true } },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCore.loadConfig.mockResolvedValue(ENABLED_SYNC);
  mockCore.saveConfig.mockResolvedValue(undefined);
  mockCore.syncPush.mockResolvedValue({ secrets: 2, platform: 'iCloud' });
});

afterEach(() => {
  scheduler.stopAutoSync();
  vi.useRealTimers();
});

describe('hasPendingLocalChanges', () => {
  it('treats a never-synced state as pending', () => {
    expect(scheduler.hasPendingLocalChanges({})).toBe(true);
  });

  it('detects sections changed after the last sync', () => {
    const sync = {
      lastSyncAt: '2026-08-01T10:00:00.000Z',
      localChangedAt: { secrets: '2026-08-01T09:00:00.000Z', agent: '2026-08-01T11:00:00.000Z', providers: '2026-08-01T09:00:00.000Z' },
    };
    expect(scheduler.hasPendingLocalChanges(sync)).toBe(true);
  });

  it('reports clean when all baselines predate the last sync', () => {
    const sync = {
      lastSyncAt: '2026-08-01T12:00:00.000Z',
      localChangedAt: { secrets: '2026-08-01T10:00:00.000Z', agent: '2026-08-01T11:00:00.000Z', providers: '2026-08-01T10:00:00.000Z' },
    };
    expect(scheduler.hasPendingLocalChanges(sync)).toBe(false);
  });
});

describe('markDirty', () => {
  it('persists the section timestamp and debounces the push', async () => {
    vi.useFakeTimers();

    scheduler.markDirty('secrets');
    expect(mockCore.syncPush).not.toHaveBeenCalled();

    // A second mutation inside the window collapses into one push
    scheduler.markDirty('providers');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mockCore.syncPush).toHaveBeenCalledTimes(1);
    expect(mockCore.appendLog).toHaveBeenCalledWith('auto-sync-push', 'scheduler', true, '2 secrets');

    const saved = mockCore.saveConfig.mock.calls[0][0];
    expect(saved.sync.localChangedAt.secrets).toBeTruthy();
    expect(saved.sync.localChangedAt.providers).toBeTruthy();
  });

  it('does nothing when auto-sync is disabled', async () => {
    vi.useFakeTimers();
    mockCore.loadConfig.mockResolvedValue({ sync: { autoSync: false } });

    scheduler.markDirty('secrets');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mockCore.syncPush).not.toHaveBeenCalled();
  });
});

describe('syncNow', () => {
  it('skips the merge when the remote version is unchanged', async () => {
    mockCore.loadConfig.mockResolvedValue({
      ...ENABLED_SYNC,
      sync: {
        ...ENABLED_SYNC.sync,
        lastSyncAt: '2026-08-01T10:00:00.000Z',
        lastRemote: { updatedAt: 'T1', machineId: 'm1' },
        localChangedAt: { secrets: '2026-08-01T09:00:00.000Z', agent: '2026-08-01T09:00:00.000Z', providers: '2026-08-01T09:00:00.000Z' },
      },
    });
    mockCore.peekRemote.mockResolvedValue({ updatedAt: 'T1', machineId: 'm1' });

    await scheduler.syncNow();

    expect(mockCore.syncPull).not.toHaveBeenCalled();
    expect(mockCore.syncPush).not.toHaveBeenCalled();
  });

  it('merges when the remote version differs', async () => {
    mockCore.loadConfig.mockResolvedValue({
      ...ENABLED_SYNC,
      sync: {
        ...ENABLED_SYNC.sync,
        lastSyncAt: '2026-08-01T10:00:00.000Z',
        lastRemote: { updatedAt: 'T1', machineId: 'm1' },
        localChangedAt: { secrets: '2026-08-01T09:00:00.000Z', agent: '2026-08-01T09:00:00.000Z', providers: '2026-08-01T09:00:00.000Z' },
      },
    });
    mockCore.peekRemote.mockResolvedValue({ updatedAt: 'T2', machineId: 'm2' });
    mockCore.syncPull.mockResolvedValue({ added: 1, updated: 0, total: 3 });

    await scheduler.syncNow();

    expect(mockCore.syncPull).toHaveBeenCalledTimes(1);
    expect(mockCore.syncPush).not.toHaveBeenCalled();
  });

  it('seeds a first push when never synced and the remote is empty', async () => {
    mockCore.loadConfig.mockResolvedValue(ENABLED_SYNC);
    mockCore.peekRemote.mockResolvedValue(null);

    await scheduler.syncNow();

    expect(mockCore.syncPush).toHaveBeenCalledTimes(1);
  });
});

describe('runExclusive', () => {
  it('rejects concurrent operations while one is in flight', async () => {
    let release: (value: unknown) => void;
    const gate = new Promise((resolve) => { release = resolve; });
    mockCore.syncPush.mockImplementation(() => gate);

    const first = scheduler.runExclusive(async () => 'first');
    const second = await scheduler.runExclusive(async () => 'second');

    expect(second).toEqual({ busy: true });
    release!('done');
    await expect(first).resolves.toEqual({ busy: false, result: 'first' });
  });
});
