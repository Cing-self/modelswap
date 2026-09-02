import { describe, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const files = new Map<string, string>();
  return {
    files,
    writeFile: vi.fn(async (p: string, c: string) => { files.set(p, c); }),
    rename: vi.fn(async (oldPath: string, newPath: string) => { const c = files.get(oldPath); if (c !== undefined) files.set(newPath, c); }),
    remove: vi.fn(async (p: string) => { files.delete(p); }),
    // tmp names are unique per call — tests capture them from writeFile.
    lastTmp: () => mocks.writeFile.mock.calls.at(-1)?.[0] as string,
  };
});

vi.mock('fs-extra', () => ({ default: mocks }));

const { atomicWrite } = await import('../../src/utils/atomicWrite');

describe('atomicWrite retry', () => {
  it('retries on EPERM then succeeds', async () => {
    const filePath = '/tmp/test-atomic-retry.json';
    const data = '{"ok":true}';

    let callCount = 0;
    mocks.rename.mockImplementation(async (oldPath: string, newPath: string) => {
      callCount++;
      if (callCount === 1) {
        throw Object.assign(new Error('locked'), { code: 'EPERM' });
      }
      const c = mocks.files.get(oldPath);
      if (c !== undefined) mocks.files.set(newPath, c);
    });

    await atomicWrite(filePath, data);
    expect(callCount).toBe(2);
    expect(mocks.files.get(filePath)).toBe(data);
  });

  it('throws non-code errors immediately and cleans the tmp file', async () => {
    const filePath = '/tmp/test-atomic-nocode.json';
    mocks.rename.mockRejectedValue(new Error('something wrong'));

    await expect(atomicWrite(filePath, 'data')).rejects.toThrow('something wrong');
    // The unique tmp file must not be left behind.
    const tmp = mocks.lastTmp();
    expect(tmp).toBeTruthy();
    expect(mocks.files.has(tmp)).toBe(false);
  });

  it('retries up to 8 times (Windows AV contention) then throws', async () => {
    const filePath = '/tmp/test-atomic-maxretry.json';

    let callCount = 0;
    mocks.rename.mockImplementation(async () => {
      callCount++;
      throw Object.assign(new Error('still locked'), { code: 'EBUSY' });
    });

    await expect(atomicWrite(filePath, 'data')).rejects.toThrow('still locked');
    expect(callCount).toBe(8);
  });

  it('uses a unique tmp name per call', async () => {
    mocks.rename.mockImplementation(async (oldPath: string, newPath: string) => {
      const c = mocks.files.get(oldPath);
      if (c !== undefined) mocks.files.set(newPath, c);
    });
    await atomicWrite('/tmp/uni-1.json', 'a');
    const tmp1 = mocks.lastTmp();
    await atomicWrite('/tmp/uni-1.json', 'b');
    const tmp2 = mocks.lastTmp();
    expect(tmp1).not.toBe(tmp2);
    expect(tmp1).toMatch(/\.modelswap-tmp$/);
  });
});
