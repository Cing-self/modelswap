import { describe, it, expect } from 'vitest';
import { compareVersions, pickAssets } from '../../src/web/api/update-check.js';

describe('update-check helpers', () => {
  it('compares dotted versions numerically per segment', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('v1.1.0', '1.0.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '2.2.0')).toBeLessThan(0);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });

  it('picks the desktop dmg and CLI zips out of a release asset list', () => {
    const assets = [
      { name: 'okit-v1.1.0-macos-arm64.zip', url: 'a1' },
      { name: 'okit-v1.1.0-macos-arm64.zip.sha256', url: 'a1s' },
      { name: 'okit-v1.1.0-macos-x64.zip', url: 'a2' },
      { name: 'OKIT-1.1.0-universal.dmg', url: 'dmg' },
      { name: 'OKIT-1.1.0-universal.dmg.sha256', url: 'dmgs' },
    ];
    const picked = pickAssets(assets);
    expect(picked.dmg?.url).toBe('dmg');
    expect(picked.cliMacArm64?.url).toBe('a1');
    expect(picked.cliMacX64?.url).toBe('a2');
  });

  it('tolerates releases without a desktop dmg', () => {
    const picked = pickAssets([{ name: 'okit-v1.1.0-macos-arm64.zip', url: 'a1' }]);
    expect(picked.dmg).toBeNull();
    expect(picked.cliMacArm64?.url).toBe('a1');
  });
});
