import { execFileSync } from 'child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const temporaryDirectories: string[] = [];

function isolatedEnvironment() {
  const home = mkdtempSync(path.join(tmpdir(), 'okit-runtime-home-'));
  temporaryDirectories.push(home);
  return { ...process.env, HOME: home, USERPROFILE: home };
}

// The build pipeline (tsc + copy-web) mutates dist/ in place — copy-web even
// removes dist/web/api before recopying it. Running that against the shared
// checkout races every parallel Vitest worker that loads compiled output
// (dist providers require dist/web/api/log-writer, so a worker can hit the
// removal window and fail with "Cannot find module"). Mirror the repo into a
// throwaway sandbox and build there instead: same real tsc + copy-web +
// closure verification, zero writes to the shared tree.
function makeBuildSandbox() {
  const sandbox = mkdtempSync(path.join(tmpdir(), 'okit-runtime-build-'));
  temporaryDirectories.push(sandbox);
  for (const file of ['package.json', 'tsconfig.json', 'scripts/copy-web.js', 'scripts/verify-runtime-closure.js']) {
    cpSync(path.join(root, file), path.join(sandbox, file));
  }
  cpSync(path.join(root, 'src'), path.join(sandbox, 'src'), {
    recursive: true,
    // The frontend is excluded from the root tsconfig and ships through its
    // own build; skipping it keeps the sandbox copy small.
    filter: (source) => !source.includes(`${path.sep}src${path.sep}web${path.sep}frontend`),
  });
  symlinkSync(path.join(root, 'node_modules'), path.join(sandbox, 'node_modules'), 'junction');
  return sandbox;
}

afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe('packaged runtime closure', { timeout: 60000 }, () => {
  it('builds and loads the isolated web and provider runtime without source files', () => {
    const env = isolatedEnvironment();
    const sandbox = makeBuildSandbox();
    const tsc = require.resolve('typescript/bin/tsc');

    execFileSync(process.execPath, [tsc], { cwd: sandbox, env, stdio: 'pipe' });
    execFileSync(process.execPath, [path.join(sandbox, 'scripts', 'copy-web.js')], { cwd: sandbox, env, stdio: 'pipe' });
    const output = execFileSync(process.execPath, [path.join(sandbox, 'scripts', 'verify-runtime-closure.js')], {
      cwd: sandbox,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
    });

    expect(output).toContain('Verified packaged runtime closure');
  });
});
