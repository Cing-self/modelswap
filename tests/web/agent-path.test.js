import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';

const { augmentedPath, detectionEnv, extraPathEntries } = await import('../../src/web/api/agent-path.js');

describe('agent-path augmented PATH', () => {
  it('keeps the original PATH entries first, in order', () => {
    const original = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const augmented = augmentedPath().split(path.delimiter);
    // The original entries (minus duplicates) must be a prefix of the result.
    const seen = new Set();
    const deduped = original.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
    expect(augmented.slice(0, deduped.length)).toEqual(deduped);
  });

  it('appends the standard install locations on POSIX', () => {
    if (process.platform === 'win32') return;
    const entries = augmentedPath().split(path.delimiter);
    for (const p of ['/opt/homebrew/bin', '/usr/local/bin']) {
      expect(entries).toContain(p);
    }
  });

  it('appends agent-specific installer dirs under the home dir', () => {
    const home = os.homedir();
    const entries = extraPathEntries(home);
    const names = ['.claude/local', '.opencode/bin', '.kimi-code/bin', '.grok/bin', '.mimocode/bin'];
    for (const n of names) {
      expect(entries).toContain(path.join(home, n));
    }
  });

  it('includes nvm bin dirs for every installed node version', () => {
    const fs = require('fs');
    const nvmRoot = path.join(os.homedir(), '.nvm', 'versions', 'node');
    if (!fs.existsSync(nvmRoot)) return; // nvm absent: nothing to assert
    const versions = fs.readdirSync(nvmRoot);
    const entries = extraPathEntries();
    for (const v of versions) {
      expect(entries).toContain(path.join(nvmRoot, v, 'bin'));
    }
  });

  it('never emits duplicate entries', () => {
    const entries = augmentedPath().split(path.delimiter);
    expect(new Set(entries).size).toBe(entries.length);
  });

  it('detectionEnv carries the augmented PATH and the rest of the environment', () => {
    const env = detectionEnv();
    expect(env.PATH).toBe(augmentedPath());
    expect(env.HOME).toBe(process.env.HOME);
  });
});
