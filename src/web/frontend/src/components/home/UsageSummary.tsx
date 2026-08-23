// Goal ②: a compact "today's usage" strip for the home dashboard.
//
// Surfaces remaining quota for all supported providers. Each card shows the REMAINING
// amount per window — not the used percentage — because "how much do I have
// left" is the daily-driver question. Subscription providers show every window
// they report (e.g. GLM shows both 5h and monthly; Codex shows 5h + weekly);
// prepaid providers show the dollar balance.

import { useEffect, useState, useCallback, useMemo } from 'react';
import { getUsage, getSupportedUsageProviders, listProviders, UsageResult, UsageWindow } from '../../api/providers';
import { useI18n } from '../../i18n';
import { useUsagePolling } from '../../lib/useUsagePolling';
import { useCoalescedUsageMap } from '../../lib/useCoalescedUsageMap';
import { checkAlerts, fireNotifications } from '../../lib/usageAlerts';
import { useNavigate } from 'react-router-dom';
import { getProviderIcon, getProviderIconClass } from '../../assets/providers';

// Home prioritizes the shortest actionable window. When a provider reports
// more than two windows, show 5h first, then weekly (or monthly as fallback).
const WINDOW_PRIORITY: Record<string, number> = {
  '5h': 0,
  'session': 0,
  'weekly': 1,
  '7d': 1,
  'monthly': 2,
};

function prioritizedWindows(windows: UsageWindow[]): UsageWindow[] {
  return windows
    .map((window, index) => ({ window, index }))
    .sort((a, b) => {
      const priorityDiff = (WINDOW_PRIORITY[a.window.label] ?? 3) - (WINDOW_PRIORITY[b.window.label] ?? 3);
      return priorityDiff || a.index - b.index;
    })
    .map(({ window }) => window);
}

// Remaining percent drives the card's border color (red when nearly exhausted).
function toneForRemaining(remainingPct: number | null): string {
  if (remainingPct == null) return 'unknown';
  if (remainingPct <= 10) return 'danger';
  if (remainingPct <= 30) return 'warn';
  return 'ok';
}

function remainingPercent(window: UsageWindow): number | null {
  return window.usedPercent == null ? null : Math.max(0, Math.min(100, Math.round(100 - window.usedPercent)));
}

function compactAlertMessage(message: string, providerName: string): string {
  const prefix = `${providerName} `;
  const compact = message.startsWith(prefix) ? message.slice(prefix.length) : message;
  return compact
    .replace('将在 ', '')
    .replace('后重置，还有 ', '后重置 · ')
    .replace(' 未使用', ' 未用');
}

type UsageCard = {
  id: string;
  name: string;
  usage: UsageResult;
  tone: string;
};

type Translate = (key: string, params?: Record<string, string | number>) => string;
type UsageKind = 'quota' | 'balance';
const GROUP_PAGE_SIZE = 8;

function compactWindowLabel(label: string, t: Translate): string {
  const keys: Record<string, string> = {
    '5h': 'usage.window5hShort',
    'session': 'usage.window5hShort',
    'weekly': 'usage.windowWeeklyShort',
    '7d': 'usage.window7dShort',
    'monthly': 'usage.windowMonthlyShort',
    'limit': 'usage.windowLimit',
    'credits': 'usage.windowBalance',
  };
  return keys[label] ? t(keys[label]) : label;
}

function compactPrimaryValue(u: UsageResult, t: Translate): { value: string; detail: string } {
  const windows = prioritizedWindows(u.windows || []);
  const first = windows[0];

  if (u.kind === 'prepaid') {
    const value = first?.remainingCredits != null
      ? (first.unit ? `${first.remainingCredits.toFixed(2)} ${first.unit}` : `$${first.remainingCredits.toFixed(2)}`)
      : '—';
    return { value, detail: t('home.usageBalance') };
  }

  if (first?.unit) {
    return {
      value: first.remainingCredits != null ? `${first.remainingCredits.toFixed(2)} ${first.unit}` : '—',
      detail: t('home.usageRemaining'),
    };
  }

  const remaining = first ? remainingPercent(first) : null;
  const detail = windows.slice(0, 2).map(w => {
    const pct = remainingPercent(w);
    return `${compactWindowLabel(w.label, t)} ${pct != null ? `${pct}%` : '?'}`;
  }).join(' · ');
  return { value: remaining != null ? `${remaining}%` : '—', detail };
}

function UsageGroupItem({ card, t }: { card: UsageCard; alert?: ReturnType<typeof checkAlerts>[number]; t: Translate }) {
  // Card color communicates remaining capacity only. A reset-soon notice is
  // informational and should never turn a healthy 100% card red.
  const tone = card.tone;
  const primary = compactPrimaryValue(card.usage, t);
  const firstWindow = prioritizedWindows(card.usage.windows || [])[0];
  const detail = card.usage.kind !== 'prepaid' && firstWindow?.unit && firstWindow.usedPercent != null
    ? `${t('home.usageRemaining')} · ${t('home.usageUsed')} ${firstWindow.usedPercent.toFixed(1)}%`
    : primary.detail;

  return (
    <article className={`usage-summary-group-item usage-summary-group-item--${tone}`}>
      <div className="usage-summary-group-item-head">
        <div className="usage-summary-provider">
          {getProviderIcon(card.id) && <img src={getProviderIcon(card.id)} alt="" className={getProviderIconClass(card.id)} />}
          <span>{card.name}</span>
        </div>
        <span className={`usage-summary-group-tone usage-summary-group-tone--${tone}`} aria-hidden="true" />
      </div>
      <div className="usage-summary-group-value">
        <strong>{primary.value}</strong>
        <span>{detail}</span>
      </div>
    </article>
  );
}

export default function UsageSummary() {
  const { t, lang, providerName: translateProviderName } = useI18n();
  const navigate = useNavigate();
  const [supportedIds, setSupportedIds] = useState<string[]>([]);
  // Browser-driving usage queries (extension automation) — never auto-fetch.
  const [manualOnlyIds, setManualOnlyIds] = useState<Set<string>>(new Set());
  const { usageMap, enqueue } = useCoalescedUsageMap();
  // Provider display names from API (single source of truth = presets.ts).
  const [providerNames, setProviderNames] = useState<Record<string, string>>({});

  useEffect(() => {
    getSupportedUsageProviders()
      .then(sup => {
        setSupportedIds(sup.providers || []);
        setManualOnlyIds(new Set(sup.manualOnly || []));
      })
      .catch(() => {});
    // Load provider names from API (derived from presets.ts — single source).
    listProviders()
      .then(res => {
        const map: Record<string, string> = {};
        for (const p of res.providers || []) map[p.id] = translateProviderName(p.id, p.name);
        setProviderNames(map);
      })
      .catch(() => {});
  }, [translateProviderName]);

  // Silent polling via shared hook (5-min base, 1-min if reset is imminent).
  const handlePollResult = useCallback((id: string, result: UsageResult) => {
    enqueue(id, result);
  }, [enqueue]);

  useUsagePolling({
    supportedIds,
    onResult: handlePollResult,
    silent: true,
    skipIds: [...manualOnlyIds],
  });

  // Compute alerts + fire browser notifications.
  const usageLoaded = supportedIds.length > 0 && supportedIds.every(id => usageMap[id] !== undefined);
  const alerts = useMemo(() => checkAlerts(usageMap, providerNames, lang), [usageMap, providerNames, lang]);
  const [dismissedKeys, setDismissedKeys] = useState<Set<string>>(new Set());
  const [alertCenterOpen, setAlertCenterOpen] = useState(false);
  const visibleAlerts = alerts.filter(a => !dismissedKeys.has(a.notifyKey));
  const alertTone = visibleAlerts.some(alert => alert.severity === 'danger')
    ? 'danger'
    : visibleAlerts.some(alert => alert.severity === 'warn') ? 'warn' : 'info';
  const [activeKind, setActiveKind] = useState<UsageKind>('quota');
  const [quotaPage, setQuotaPage] = useState(0);
  const [balancePage, setBalancePage] = useState(0);

  useEffect(() => {
    if (alerts.length > 0) {
      fireNotifications(alerts, lang);
    }
  }, [alerts, lang]);

  // Build cards: only include providers that actually have usable data
  // (windows present, or a meaningful balance). Skip providers whose only
  // signal is an error/empty — they would clutter the strip with "—" cards.
  const cards: UsageCard[] = supportedIds
    .filter(id => {
      const u = usageMap[id];
      if (!u || u.supported === false) return false;
      const hasWindows = (u.windows?.length || 0) > 0;
      return hasWindows;
    })
    .map(id => {
      const u = usageMap[id];
      // Card border color = the worst (lowest remaining) window's tone.
      let cardTone = 'unknown';
      if (u?.kind === 'prepaid') {
        const w = u.windows?.[0];
        const rem = w?.remainingCredits != null
          ? w.remainingCredits
          : w?.limitCredits != null && w.usedCredits != null
            ? w.limitCredits - w.usedCredits
            : null;
        const remainingPct = rem != null && w?.limitCredits != null && w.limitCredits > 0
          ? Math.min(100, Math.max(0, (rem / w.limitCredits) * 100))
          : rem != null && rem <= 0 ? 0 : null;
        cardTone = toneForRemaining(remainingPct);
      } else {
        for (const w of u?.windows || []) {
          const remaining = w.usedPercent != null ? 100 - w.usedPercent : null;
          const wt = toneForRemaining(remaining);
          // danger > warn > ok > unknown
          if (wt === 'danger') cardTone = 'danger';
          else if (wt === 'warn' && cardTone !== 'danger') cardTone = 'warn';
          else if (wt === 'ok' && cardTone !== 'danger' && cardTone !== 'warn') cardTone = 'ok';
        }
      }
      return { id, name: providerNames[id] || id, usage: u, tone: cardTone };
    });

  const quotaCards = cards.filter(card => card.usage.kind !== 'prepaid');
  const balanceCards = cards.filter(card => card.usage.kind === 'prepaid');
  const activeCards = activeKind === 'quota' ? quotaCards : balanceCards;
  const activePage = activeKind === 'quota' ? quotaPage : balancePage;
  const setActivePage = activeKind === 'quota' ? setQuotaPage : setBalancePage;
  const activePageCount = Math.max(1, Math.ceil(activeCards.length / GROUP_PAGE_SIZE));
  const safeActivePage = Math.min(activePage, activePageCount - 1);
  const pageCards = activeCards.slice(
    safeActivePage * GROUP_PAGE_SIZE,
    (safeActivePage + 1) * GROUP_PAGE_SIZE,
  );
  const usesTwoRows = pageCards.length > 4;
  const activeTitle = activeKind === 'quota' ? t('home.usageQuotaGroup') : t('home.usageBalanceGroup');

  if (cards.length === 0) return null;

  return (
    <section className="home-section usage-summary-section">
      <div className="usage-summary-heading">
        <div className="home-section-title">{t('home.usageSummary')}</div>
        <div className="usage-summary-heading-actions">
          {usageLoaded && visibleAlerts.length > 0 && (
            <div className="usage-summary-alert-center">
              <button
                type="button"
                className={`usage-summary-alert-toggle usage-summary-alert-toggle--${alertTone}${alertCenterOpen ? ' is-open' : ''}`}
                onClick={() => setAlertCenterOpen(open => !open)}
                aria-expanded={alertCenterOpen}
                aria-controls="usage-summary-alert-list"
              >
                <span className="usage-summary-alert-toggle-dot" aria-hidden="true" />
                <span>{visibleAlerts.length} {t('home.usageAttention')}</span>
              </button>
              {alertCenterOpen && (
                <div id="usage-summary-alert-list" className="usage-summary-alert-popover" role="region" aria-label={t('home.usageAttention')}>
                  <div className="usage-summary-alert-popover-title">{t('home.usageAttention')}</div>
                  {visibleAlerts.map(alert => (
                    <div key={alert.notifyKey} className={`usage-summary-alert-item usage-summary-alert-item--${alert.severity}`}>
                      <span className="usage-summary-alert-item-dot" aria-hidden="true" />
                      <div className="usage-summary-alert-item-content">
                        <strong>{alert.providerName}</strong>
                        <span title={alert.message}>{compactAlertMessage(alert.message, alert.providerName)}</span>
                      </div>
                      <button
                        type="button"
                        className="usage-summary-alert-item-close"
                        onClick={() => setDismissedKeys(prev => new Set(prev).add(alert.notifyKey))}
                        aria-label={t('usage.dismissAlert')}
                        title={t('usage.dismissAlert')}
                      >×</button>
                    </div>
                  ))}
                  <button type="button" className="usage-summary-alert-all" onClick={() => navigate('/usage')}>
                    {t('usage.viewAll')} <span aria-hidden="true">↗</span>
                  </button>
                </div>
              )}
            </div>
          )}
          <button type="button" className="usage-summary-link" onClick={() => navigate('/usage')}>
            {t('usage.viewAll')} <span aria-hidden="true">↗</span>
          </button>
        </div>
      </div>
      <div className="usage-summary-toolbar">
        <div className="usage-summary-kind-switch" role="tablist" aria-label={t('home.usageSummary')}>
          <button
            type="button"
            role="tab"
            aria-selected={activeKind === 'quota'}
            className={activeKind === 'quota' ? 'is-active' : ''}
            onClick={() => setActiveKind('quota')}
          >
            <span className="usage-summary-kind-mark usage-summary-kind-mark--quota" aria-hidden="true" />
            {t('home.usageQuotaGroup')}
            <span className="usage-summary-kind-count">{usageLoaded ? quotaCards.length : '—'}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeKind === 'balance'}
            className={activeKind === 'balance' ? 'is-active' : ''}
            onClick={() => setActiveKind('balance')}
          >
            <span className="usage-summary-kind-mark usage-summary-kind-mark--balance" aria-hidden="true" />
            {t('home.usageBalanceGroup')}
            <span className="usage-summary-kind-count">{usageLoaded ? balanceCards.length : '—'}</span>
          </button>
        </div>
        {activePageCount > 1 && (
          <div className="usage-summary-group-pager" aria-label={activeTitle}>
            <button type="button" onClick={() => setActivePage(safeActivePage - 1)} disabled={safeActivePage === 0} aria-label={t('home.usagePreviousPage')}>‹</button>
            <span>{safeActivePage + 1} / {activePageCount}</span>
            <button type="button" onClick={() => setActivePage(safeActivePage + 1)} disabled={safeActivePage === activePageCount - 1} aria-label={t('home.usageNextPage')}>›</button>
          </div>
        )}
      </div>
      <section className={`usage-summary-group usage-summary-group--${activeKind}`} role="tabpanel" aria-label={activeTitle}>
        <div className={`usage-summary-group-grid usage-summary-group-grid--items-${pageCards.length}${usesTwoRows ? ' usage-summary-group-grid--two-rows' : ''}`}>
          {pageCards.map(card => (
            <UsageGroupItem
              key={card.id}
              card={card}
              alert={visibleAlerts.find(item => item.providerId === card.id)}
              t={t}
            />
          ))}
          {pageCards.length === 0 && <div className="usage-summary-empty">{t('usage.empty')}</div>}
        </div>
      </section>
    </section>
  );
}
