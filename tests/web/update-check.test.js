import { describe, it, expect } from 'vitest';
import { compareVersions, downloadTarget, pickAssets } from '../../src/web/api/update-check.js';

describe('update-check helpers', () => {
  it('compares dotted versions numerically per segment', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('v1.1.0', '1.0.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '2.2.0')).toBeLessThan(0);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });

  it('picks the desktop dmg out of a release asset list', () => {
    const assets = [
      { name: 'MODELSWAP-1.1.0-arm64.dmg', url: 'dmg' },
      { name: 'MODELSWAP-1.1.0-arm64.dmg.sha256', url: 'dmgs' },
    ];
    const picked = pickAssets(assets);
    expect(picked.dmg?.url).toBe('dmg');
  });

  it('tolerates releases without a desktop dmg', () => {
    const picked = pickAssets([{ name: 'something-else.txt', url: 'x' }]);
    expect(picked.dmg).toBeNull();
  });

  it('only accepts safe release-asset download targets', () => {
    const target = downloadTarget('https://github.com/Cing-self/modelswap/releases/download/v1.1.0/MODELSWAP-1.1.0-arm64.dmg');
    expect(target.fileName).toBe('MODELSWAP-1.1.0-arm64.dmg');
    expect(() => downloadTarget('https://example.com/installer.dmg')).toThrow('仅允许下载本仓库');
  });
});
