import { describe, it, expect } from 'vitest';
import { parseSemVer, compareVersions, upgradeLevelLabel, upgradeAdvice } from '../../src/utils/semver';

describe('parseSemVer', () => {
  it('parses standard x.y.z', () => {
    const v = parseSemVer('1.2.3')!;
    expect(v).toEqual({ major: 1, minor: 2, patch: 3, raw: '1.2.3' });
  });

  it('parses version with v prefix', () => {
    const v = parseSemVer('v2.0.1')!;
    expect(v.major).toBe(2);
    expect(v.minor).toBe(0);
    expect(v.patch).toBe(1);
  });

  it('parses x.y as patch=0', () => {
    const v = parseSemVer('3.14')!;
    expect(v).toEqual({ major: 3, minor: 14, patch: 0, raw: '3.14' });
  });

  it('extracts version from complex output', () => {
    const v = parseSemVer('git version 2.50.1 (Apple Git-155)')!;
    expect(v.major).toBe(2);
    expect(v.minor).toBe(50);
    expect(v.patch).toBe(1);
  });

  it('extracts version from "Homebrew 5.1.3"', () => {
    const v = parseSemVer('Homebrew 5.1.3')!;
    expect(v.major).toBe(5);
    expect(v.patch).toBe(3);
  });

  it('returns null for empty string', () => {
    expect(parseSemVer('')).toBeNull();
  });

  it('returns null for no version', () => {
    expect(parseSemVer('no version here')).toBeNull();
  });
});

describe('compareVersions', () => {
  it('detects major upgrade', () => {
    expect(compareVersions({ major: 1, minor: 0, patch: 0, raw: '' }, { major: 2, minor: 0, patch: 0, raw: '' })).toBe('major');
  });

  it('detects minor upgrade', () => {
    expect(compareVersions({ major: 1, minor: 0, patch: 0, raw: '' }, { major: 1, minor: 1, patch: 0, raw: '' })).toBe('minor');
  });

  it('detects patch upgrade', () => {
    expect(compareVersions({ major: 1, minor: 2, patch: 0, raw: '' }, { major: 1, minor: 2, patch: 5, raw: '' })).toBe('patch');
  });

  it('returns unknown for same version', () => {
    expect(compareVersions({ major: 1, minor: 2, patch: 3, raw: '' }, { major: 1, minor: 2, patch: 3, raw: '' })).toBe('unknown');
  });

  it('returns unknown for downgrade', () => {
    expect(compareVersions({ major: 2, minor: 0, patch: 0, raw: '' }, { major: 1, minor: 0, patch: 0, raw: '' })).toBe('unknown');
  });
});

describe('upgradeLevelLabel', () => {
  it('returns Chinese labels by default', () => {
    expect(upgradeLevelLabel('patch')).toBe('补丁');
    expect(upgradeLevelLabel('minor')).toBe('次版本');
    expect(upgradeLevelLabel('major')).toBe('主版本');
    expect(upgradeLevelLabel('unknown')).toBe('未知');
  });

  it('returns English labels', () => {
    expect(upgradeLevelLabel('patch', 'en')).toBe('patch');
    expect(upgradeLevelLabel('major', 'en')).toBe('major');
  });
});

describe('upgradeAdvice', () => {
  it('returns Chinese advice by default', () => {
    expect(upgradeAdvice('patch')).toContain('安全升级');
    expect(upgradeAdvice('major')).toContain('breaking changes');
  });

  it('returns English advice', () => {
    expect(upgradeAdvice('patch', 'en')).toBe('Safe to auto-upgrade');
    expect(upgradeAdvice('major', 'en')).toContain('breaking changes');
  });
});
