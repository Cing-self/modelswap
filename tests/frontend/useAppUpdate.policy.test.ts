import { describe, expect, it } from 'vitest';
import { FOCUS_RECHECK_COOLDOWN_MS, shouldCheckOnFocus } from '../../src/web/frontend/src/hooks/useAppUpdate';

const MIN = 60 * 1000;

describe('focus re-check policy (useAppUpdate)', () => {
  it('uses a five-minute cooldown', () => {
    expect(FOCUS_RECHECK_COOLDOWN_MS).toBe(5 * MIN);
  });

  it('checks when no successful check has happened yet', () => {
    expect(shouldCheckOnFocus(null, 1_000_000)).toBe(true);
  });

  it('does not re-check within the cooldown window', () => {
    const now = 10 * MIN;
    expect(shouldCheckOnFocus(now - 4 * MIN, now)).toBe(false);
    expect(shouldCheckOnFocus(now - 5 * MIN, now)).toBe(false); // boundary: not strictly older
  });

  it('re-checks once the last successful check is older than the cooldown', () => {
    const now = 10 * MIN;
    expect(shouldCheckOnFocus(now - 5 * MIN - 1, now)).toBe(true);
    expect(shouldCheckOnFocus(now - 6 * MIN, now)).toBe(true);
  });
});

import { beginUpdateCheck, failUpdateCheck, UpdateState } from '../../src/web/frontend/src/hooks/useAppUpdate';

const AVAILABLE: UpdateState = {
  status: 'available',
  latest: 'v1.0.38',
  dmgUrl: 'https://github.com/Cing-self/okit/releases/download/v1.0.38/OKIT-1.0.38-arm64.dmg',
  releaseUrl: 'https://github.com/Cing-self/okit/releases/tag/v1.0.38',
  publishedAt: '2026-08-30',
  releaseNotes: null,
};

describe('check() state transitions (QA P0-2: silent checks never tear down a known update)', () => {
  it('keeps the available state (and release info) while a silent check is in flight', () => {
    expect(beginUpdateCheck(AVAILABLE, true)).toEqual(AVAILABLE);
  });

  it('keeps upToDate while a silent check is in flight', () => {
    expect(beginUpdateCheck({ status: 'upToDate' }, true)).toEqual({ status: 'upToDate' });
  });

  it('still shows checking for silent checks with nothing to protect', () => {
    expect(beginUpdateCheck({ status: 'idle' }, true)).toEqual({ status: 'checking' });
    expect(beginUpdateCheck({ status: 'error', error: 'x' }, true)).toEqual({ status: 'checking' });
  });

  it('shows checking for an explicit check even from available', () => {
    expect(beginUpdateCheck(AVAILABLE, false)).toEqual({ status: 'checking' });
  });

  it('does not re-enter while a check is already in flight', () => {
    expect(beginUpdateCheck({ status: 'checking' }, true)).toEqual({ status: 'checking' });
  });

  it('a FAILED silent check leaves the available state and release info intact', () => {
    expect(failUpdateCheck(AVAILABLE, true, 'network down')).toEqual(AVAILABLE);
  });

  it('a failed silent check leaves upToDate intact', () => {
    expect(failUpdateCheck({ status: 'upToDate' }, true, 'network down')).toEqual({ status: 'upToDate' });
  });

  it('a failed EXPLICIT check surfaces the error even from available', () => {
    expect(failUpdateCheck(AVAILABLE, false, 'network down')).toEqual({ status: 'error', error: 'network down' });
  });

  it('silent failures with no known-good state still record the error', () => {
    expect(failUpdateCheck({ status: 'idle' }, true, 'boom')).toEqual({ status: 'error', error: 'boom' });
  });
});
