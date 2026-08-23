import { describe, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const files = new Map<string, string>();
  return {
    files,
    writeFile: vi.fn(async (p: string, c: string) => { files.set(p, c); }),
    rename: vi.fn(async (oldPath: string, newPath: string) => { const c = files.get(oldPath); if (c !== undefined) files.set(newPath, c); }),
  };
});

vi.mock('fs-extra', () => ({ default: mocks }));

const { atomicWrite } = await import('../../src/utils/atomicWrite');

describe('atomicWrite retry', () => {
  it('retries on EPERM then succeeds', async () => {
    const filePath = '/tmp/test-atomic-retry.json';
    const data = '{"ok":true}';

    const tmpPath = filePath + '.okit-tmp';
    mocks.files.set(tmpPath, '');

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

  it('throws non-code errors immediately', async () => {
    const filePath = '/tmp/test-atomic-nocode.json';
    const tmpPath = filePath + '.okit-tmp';
    mocks.files.set(tmpPath, '');
    mocks.rename.mockRejectedValue(new Error('something wrong'));

    await expect(atomicWrite(filePath, 'data')).rejects.toThrow('something wrong');
  });

  it('retries up to 3 times then throws', async () => {
    const filePath = '/tmp/test-atomic-maxretry.json';
    const tmpPath = filePath + '.okit-tmp';
    mocks.files.set(tmpPath, '');

    let callCount = 0;
    mocks.rename.mockImplementation(async () => {
      callCount++;
      throw Object.assign(new Error('still locked'), { code: 'EBUSY' });
    });

    await expect(atomicWrite(filePath, 'data')).rejects.toThrow('still locked');
    expect(callCount).toBe(3);
  });
});