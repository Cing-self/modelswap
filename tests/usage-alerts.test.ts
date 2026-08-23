import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkAlerts } from '../src/web/frontend/src/lib/usageAlerts';

describe('usage alert severity', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T04:00:00.000Z'));
  });

  afterEach(() => vi.useRealTimers());

  it('treats a reset-soon window with healthy quota as informational', () => {
    const alerts = checkAlerts({
      demo: {
        windows: [{
          label: '5h',
          usedPercent: 0,
          resetAt: '2026-08-21T04:30:00.000Z',
        }],
      },
    }, { demo: 'Demo' });

    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('info');
  });

  it('keeps nearly exhausted quota at danger even when reset is near', () => {
    const alerts = checkAlerts({
      demo: {
        windows: [{
          label: '5h',
          usedPercent: 95,
          resetAt: '2026-08-21T04:30:00.000Z',
        }],
      },
    }, { demo: 'Demo' });

    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('danger');
  });

  it('uses the balance currency reported by prepaid providers', () => {
    const alerts = checkAlerts({
      tencent: {
        windows: [{
          label: 'credits',
          usedPercent: null,
          resetAt: null,
          isPrepaid: true,
          remainingCredits: 1,
          unit: 'CNY',
        }],
      },
    }, { tencent: '腾讯云' });

    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toContain('1.00 CNY');
    expect(alerts[0].message).not.toContain('$1.00');
  });

  it('localizes alert messages for the English interface', () => {
    const alerts = checkAlerts({
      demo: {
        windows: [{
          label: 'weekly',
          usedPercent: 95,
          resetAt: '2026-08-21T04:30:00.000Z',
        }],
      },
    }, { demo: 'Demo' }, 'en');

    expect(alerts[0].message).toContain('weekly window');
    expect(alerts[0].message).toContain('resets in 30 min');
    expect(alerts[0].message).not.toMatch(/[一-龥]/);
  });
});
