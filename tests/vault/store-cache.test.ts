import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

describe('VaultStore cache coherence', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('os');
    vi.doUnmock('../../src/config/backup');
  });

  it('reloads cached data when another store instance saves vault changes', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'okit-vault-cache-'));
    const actualOs = await vi.importActual<typeof import('os')>('os');

    vi.doMock('os', () => ({
      ...actualOs,
      default: { ...actualOs, homedir: () => tmp },
      homedir: () => tmp,
    }));
    vi.doMock('../../src/config/backup', () => ({
      backupImportantData: vi.fn().mockResolvedValue(undefined),
    }));

    const { VaultStore } = await import('../../src/vault/store');
    const reader = new VaultStore();
    expect(await reader.list()).toEqual([]);

    const writer = new VaultStore();
    await writer.set('IMPORTED_KEY', 'secret-value', 'Imported', undefined, 'Imported credential');

    expect(await reader.list()).toEqual([
      expect.objectContaining({
        key: 'IMPORTED_KEY',
        desc: 'Imported credential',
        group: 'Imported',
      }),
    ]);

    await fs.remove(tmp);
  });
});
