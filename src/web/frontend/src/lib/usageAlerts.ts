// Usage alert detection + browser notification deduplication.
//
// Three alert tiers:
//   DANGER (red)   — remaining ≤ 10%
//   WARN (yellow)  — remaining ≤ 30%
//   INFO (blue)    — window resets within 1h with remaining quota unused
//
// Browser notifications fire once per (providerId + windowLabel + resetAt)
// combination so we don't spam. The key includes resetAt so that after a
// window resets and a new cycle starts, the alert can fire again.

export interface UsageWindowLike {
  label: string;
  usedPercent: number | null;
  resetAt: string | null;
  isPrepaid?: boolean;
  remainingCredits?: number | null;
  usedCredits?: number | null;
  unit?: string;
}

export interface UsageResultLike {
  windows?: UsageWindowLike[];
  kind?: 'subscription' | 'prepaid';
}

export interface AlertItem {
  providerId: string;
  providerName: string;
  windowLabel: string;
  severity: 'danger' | 'warn' | 'info';
  message: string;
  // Unique key for notification dedup (includes resetAt so it resets per cycle).
  notifyKey: string;
}

const DANGER_THRESHOLD = 10;  // remaining ≤ 10%
const WARN_THRESHOLD = 30;    // remaining ≤ 30%
const RESET_SOON_MS = 60 * 60 * 1000; // 1 hour before reset

export function computeRemaining(w: UsageWindowLike): number | null {
  if (w.isPrepaid) {
    if (w.remainingCredits != null) return null; // prepaid uses $ amounts, not %
    return null;
  }
  if (w.usedPercent == null) return null;
  return Math.max(0, Math.round((100 - w.usedPercent) * 10) / 10);
}

export function msUntilReset(resetAt: string | null): number | null {
  if (!resetAt) return null;
  const ms = new Date(resetAt).getTime() - Date.now();
  return ms > 0 ? ms : 0;
}

type AlertLocale = 'zh' | 'en';

export function formatTimeUntilReset(resetAt: string | null, locale: AlertLocale = 'zh'): string {
  const ms = msUntilReset(resetAt);
  if (ms == null || ms <= 0) return '';
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return locale === 'en' ? `${mins} min` : `${mins}分钟`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (locale === 'en') return remMins > 0 ? `${hours} hr ${remMins} min` : `${hours} hr`;
  return remMins > 0 ? `${hours}小时${remMins}分钟` : `${hours}小时`;
}

// Core alert detection: scans all usage data and returns alerts sorted by
// severity (danger first).
export function checkAlerts(
  usageMap: Record<string, UsageResultLike>,
  providerNames: Record<string, string>,
  locale: AlertLocale = 'zh',
): AlertItem[] {
  const alerts: AlertItem[] = [];

  for (const [providerId, usage] of Object.entries(usageMap)) {
    if (!usage?.windows?.length) continue;
    const name = providerNames[providerId] || providerId;

    for (const w of usage.windows) {
      // Prepaid: alert when balance ≤ $1
      if (w.isPrepaid) {
        const balance = w.remainingCredits;
        if (balance != null && balance <= 1) {
          const formattedBalance = !w.unit || w.unit.toUpperCase() === 'USD'
            ? `$${balance.toFixed(2)}`
            : `${balance.toFixed(2)} ${w.unit}`;
          alerts.push({
            providerId,
            providerName: name,
            windowLabel: w.label,
            severity: 'danger',
            message: locale === 'en'
              ? `${name} balance is down to ${formattedBalance}`
              : `${name} 余额仅剩 ${formattedBalance}`,
            notifyKey: `${providerId}:balance`,
          });
        }
        continue;
      }

      // Subscription: check remaining percentage
      const remaining = computeRemaining(w);
      if (remaining == null) continue;

      const msToReset = msUntilReset(w.resetAt);

      // Danger: remaining ≤ 10%
      if (remaining <= DANGER_THRESHOLD) {
        const resetText = formatTimeUntilReset(w.resetAt, locale);
        alerts.push({
          providerId,
          providerName: name,
          windowLabel: w.label,
          severity: 'danger',
          message: locale === 'en'
            ? resetText
              ? `${name} ${windowLabel(w.label, locale)} has ${remaining}% left (resets in ${resetText})`
              : `${name} ${windowLabel(w.label, locale)} has ${remaining}% left`
            : resetText
              ? `${name} ${windowLabel(w.label, locale)}仅剩 ${remaining}%（${resetText}后重置）`
              : `${name} ${windowLabel(w.label, locale)}仅剩 ${remaining}%`,
          notifyKey: `${providerId}:${w.label}:${w.resetAt || ''}`,
        });
        continue;
      }

      // Informational opportunity: resets within 1h with unused quota. This is
      // useful context, but not a failure state and must not paint the card red.
      if (msToReset != null && msToReset > 0 && msToReset <= RESET_SOON_MS && remaining > 0) {
        const resetText = formatTimeUntilReset(w.resetAt, locale);
        alerts.push({
          providerId,
          providerName: name,
          windowLabel: w.label,
          severity: 'info',
          message: locale === 'en'
            ? `${name} ${windowLabel(w.label, locale)} resets in ${resetText} with ${remaining}% unused`
            : `${name} ${windowLabel(w.label, locale)}将在 ${resetText}后重置，还有 ${remaining}% 未使用`,
          notifyKey: `${providerId}:${w.label}:${w.resetAt || ''}`,
        });
        continue;
      }

      // Warn: remaining ≤ 30%
      if (remaining <= WARN_THRESHOLD) {
        const resetText = formatTimeUntilReset(w.resetAt, locale);
        alerts.push({
          providerId,
          providerName: name,
          windowLabel: w.label,
          severity: 'warn',
          message: locale === 'en'
            ? resetText
              ? `${name} ${windowLabel(w.label, locale)} has ${remaining}% left (resets in ${resetText})`
              : `${name} ${windowLabel(w.label, locale)} has ${remaining}% left`
            : resetText
              ? `${name} ${windowLabel(w.label, locale)}剩余 ${remaining}%（${resetText}后重置）`
              : `${name} ${windowLabel(w.label, locale)}剩余 ${remaining}%`,
          notifyKey: `${providerId}:${w.label}:${w.resetAt || ''}`,
        });
      }
    }
  }

  // Sort: danger first, then warning, then informational notices.
  alerts.sort((a, b) => {
    const rank = { danger: 0, warn: 1, info: 2 } as const;
    if (a.severity !== b.severity) return rank[a.severity] - rank[b.severity];
    return a.providerName.localeCompare(b.providerName);
  });

  return alerts;
}

function windowLabel(label: string, locale: AlertLocale): string {
  const map: Record<string, string> = locale === 'en' ? {
    '5h': '5h window',
    'session': '5h window',
    'weekly': 'weekly window',
    '7d': '7-day window',
    'monthly': 'monthly window',
    'limit': 'quota',
    'credits': 'balance',
  } : {
    '5h': '5h窗口',
    'session': '5h窗口',
    'weekly': '周窗口',
    '7d': '7天窗口',
    'monthly': '月窗口',
    'limit': '额度',
    'credits': '余额',
  };
  return map[label] || label;
}

// ── Browser notification dedup ──────────────────────────────

const NOTIFIED_KEY = 'okit:usage:notified';

function getNotifiedSet(): Set<string> {
  try {
    const raw = localStorage.getItem(NOTIFIED_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function saveNotifiedSet(set: Set<string>) {
  try {
    // Prune: keep at most 200 keys to avoid unbounded growth.
    const arr = Array.from(set).slice(-200);
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify(arr));
  } catch { /* ignore quota errors */ }
}

export function shouldNotify(notifyKey: string): boolean {
  return !getNotifiedSet().has(notifyKey);
}

export function markNotified(notifyKey: string) {
  const set = getNotifiedSet();
  set.add(notifyKey);
  saveNotifiedSet(set);
}

// Fire browser notifications for new alerts (ones not previously notified).
// Requests permission on first call if not already granted/denied.
export async function fireNotifications(alerts: AlertItem[], locale: AlertLocale = 'zh') {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'default') {
    // Don't auto-request on page load — too aggressive. Only request when
    // there are actual danger alerts.
    const hasDanger = alerts.some(a => a.severity === 'danger');
    if (!hasDanger) return;
    await Notification.requestPermission();
  }
  if (Notification.permission !== 'granted') return;

  for (const alert of alerts) {
    if (alert.severity !== 'danger') continue; // only notify on danger
    if (!shouldNotify(alert.notifyKey)) continue;
    try {
      new Notification(locale === 'en' ? 'OKIT usage alert' : 'OKIT 用量预警', { body: alert.message });
      markNotified(alert.notifyKey);
    } catch { /* ignore */ }
  }
}
