import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const temporaryHomes: string[] = [];

function isolatedEnvironment() {
  const home = mkdtempSync(path.join(tmpdir(), 'okit-runtime-home-'));
  temporaryHomes.push(home);
  return { ...process.env, HOME: home, USERPROFILE: home };
}

afterEach(() => {
  while (temporaryHomes.length) rmSync(temporaryHomes.pop()!, { recursive: true, force: true });
});

describe('packaged runtime closure', { timeout: 60000 }, () => {
  it('builds and loads the isolated web and provider runtime without source files', () => {
    const env = isolatedEnvironment();
    const tsc = require.resolve('typescript/bin/tsc');

    execFileSync(process.execPath, [tsc], { cwd: root, env, stdio: 'pipe' });
    execFileSync(process.execPath, ['scripts/copy-web.js'], { cwd: root, env, stdio: 'pipe' });
    const output = execFileSync(process.execPath, ['scripts/verify-runtime-closure.js'], {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
    });

    expect(output).toContain('Verified packaged runtime closure');
  });
});
