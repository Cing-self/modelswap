import type { UsageResult, UsageWindow } from '../../api/providers';
import type { UsageTranslate } from './usageCatalog';

/**
 * A console/CLI result with an action is an external hand-off, not a failed
 * usage request. Providers use either `notice` or `error` for the human
 * explanation while their public balance endpoint is unavailable.
 */
export function isExternalUsageNotice(usage?: UsageResult): boolean {
  return Boolean(
    usage?.action &&
      (usage.source === 'console' || usage.source === 'cli') &&
      (usage.error || usage.notice),
  );
}

/** Terminal console hand-offs have no meaningful refresh operation. */
export function isConsoleOnlyUsage(usage?: UsageResult): boolean {
  return usage?.refreshPolicy === 'never';
}

/** Manual browser/CLI results are available only from an explicit refresh. */
export function shouldSkipAutomaticUsageRefresh(usage?: UsageResult): boolean {
  return usage?.refreshPolicy === 'manual' || isConsoleOnlyUsage(usage);
}

export function refreshableUsageIds(
  providerIds: string[],
  usageMap: Record<string, UsageResult | undefined>,
): string[] {
  return providerIds.filter((id) => !isConsoleOnlyUsage(usageMap[id]));
}

export function isGuidedConfigurationMessage(message?: string): boolean {
  if (!message) return false;
  return /(AK\/SK|SecretId|SecretKey|_[A-Z0-9_]*(?:CREDENTIALS|ACCESS_KEY|SECRET_KEY|TEAM_ID)|密钥管理|管理凭证|查询权限|手动添加|手动录入|授予)/i.test(
    message,
  );
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function formatBalanceAmount(value: number, unit?: string): string {
  if (!unit || unit.toUpperCase() === 'USD') return `$${value.toFixed(2)}`;
  return `${value.toFixed(2)} ${unit}`;
}

export function formatLastUpdated(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function compactAlertMessage(
  message: string,
  providerName: string,
): string {
  const prefix = `${providerName} `;
  const compact = message.startsWith(prefix)
    ? message.slice(prefix.length)
    : message;
  return compact
    .replace('将在 ', '')
    .replace('后重置，还有 ', '后重置 · ')
    .replace(' 未使用', ' 未用');
}

export function getPrepaidRemainingPercent(w: UsageWindow): number | null {
  if (!w.isPrepaid) return null;
  const remaining =
    w.remainingCredits != null
      ? w.remainingCredits
      : w.limitCredits != null && w.usedCredits != null
        ? w.limitCredits - w.usedCredits
        : null;
  if (remaining == null) return null;
  if (w.limitCredits != null && w.limitCredits > 0)
    return Math.min(
      100,
      Math.max(0, round1((remaining / w.limitCredits) * 100)),
    );
  return remaining <= 0 ? 0 : null;
}

export function usageSeverity(w: UsageWindow): number {
  if (w.isPrepaid) {
    const amount =
      w.remainingCredits != null
        ? w.remainingCredits
        : w.limitCredits != null && w.usedCredits != null
          ? w.limitCredits - w.usedCredits
          : null;
    if (amount != null && amount <= 1) return 2;
    const remaining = getPrepaidRemainingPercent(w);
    if (remaining != null && remaining <= 10) return 2;
    if (remaining != null && remaining <= 30) return 1;
    return 0;
  }
  if (w.usedPercent == null) return 0;
  if (w.usedPercent >= 90) return 2;
  if (w.usedPercent >= 70) return 1;
  return 0;
}

export function windowLabel(label: string, t: UsageTranslate): string {
  const map: Record<string, string> = {
    '5h': t('usage.window5h'),
    session: t('usage.window5h'),
    weekly: t('usage.windowWeekly'),
    monthly: t('usage.windowMonthly'),
    limit: t('usage.windowLimit'),
    credits: t('usage.windowBalance'),
  };
  return map[label] || label;
}

export function formatResetTime(iso: string, t: UsageTranslate): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    if (d.getTime() - now.getTime() <= 0) return '';
    const sameDay = d.toDateString() === now.toDateString();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const hhmm = d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    if (sameDay) return hhmm;
    if (d.toDateString() === tomorrow.toDateString())
      return t('usage.resetTomorrow', { time: hhmm });
    return `${d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })} ${hhmm}`;
  } catch {
    return '';
  }
}
