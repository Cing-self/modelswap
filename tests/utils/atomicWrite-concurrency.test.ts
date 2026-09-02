// Real-filesystem concurrency regression test — no fs mocks here.
// v1.0.0 regression: the first-run language save raced the first-run hint
// save; both atomicWrites shared ONE tmp path, the first rename consumed it
// and the second failed with ENOENT on a fresh install.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { atomicWrite, atomicWriteJSON } from '../../src/utils/atomicWrite';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map(dir => fs.remove(dir)));
});

describe('atomicWrite concurrency (real fs)', () => {
  it('survives concurrent writes to the same target', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelswap-awc-'));
    created.push(dir);
    const target = path.join(dir, 'user.json');

    const writes = Array.from({ length: 30 }, (_, i) =>
      atomicWriteJSON(target, { i, payload: 'x'.repeat(200) }),
    );
    await Promise.all(writes); // must NOT reject with ENOENT

    // The file is one of the written states, complete and valid JSON.
    const final = JSON.parse(await fs.readFile(target, 'utf-8'));
    expect(final.payload.length).toBe(200);
    expect(final.i).toBeGreaterThanOrEqual(0);
    const leftovers = (await fs.readdir(dir)).filter(f => f.includes('modelswap-tmp'));
    expect(leftovers).toEqual([]);
  });

  it('basic write leaves no tmp files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelswap-awb-'));
    created.push(dir);
    const target = path.join(dir, 'target.json');
    await atomicWrite(target, '{"a":1}');
    expect(await fs.readFile(target, 'utf-8')).toBe('{"a":1}');
    expect((await fs.readdir(dir)).filter(f => f.includes('modelswap-tmp'))).toEqual([]);
  });
});
