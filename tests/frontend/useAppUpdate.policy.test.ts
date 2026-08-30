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
