import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

describe('VaultStore descriptions', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('os');
    vi.doUnmock('../../src/config/backup');
  });

  it('persists and updates an optional description for one key', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'okit-vault-desc-'));
    const actualOs = await vi.importActual<typeof import('os')>('os');
    vi.doMock('os', () => ({
      ...actualOs,
      default: { ...actualOs, homedir: () => tmp },
      homedir: () => tmp,
    }));
    vi.doMock('../../src/config/backup', () => ({ backupImportantData: vi.fn() }));

    const { VaultStore } = await import('../../src/vault/store');
    const store = new VaultStore();
    await store.set('SERVICE_KEY', 'secret-value', 'AI', undefined, '生产环境');
    await store.set('SERVICE_KEY', 'new-value', 'AI', undefined, '团队共享');

    expect(await store.list()).toEqual([
      expect.objectContaining({ key: 'SERVICE_KEY', desc: '团队共享', group: 'AI' }),
    ]);
    expect(await store.get('SERVICE_KEY')).toBe('new-value');
    await fs.remove(tmp);
  });
});
