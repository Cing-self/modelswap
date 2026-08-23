import { useEffect, useState, useCallback, useMemo, type FormEvent, type ReactNode } from 'react';
import { getUsage, getSupportedUsageProviders, listProviders, openUsageLogin, UsageResult, UsageWindow, Provider } from '../../api/providers';
import { setVault } from '../../api/vault';
import { useApp } from '../Layout/AppContext';
import { useI18n } from '../../i18n';
import { useUsagePolling } from '../../lib/useUsagePolling';
import { useCoalescedUsageMap } from '../../lib/useCoalescedUsageMap';
import { checkAlerts, fireNotifications } from '../../lib/usageAlerts';
import { getProviderIcon, getProviderIconClass } from '../../assets/providers';

// Display metadata for known supported providers (icon + human-readable name).
const PROVIDER_META: Record<string, { name: string; typeKey: string; kind: 'subscription' | 'prepaid' }> = {
  'openai': { name: 'OpenAI API', typeKey: 'usage.typeApiPlatform', kind: 'prepaid' },
  'openai-codex': { name: 'Codex (ChatGPT)', typeKey: 'usage.typeAgentSubscription', kind: 'subscription' },
  'anthropic': { name: 'Anthropic API', typeKey: 'usage.typeApiPlatform', kind: 'prepaid' },
  'anthropic-agent': { name: 'Claude Code', typeKey: 'usage.typeAgentSubscription', kind: 'subscription' },
  'xai-grok-build': { name: 'SuperGrok', typeKey: 'usage.typeAgentSubscription', kind: 'subscription' },
  'github-copilot': { name: 'GitHub Copilot', typeKey: 'usage.typeAgentSubscription', kind: 'subscription' },
  'glm-coding': { name: 'GLM Coding Plan', typeKey: 'usage.typeCodingPlan', kind: 'subscription' },
  'zai-global-coding': { name: 'Z.AI Coding Plan', typeKey: 'usage.typeCodingPlan', kind: 'subscription' },
  'kimi-coding-plan': { name: 'Kimi Coding Plan', typeKey: 'usage.typeCodingPlan', kind: 'subscription' },
  'minimax-coding': { name: 'MiniMax Token Plan', typeKey: 'usage.typeTokenPlan', kind: 'subscription' },
  'minimax-global-coding': { name: 'MiniMax Token Plan（国际）', typeKey: 'usage.typeTokenPlan', kind: 'subscription' },
  'minimax': { name: 'MiniMax', typeKey: 'usage.typeApiPlatform', kind: 'prepaid' },
  'minimax-global': { name: 'MiniMax（国际站）', typeKey: 'usage.typeApiPlatform', kind: 'prepaid' },
  'zai': { name: '智谱 AI（国内站）', typeKey: 'usage.typeApiPlatform', kind: 'prepaid' },
  'zai-global': { name: 'Z.AI（国际站）', typeKey: 'usage.typeApiPlatform', kind: 'prepaid' },
  'kimi-coding': { name: 'Kimi', typeKey: 'usage.typeApiPlatform', kind: 'prepaid' },
  'qwen-coding': { name: '阿里云百炼 Coding Plan', typeKey: 'usage.typeCodingPlan', kind: 'subscription' },
  'qwen-token-plan': { name: '阿里云百炼 Token Plan', typeKey: 'usage.typeTokenPlan', kind: 'subscription' },
  'qianfan-coding': { name: '百度千帆 Token Plan', typeKey: 'usage.typeTokenPlan', kind: 'subscription' },
  'qianfan': { name: '百度千帆', typeKey: 'usage.typeApiPlatform', kind: 'prepaid' },
  'tencent-token-plan': { name: '腾讯云 Token Plan', typeKey: 'usage.typeTokenPlan', kind: 'subscription' },
  'tencent': { name: '腾讯云', typeKey: 'usage.typeApiPlatform', kind: 'prepaid' },
  'opencode-go': { name: 'OpenCode Go', typeKey: 'usage.typeAgentSubscription', kind: 'subscription' },
  'volcengine-coding': { name: '火山引擎 Coding Plan', typeKey: 'usage.typeCodingPlan', kind: 'subscription' },
  'volcengine-agent': { name: '火山引擎 Agent Plan', typeKey: 'usage.typeAgentPlan', kind: 'subscription' },
  'volcengine': { name: '火山引擎', typeKey: 'usage.typeApiPlatform', kind: 'prepaid' },
  'xiaomi-coding': { name: '小米 MiMo Token Plan', typeKey: 'usage.typeTokenPlan', kind: 'subscription' },
  'xiaomi': { name: '小米 MiMo API', typeKey: 'usage.typeApiPlatform', kind: 'prepaid' },
  'xai': { name: 'xAI API', typeKey: 'usage.typeApiPlatform', kind: 'prepaid' },
  'stepfun': { name: '阶跃星辰', typeKey: 'usage.typeApiPlatform', kind: 'prepaid' },
  'stepfun-global': { name: 'StepFun Global', typeKey: 'usage.typeApiPlatform', kind: 'prepaid' },
  // Goal ①: prepaid balance providers.
  'openrouter': { name: 'OpenRouter', typeKey: 'usage.typePrepaid', kind: 'prepaid' },
  'deepseek': { name: 'DeepSeek', typeKey: 'usage.typePrepaid', kind: 'prepaid' },
  'siliconflow': { name: '硅基流动', typeKey: 'usage.typePrepaid', kind: 'prepaid' },
  'moonshot': { name: 'Moonshot', typeKey: 'usage.typePrepaid', kind: 'prepaid' },
  'mistral': { name: 'Mistral', typeKey: 'usage.typePrepaid', kind: 'prepaid' },
  'qwen': { name: '通义千问', typeKey: 'usage.typePrepaid', kind: 'prepaid' },
};

type CloudBalanceGuide = 'aliyun-billing' | 'baidu-billing' | 'tencent-billing';
type CredentialGuide = 'volcengine' | CloudBalanceGuide;
type CredentialGuideContext = { guide: CredentialGuide; providerId: string };
type SaveUsageCredentials = (input: {
  providerId: string;
  key: string;
  value: string;
  group: string;
}) => Promise<UsageResult>;

export default function UsagePage() {
  const { showToast: toast } = useApp() as any;
  const { t, lang, providerName: translateProviderName } = useI18n();
  _t = t; // expose t to UsageBar which renders outside the hook scope
  const [credentialGuide, setCredentialGuide] = useState<CredentialGuideContext | null>(null);
  const [supportedIds, setSupportedIds] = useState<string[]>([]);
  // Providers whose usage query drives the browser (opencode-go navigates the
  // automation window). They never auto-run — only on explicit user action.
  const [manualOnlyIds, setManualOnlyIds] = useState<Set<string>>(new Set());
  // Distinguish "metadata still loading" (skeleton) from "loaded, nothing supported" (empty state).
  const [metaLoaded, setMetaLoaded] = useState(false);
  const [providers, setProviders] = useState<Provider[]>([]);
  const { usageMap, enqueue } = useCoalescedUsageMap();
  const [fetchingIds, setFetchingIds] = useState<Set<string>>(new Set());
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [showSecondary, setShowSecondary] = useState(false);
  // Goal ①: subscription vs prepaid split. Defaults to subscription (the
  // historically-supported set); the tab surfaces the new balance providers.
  const [usageMode, setUsageMode] = useState<'subscription' | 'prepaid'>('subscription');

  // Load supported provider IDs and the full provider list (for display names).
  // manualOnly = providers whose query drives the browser (extension
  // automation window) — excluded from every automatic fetch.
  useEffect(() => {
    Promise.all([getSupportedUsageProviders(), listProviders()])
      .then(([sup, provData]) => {
        setSupportedIds(sup.providers || []);
        setManualOnlyIds(new Set(sup.manualOnly || []));
        setProviders(provData.providers || []);
      })
      .catch(() => {})
      .finally(() => setMetaLoaded(true));
  }, []);

  const fetchOne = useCallback(async (id: string) => {
    setFetchingIds(prev => new Set(prev).add(id));
    try {
      const res = await getUsage(id);
      enqueue(id, res);
    } catch (err: any) {
      enqueue(id, { supported: true, error: err.message });
    } finally {
      setFetchingIds(prev => { const n = new Set(prev); n.delete(id); return n; });
      setLastUpdatedAt(new Date());
    }
  }, []);

  const saveAndTestCredentials = useCallback<SaveUsageCredentials>(async ({ providerId, key, value, group }) => {
    await setVault({
      key,
      value,
      group,
      desc: t('usage.credentials.description'),
    });

    setFetchingIds(prev => new Set(prev).add(providerId));
    try {
      const result = await getUsage(providerId);
      enqueue(providerId, result);
      return result;
    } catch (error: any) {
      const result: UsageResult = { supported: true, error: error?.message || t('usage.credentials.testFailed') };
      enqueue(providerId, result);
      return result;
    } finally {
      setFetchingIds(prev => { const next = new Set(prev); next.delete(providerId); return next; });
    }
  }, [t]);

  // Silent polling: auto-refresh every 5 min (or 1 min if a reset is imminent).
  // Uses the shared hook — updates usageMap without toggling fetchingIds.
  // Manual-only providers are excluded from ALL automatic fetches (mount +
  // interval) via skipIds; they only run from explicit user actions.
  const providerNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of providers) map[p.id] = translateProviderName(p.id, p.name);
    return map;
  }, [providers, translateProviderName]);

  const handlePollResult = useCallback((id: string, result: UsageResult) => {
    enqueue(id, result);
    setLastUpdatedAt(new Date());
  }, [enqueue]);

  useUsagePolling({
    supportedIds,
    onResult: handlePollResult,
    silent: true,
    skipIds: [...manualOnlyIds],
  });

  // Manual "refresh all" button — an explicit user action, so manual-only
  // providers (browser-driving queries) are included.
  const handleManualRefresh = useCallback(() => {
    for (const id of supportedIds) fetchOne(id);
  }, [supportedIds, fetchOne]);

  // Compute alerts from the latest usage data.
  const alerts = useMemo(() => checkAlerts(usageMap, providerNames, lang), [usageMap, providerNames, lang]);
  // Track dismissed alerts so the banner doesn't reappear after user closes it.
  const [dismissedAlertKeys, setDismissedAlertKeys] = useState<Set<string>>(new Set());
  const [alertCenterOpen, setAlertCenterOpen] = useState(false);
  const visibleAlerts = alerts.filter(a => !dismissedAlertKeys.has(a.notifyKey));

  // Fire browser notifications when new danger alerts appear.
  useEffect(() => {
    if (alerts.length > 0) {
      fireNotifications(alerts, lang);
    }
  }, [alerts, lang]);

  function providerName(id: string): string {
    // Provider name comes from presets.ts via the providers API — single
    // source of truth. Don't hardcode display names in PROVIDER_META.
    const p = providers.find(x => x.id === id);
    return translateProviderName(id, p?.name || PROVIDER_META[id]?.name || id);
  }

  function providerType(id: string): string {
    const key = PROVIDER_META[id]?.typeKey;
    return key ? t(key) : '';
  }

  async function handleUsageLogin(providerId: string) {
    try {
      const result = await openUsageLogin(providerId);
      if (!result.success) toast(result.error || t('usage.loginOpenFailed'), 'error');
    } catch (error: any) {
      toast(error?.message || t('usage.loginOpenFailed'), 'error');
    }
  }

  const allCards = supportedIds.map(id => ({
    id,
    name: providerName(id),
    type: providerType(id),
    // kind is stamped by the usage API response; fall back to PROVIDER_META.
    kind: usageMap[id]?.kind || PROVIDER_META[id]?.kind || 'subscription',
    usage: usageMap[id],
    fetching: fetchingIds.has(id),
  }));

  // Goal ①: split by kind for the subscription/prepaid tabs.
  const subscriptionCards = allCards.filter(c => c.kind === 'subscription');
  const prepaidCards = allCards.filter(c => c.kind === 'prepaid');
  const modeCards = usageMode === 'subscription' ? subscriptionCards : prepaidCards;
  const modeIds = new Set(modeCards.map(card => card.id));
  const modeAlerts = visibleAlerts.filter(alert => modeIds.has(alert.providerId));
  const modeAlertRank = new Map(modeAlerts.map(alert => [alert.providerId, alert.severity === 'danger' ? 0 : alert.severity === 'warn' ? 1 : 2]));
  const visibleCards = [...modeCards].sort((a, b) => {
    const score = (card: typeof a) => modeAlertRank.get(card.id)
      ?? (card.usage?.windows?.length ? 3 : card.fetching ? 4 : card.usage?.error ? 5 : card.usage?.notice ? 6 : 7);
    return score(a) - score(b);
  });
  const liveCards = visibleCards.filter(card => card.fetching || (card.usage?.windows?.length || 0) > 0);
  const secondaryCards = visibleCards.filter(card => !card.fetching && !(card.usage?.windows?.length || 0));
  const usageOverviewReady = metaLoaded && modeCards.every(card => card.usage !== undefined);
  const alertToneForMode = modeAlerts.length === 0
    ? 'ok'
    : modeAlerts.some(alert => alert.severity === 'danger')
      ? 'danger'
      : modeAlerts.some(alert => alert.severity === 'warn') ? 'warn' : 'info';

  useEffect(() => {
    setShowSecondary(false);
    setAlertCenterOpen(false);
  }, [usageMode]);

  const revealAlertCard = (providerId: string) => {
    setShowSecondary(true);
    setAlertCenterOpen(false);
    window.requestAnimationFrame(() => {
      document.getElementById(`usage-card-${providerId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };

  return (
    <div className="access-workspace usage-workspace">
      <header className="usage-page-header">
        <div>
          <span className="usage-page-eyebrow">{t('usage.pageEyebrow')}</span>
          <h1 className="sr-only">{t('usage.pageTitle')}</h1>
          <p>{t('usage.pageSubtitle')}</p>
        </div>
        <div className="usage-page-header-side">
          <div className="usage-page-refresh-meta">
            <span>{t('usage.lastRefresh')}</span>
            <strong>{lastUpdatedAt ? formatLastUpdated(lastUpdatedAt) : t('usage.waitingForData')}</strong>
          </div>
          <section className="usage-overview" aria-label={t('usage.overview')}>
            <div className="usage-overview-item usage-overview-item--primary">
              <span>{t('usage.readable')}</span>
              <strong>{usageOverviewReady ? liveCards.filter(card => !card.fetching).length : '—'}</strong>
              <small>{usageOverviewReady ? t('usage.ofProviders', { total: visibleCards.length }) : t('usage.loading')}</small>
            </div>
            <button
              type="button"
              className={`usage-overview-item usage-overview-item--alert usage-overview-item--${alertToneForMode}`}
              onClick={() => modeAlerts.length > 0 && setAlertCenterOpen(open => !open)}
              disabled={!usageOverviewReady || modeAlerts.length === 0}
            >
              <span>{t('usage.needsAttention')}</span>
              <strong>{usageOverviewReady ? modeAlerts.length : '—'}</strong>
              <small>{usageOverviewReady ? (modeAlerts.length > 0 ? t('usage.reviewNow') : t('usage.allHealthy')) : t('usage.loading')}</small>
            </button>
            <button
              type="button"
              className="usage-overview-item usage-overview-item--secondary"
              onClick={() => setShowSecondary(open => !open)}
              disabled={!usageOverviewReady || secondaryCards.length === 0}
            >
              <span>{t('usage.needsHandling')}</span>
              <strong>{usageOverviewReady ? secondaryCards.length : '—'}</strong>
              <small>{usageOverviewReady ? (secondaryCards.length > 0 ? t('usage.configureOrOpenConsole') : t('usage.none')) : t('usage.loading')}</small>
            </button>
          </section>
        </div>
      </header>

      <div className="usage-tabs usage-tabs-with-actions">
        <div className="usage-tab-list">
          <button
            type="button"
            className={`usage-tab${usageMode === 'subscription' ? ' active' : ''}`}
            onClick={() => setUsageMode('subscription')}
          >
            {t('usage.tabSubscription')}
          </button>
          <button
            type="button"
            className={`usage-tab${usageMode === 'prepaid' ? ' active' : ''}`}
            onClick={() => setUsageMode('prepaid')}
          >
            {t('usage.tabPrepaid')}
          </button>
        </div>
        <div className="usage-tabs-actions">
          {usageOverviewReady && modeAlerts.length > 0 && (
            <div className="usage-summary-alert-center">
              <button
                type="button"
                className={`usage-summary-alert-toggle usage-summary-alert-toggle--${alertToneForMode}${alertCenterOpen ? ' is-open' : ''}`}
                onClick={() => setAlertCenterOpen(open => !open)}
                aria-expanded={alertCenterOpen}
                aria-controls="usage-page-alert-list"
              >
                <span className="usage-summary-alert-toggle-dot" aria-hidden="true" />
                <span>{modeAlerts.length} {t('home.usageAttention')}</span>
              </button>
              {alertCenterOpen && (
                <div id="usage-page-alert-list" className="usage-summary-alert-popover" role="region" aria-label={t('usage.attentionTitle')}>
                  <div className="usage-summary-alert-popover-title">{t('usage.attentionTitle')}</div>
                  {modeAlerts.map(alert => (
                    <div key={alert.notifyKey} className={`usage-summary-alert-item usage-summary-alert-item--${alert.severity}`}>
                      <span className="usage-summary-alert-item-dot" aria-hidden="true" />
                      <button type="button" className="usage-summary-alert-item-content" onClick={() => revealAlertCard(alert.providerId)}>
                        <strong>{alert.providerName}</strong>
                        <span title={alert.message}>{compactAlertMessage(alert.message, alert.providerName)}</span>
                      </button>
                      <button
                        type="button"
                        className="usage-summary-alert-item-close"
                        onClick={() => setDismissedAlertKeys(prev => new Set(prev).add(alert.notifyKey))}
                        aria-label={t('usage.dismissAlert')}
                        title={t('usage.dismissAlert')}
                      >×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <button className="usage-refresh-btn" onClick={handleManualRefresh} disabled={!usageOverviewReady || fetchingIds.size > 0}>
            {!usageOverviewReady || fetchingIds.size > 0 ? (
              <><span className="provider-status-spinner" aria-hidden="true" /> {usageOverviewReady ? t('usage.refreshing') : t('usage.loading')}</>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14.5 9a5.5 5.5 0 1 1-1.6-3.9" />
                  <path d="M14.5 3.5v4h-4" />
                </svg>
                {t('usage.refreshAll')}
              </>
            )}
          </button>
        </div>
      </div>

      {liveCards.length > 0 && (
        <section className="usage-section">
          <div className="usage-section-heading">
            <div>
              <span className="usage-section-kicker">{t('usage.liveData')}</span>
              <h2>{usageMode === 'subscription' ? t('usage.subscriptionOverview') : t('usage.balanceOverview')}</h2>
            </div>
            <span>{liveCards.length} {t('usage.items')}</span>
          </div>
          <div className="usage-grid">
        {liveCards.map(card => {
          const guide = credentialGuideForProvider(card.id);
          return (
            <UsageCard
              key={card.id}
              id={card.id}
              name={card.name}
              type={card.type}
              usage={card.usage}
              fetching={card.fetching}
              onRefresh={() => fetchOne(card.id)}
              onLogin={() => handleUsageLogin(card.id)}
              onOpenGuide={guide ? () => setCredentialGuide({ guide, providerId: card.id }) : undefined}
              t={t}
            />
          );
        })}
          </div>
        </section>
      )}

      {secondaryCards.length > 0 && (
        <section className="usage-section usage-section--secondary">
          <button type="button" className="usage-secondary-toggle" onClick={() => setShowSecondary(open => !open)} aria-expanded={showSecondary}>
            <span>
              <strong>{t('usage.otherProviders')}</strong>
              <small>{t('usage.otherProvidersHint')}</small>
            </span>
            <span className="usage-secondary-toggle-count">{secondaryCards.length}</span>
            <svg viewBox="0 0 20 20" aria-hidden="true" className={showSecondary ? 'is-open' : ''}><path d="m6 8 4 4 4-4" /></svg>
          </button>
          {showSecondary && (
            <div className="usage-grid usage-grid--secondary">
              {secondaryCards.map(card => {
                const guide = credentialGuideForProvider(card.id);
                return (
                  <UsageCard
                    key={card.id}
                    id={card.id}
                    name={card.name}
                    type={card.type}
                    usage={card.usage}
                    fetching={card.fetching}
                    onRefresh={() => fetchOne(card.id)}
                    onLogin={() => handleUsageLogin(card.id)}
                    onOpenGuide={guide ? () => setCredentialGuide({ guide, providerId: card.id }) : undefined}
                    t={t}
                  />
                );
              })}
            </div>
          )}
        </section>
      )}

      {!metaLoaded && (
        <div className="usage-grid" aria-busy="true">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="qs-skeleton-card qs-skeleton-card--usage">
              <div className="qs-skeleton-row">
                <div className="skeleton-shape--icon" />
                <div className="skeleton-line skeleton-line--short" />
              </div>
              <div className="skeleton-line skeleton-line--title" />
              <div className="skeleton-line" />
            </div>
          ))}
        </div>
      )}

      {metaLoaded && supportedIds.length === 0 && (
        <div className="empty-state"><p>{t('usage.noProviders')}</p></div>
      )}

      {credentialGuide?.guide === 'volcengine' && (
        <VolcengineUsageGuide
          providerId={credentialGuide.providerId}
          onSaveAndTest={saveAndTestCredentials}
          onClose={() => setCredentialGuide(null)}
          t={t}
        />
      )}
      {credentialGuide && credentialGuide.guide !== 'volcengine' && (
        <CloudBalanceUsageGuide
          provider={credentialGuide.guide}
          providerId={credentialGuide.providerId}
          onSaveAndTest={saveAndTestCredentials}
          onClose={() => setCredentialGuide(null)}
          t={t}
        />
      )}
    </div>
  );
}

function credentialGuideForProvider(id: string): CredentialGuide | null {
  if (id === 'volcengine' || id === 'volcengine-coding' || id === 'volcengine-agent') return 'volcengine';
  if (id === 'qwen') return 'aliyun-billing';
  if (id === 'qianfan') return 'baidu-billing';
  if (id === 'tencent') return 'tencent-billing';
  return null;
}

function isGuidedConfigurationMessage(message?: string): boolean {
  if (!message) return false;
  return /(AK\/SK|SecretId|SecretKey|_[A-Z0-9_]*(?:CREDENTIALS|ACCESS_KEY|SECRET_KEY|TEAM_ID)|密钥管理|管理凭证|查询权限|手动添加|手动录入|授予)/i.test(message);
}

function UsageCard({ id, name, type, usage, fetching, onRefresh, onLogin, onOpenGuide, t }: {
  id: string;
  name: string;
  type: string;
  usage?: UsageResult;
  fetching: boolean;
  onRefresh: () => void;
  onLogin: () => void;
  onOpenGuide?: () => void;
  t: (k: string, ...args: any[]) => string;
}) {
  const hasData = usage?.supported && (usage.windows?.length || 0) > 0;
  const hasError = usage?.error;
  const hasNotice = usage?.notice;
  const externalSource = usage?.source === 'console' || usage?.source === 'cli';
  const compactGuideError = !!onOpenGuide && isGuidedConfigurationMessage(usage?.error);
  const compactGuideNotice = !!onOpenGuide && isGuidedConfigurationMessage(usage?.notice);

  // Compute overall status for card border color.
  const maxSeverity = usage?.windows?.reduce((max, w) => Math.max(max, usageSeverity(w)), 0) || 0;
  const statusClass = !hasData ? '' : maxSeverity >= 2 ? ' usage-card--danger' : maxSeverity >= 1 ? ' usage-card--warn' : ' usage-card--ok';
  const icon = getProviderIcon(id);

  return (
    <article id={`usage-card-${id}`} className={`usage-card${statusClass}`}>
      <div className="usage-card-header">
        <div className="usage-card-identity">
          <span className={`usage-card-brand${icon ? '' : ' usage-card-brand--fallback'}`} aria-hidden="true">
            {icon ? <img src={icon} alt="" className={getProviderIconClass(id)} /> : name.slice(0, 1).toUpperCase()}
          </span>
          <div className="usage-card-title">
            <h3>{name}</h3>
            <div className="usage-card-meta">
              {type && <span className="usage-card-type">{type}</span>}
              {externalSource && <span className="usage-card-source">{t('usage.consoleView')}</span>}
            </div>
          </div>
        </div>
        <div className="usage-card-header-actions">
          {onOpenGuide && (
            <button className="usage-card-guide" type="button" onClick={onOpenGuide}>
              <span aria-hidden="true">?</span>{t('usage.configureGuide')}
            </button>
          )}
          <button className="btn-icon usage-card-refresh" onClick={onRefresh} disabled={fetching} title={t('usage.refresh')}>
            {fetching ? (
              <span className="provider-status-spinner" aria-hidden="true" />
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 1 1-2.6-6.4" />
                <path d="M21 3v6h-6" />
              </svg>
            )}
          </button>
        </div>
      </div>

      <div className="usage-card-body">
        {fetching && !usage && (
          <div className="usage-card-loading">{t('usage.loading')}</div>
        )}
        {hasError && !fetching && (
          <div className="usage-card-error">
            <span>{compactGuideError ? t('usage.configurationRequired') : usage!.error}</span>
            {!compactGuideError && usage!.action && (
              <a className="usage-card-action" href={usage!.action.url} target="_blank" rel="noopener noreferrer">
                {usage!.action.label}
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5.5 3.5h7v7" />
                  <path d="M12.5 3.5 7 9" />
                  <path d="M11 8.5v3a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V6a1 1 0 0 1 1 1h3" />
                </svg>
              </a>
            )}
          </div>
        )}
        {hasNotice && !fetching && (
          <div className="usage-card-notice">
            <span className="usage-card-notice-mark" aria-hidden="true">↗</span>
            <div className="usage-card-notice-content">
              <span>{compactGuideNotice ? t('usage.configurationRequired') : usage!.notice}</span>
              {!compactGuideNotice && usage!.action && (
                usage!.action.mode === 'extension' ? (
                  <button className="usage-card-action" type="button" onClick={onLogin}>
                    {usage!.action.label}
                    <span aria-hidden="true">→</span>
                  </button>
                ) : (
                  <a className="usage-card-action" href={usage!.action.url} target="_blank" rel="noopener noreferrer">
                    {usage!.action.label}
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5.5 3.5h7v7" />
                      <path d="M12.5 3.5 7 9" />
                      <path d="M11 8.5v3a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V6a1 1 0 0 1 1 1h3" />
                    </svg>
                  </a>
                )
              )}
            </div>
          </div>
        )}
        {hasData && !fetching && (
          <div className="usage-card-windows">
            {usage!.windows!.map((w, i) => (
              <UsageBar key={i} w={w} />
            ))}
          </div>
        )}
        {!hasData && !hasError && !hasNotice && !fetching && (
          <div className="usage-card-empty">{t('usage.empty')}</div>
        )}
      </div>
    </article>
  );
}

function VolcengineUsageGuide({ providerId, onSaveAndTest, onClose, t }: {
  providerId: string;
  onSaveAndTest: SaveUsageCredentials;
  onClose: () => void;
  t: (k: string, ...args: any[]) => string;
}) {
  const iamUrl = 'https://console.volcengine.com/iam/keymanage/';
  const docsUrl = 'https://www.volcengine.com/docs/6469/1166573?lang=zh';

  return (
    <div className="usage-guide-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="usage-guide-panel" role="dialog" aria-modal="true" aria-labelledby="volcengine-usage-guide-title" onMouseDown={event => event.stopPropagation()}>
        <header className="usage-guide-header">
          <div>
            <span className="usage-guide-eyebrow">{t('usage.volcGuide.eyebrow')}</span>
            <h2 id="volcengine-usage-guide-title">{t('usage.volcGuide.title')}</h2>
            <p>{t('usage.volcGuide.lede')}</p>
          </div>
          <button className="usage-guide-close" type="button" onClick={onClose} aria-label={t('common.close')}>×</button>
        </header>

        <div className="usage-guide-warning">
          <span className="usage-guide-warning-mark" aria-hidden="true">!</span>
          <span>{t('usage.volcGuide.warning')}</span>
        </div>

        <div className="usage-guide-steps">
          <GuideStep number="01" title={t('usage.volcGuide.step1Title')}>
            <p>{t('usage.volcGuide.step1Body')}</p>
            <a className="usage-guide-external" href={iamUrl} target="_blank" rel="noopener noreferrer">{t('usage.volcGuide.openIam')} ↗</a>
          </GuideStep>
          <GuideStep number="02" title={t('usage.volcGuide.step2Title')}>
            <p>{t('usage.volcGuide.step2Body')}</p>
            <div className="usage-guide-permissions">
              <div><code>{t('usage.volcGuide.accessMode')}</code><span>{t('usage.volcGuide.accessModeLabel')}</span></div>
            </div>
          </GuideStep>
          <GuideStep number="03" title={t('usage.volcGuide.step3Title')}>
            <p>{t('usage.volcGuide.step3Body')}</p>
            <div className="usage-guide-permissions">
              <div><code>BillingCenterReadOnlyAccess</code><span>{t('usage.volcGuide.balancePermission')}</span></div>
              <div><code>ArkReadOnlyAccess</code><span>{t('usage.volcGuide.planPermission')}</span></div>
            </div>
          </GuideStep>
          <GuideStep number="04" title={t('usage.volcGuide.step4Title')}>
            <p>{t('usage.volcGuide.step4Body')}</p>
          </GuideStep>
          <GuideStep number="05" title={t('usage.volcGuide.step5Title')}>
            <CredentialSetupForm
              providerId={providerId}
              combinedName="VOLCENGINE_BILLING_CREDENTIALS"
              group="火山引擎"
              accessKeyLabel="Access Key ID"
              secretKeyLabel="Secret Access Key"
              onSaveAndTest={onSaveAndTest}
              t={t}
            />
          </GuideStep>
        </div>

        <footer className="usage-guide-footer">
          <a className="usage-guide-doc-link" href={docsUrl} target="_blank" rel="noopener noreferrer">{t('usage.volcGuide.officialDocs')} ↗</a>
          <div className="usage-guide-footer-actions">
            <button className="usage-guide-secondary" type="button" onClick={onClose}>{t('common.close')}</button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function CloudBalanceUsageGuide({ provider, providerId, onSaveAndTest, onClose, t }: {
  provider: CloudBalanceGuide;
  providerId: string;
  onSaveAndTest: SaveUsageCredentials;
  onClose: () => void;
  t: (k: string, ...args: any[]) => string;
}) {
  const configs: Record<CloudBalanceGuide, {
    title: string;
    lede: string;
    userBody: string;
    accessMode: string;
    accessModeLabel: string;
    permissionBody: string;
    permission: string;
    permissionLabel: string;
    permissionUrl?: string;
    permissionUrlLabel?: string;
    consoleUrl: string;
    consoleLabel: string;
    docsUrl: string;
    docsLabel: string;
    combinedName: string;
    group: string;
    accessKeyLabel: string;
    secretKeyLabel: string;
    credentialBody: string;
  }> = {
    'aliyun-billing': {
      title: t('usage.aliyunGuide.title'),
      lede: t('usage.aliyunGuide.lede'),
      userBody: t('usage.aliyunGuide.userBody'),
      accessMode: t('usage.aliyunGuide.accessMode'),
      accessModeLabel: t('usage.cloudGuide.accessModeRequired'),
      permissionBody: t('usage.aliyunGuide.permissionBody'),
      permission: 'AliyunBSSReadOnlyAccess',
      permissionLabel: t('usage.aliyunGuide.permissionLabel'),
      consoleUrl: 'https://ram.console.aliyun.com/users',
      consoleLabel: t('usage.aliyunGuide.openConsole'),
      docsUrl: 'https://help.aliyun.com/zh/ram/developer-reference/aliyunbssreadonlyaccess',
      docsLabel: t('usage.aliyunGuide.officialDocs'),
      combinedName: 'ALIYUN_BILLING_CREDENTIALS',
      group: '阿里云百炼',
      accessKeyLabel: 'AccessKey ID',
      secretKeyLabel: 'AccessKey Secret',
      credentialBody: t('usage.aliyunGuide.credentialBody'),
    },
    'baidu-billing': {
      title: t('usage.baiduGuide.title'),
      lede: t('usage.baiduGuide.lede'),
      userBody: t('usage.baiduGuide.userBody'),
      accessMode: t('usage.baiduGuide.accessMode'),
      accessModeLabel: t('usage.cloudGuide.accessModeRequired'),
      permissionBody: t('usage.baiduGuide.permissionBody'),
      permission: t('usage.baiduGuide.permissionName'),
      permissionLabel: t('usage.baiduGuide.permissionLabel'),
      consoleUrl: 'https://console.bce.baidu.com/iam/',
      consoleLabel: t('usage.baiduGuide.openConsole'),
      docsUrl: 'https://cloud.baidu.com/doc/Finance/s/Zlbu72qyo',
      docsLabel: t('usage.baiduGuide.officialDocs'),
      combinedName: 'QIANFAN_BCE_CREDENTIALS',
      group: '百度千帆',
      accessKeyLabel: 'AccessKey ID',
      secretKeyLabel: 'Secret Access Key',
      credentialBody: t('usage.baiduGuide.credentialBody'),
    },
    'tencent-billing': {
      title: t('usage.tencentBillingGuide.title'),
      lede: t('usage.tencentBillingGuide.lede'),
      userBody: t('usage.tencentBillingGuide.userBody'),
      accessMode: t('usage.tencentBillingGuide.accessMode'),
      accessModeLabel: t('usage.cloudGuide.accessModeRequired'),
      permissionBody: t('usage.tencentBillingGuide.permissionBody'),
      permission: 'finance:DescribeAccountBalance',
      permissionLabel: t('usage.tencentBillingGuide.permissionLabel'),
      permissionUrl: 'https://console.cloud.tencent.com/cam/policy',
      permissionUrlLabel: t('usage.tencentBillingGuide.openPolicyConsole'),
      consoleUrl: 'https://console.cloud.tencent.com/cam/user',
      consoleLabel: t('usage.tencentBillingGuide.openConsole'),
      docsUrl: 'https://cloud.tencent.com/document/product/555/61542',
      docsLabel: t('usage.tencentBillingGuide.officialDocs'),
      combinedName: 'TENCENT_CLOUD_CREDENTIALS',
      group: '腾讯云',
      accessKeyLabel: 'SecretId',
      secretKeyLabel: 'SecretKey',
      credentialBody: t('usage.tencentBillingGuide.credentialBody'),
    },
  };
  const config = configs[provider];

  return (
    <div className="usage-guide-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="usage-guide-panel" role="dialog" aria-modal="true" aria-labelledby={`${provider}-usage-guide-title`} onMouseDown={event => event.stopPropagation()}>
        <header className="usage-guide-header">
          <div>
            <span className="usage-guide-eyebrow">{t('usage.cloudGuide.eyebrow')}</span>
            <h2 id={`${provider}-usage-guide-title`}>{config.title}</h2>
            <p>{config.lede}</p>
          </div>
          <button className="usage-guide-close" type="button" onClick={onClose} aria-label={t('common.close')}>×</button>
        </header>

        <div className="usage-guide-warning">
          <span className="usage-guide-warning-mark" aria-hidden="true">!</span>
          <span>{t('usage.cloudGuide.warning')}</span>
        </div>

        <div className="usage-guide-steps">
          <GuideStep number="01" title={t('usage.cloudGuide.step1Title')}>
            <p>{config.userBody}</p>
            <div className="usage-guide-permissions">
              <div><code>{config.accessMode}</code><span>{config.accessModeLabel}</span></div>
            </div>
            <a className="usage-guide-external" href={config.consoleUrl} target="_blank" rel="noopener noreferrer">{config.consoleLabel} ↗</a>
          </GuideStep>
          <GuideStep number="02" title={t('usage.cloudGuide.step2Title')}>
            <p>{config.permissionBody}</p>
            <div className="usage-guide-permissions">
              <div><code>{config.permission}</code><span>{config.permissionLabel}</span></div>
            </div>
            {config.permissionUrl && config.permissionUrlLabel && (
              <a className="usage-guide-external" href={config.permissionUrl} target="_blank" rel="noopener noreferrer">{config.permissionUrlLabel} ↗</a>
            )}
          </GuideStep>
          <GuideStep number="03" title={t('usage.cloudGuide.step3Title')}>
            <p>{config.credentialBody}</p>
          </GuideStep>
          <GuideStep number="04" title={t('usage.cloudGuide.step4Title')}>
            <CredentialSetupForm
              providerId={providerId}
              combinedName={config.combinedName}
              group={config.group}
              accessKeyLabel={config.accessKeyLabel}
              secretKeyLabel={config.secretKeyLabel}
              onSaveAndTest={onSaveAndTest}
              t={t}
            />
          </GuideStep>
        </div>

        <footer className="usage-guide-footer">
          <a className="usage-guide-doc-link" href={config.docsUrl} target="_blank" rel="noopener noreferrer">{config.docsLabel} ↗</a>
          <div className="usage-guide-footer-actions">
            <button className="usage-guide-secondary" type="button" onClick={onClose}>{t('common.close')}</button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function CredentialSetupForm({
  providerId,
  combinedName,
  group,
  accessKeyLabel,
  secretKeyLabel,
  onSaveAndTest,
  t,
}: {
  providerId: string;
  combinedName: string;
  group: string;
  accessKeyLabel: string;
  secretKeyLabel: string;
  onSaveAndTest: SaveUsageCredentials;
  t: (k: string, ...args: any[]) => string;
}) {
  const [accessKey, setAccessKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [showValues, setShowValues] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saving' | 'success' | 'warning' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const canSubmit = accessKey.trim().length > 0 && secretKey.trim().length > 0 && status !== 'saving';

  const resetFeedback = () => {
    if (status !== 'idle' && status !== 'saving') {
      setStatus('idle');
      setMessage('');
    }
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;

    setStatus('saving');
    setMessage(t('usage.credentials.saving'));
    try {
      const result = await onSaveAndTest({
        providerId,
        key: combinedName,
        value: JSON.stringify({ accessKey: accessKey.trim(), secretKey: secretKey.trim() }),
        group,
      });
      if (result.error) {
        setStatus('warning');
        setMessage(t('usage.credentials.savedButFailed', { message: result.error }));
      } else if (result.notice || !result.windows?.length) {
        setStatus('warning');
        setMessage(t('usage.credentials.savedButUnavailable', { message: result.notice || t('usage.empty') }));
      } else {
        setStatus('success');
        setMessage(t('usage.credentials.success'));
      }
    } catch (error: any) {
      setStatus('error');
      setMessage(t('usage.credentials.saveFailed', { message: error?.message || t('usage.credentials.testFailed') }));
    }
  }

  return (
    <form className="usage-guide-form" onSubmit={handleSubmit}>
      <div className="usage-guide-form-heading">
        <p>{t('usage.credentials.pasteHint')}</p>
        <button className="usage-guide-visibility" type="button" onClick={() => setShowValues(value => !value)}>
          {showValues ? t('usage.credentials.hide') : t('usage.credentials.show')}
        </button>
      </div>
      <div className="usage-guide-form-grid">
        <label className="usage-guide-field">
          <span>{accessKeyLabel}</span>
          <input
            autoFocus
            autoComplete="off"
            spellCheck={false}
            type={showValues ? 'text' : 'password'}
            value={accessKey}
            placeholder={t('usage.credentials.pasteAccessKey', { label: accessKeyLabel })}
            onChange={event => { setAccessKey(event.target.value); resetFeedback(); }}
          />
        </label>
        <label className="usage-guide-field">
          <span>{secretKeyLabel}</span>
          <input
            autoComplete="new-password"
            spellCheck={false}
            type={showValues ? 'text' : 'password'}
            value={secretKey}
            placeholder={t('usage.credentials.pasteSecretKey', { label: secretKeyLabel })}
            onChange={event => { setSecretKey(event.target.value); resetFeedback(); }}
          />
        </label>
      </div>
      <div className="usage-guide-form-actions">
        <span className="usage-guide-save-target">{t('usage.credentials.savedAs', { name: combinedName })}</span>
        <button className="usage-guide-primary" type="submit" disabled={!canSubmit}>
          {status === 'saving' ? t('usage.credentials.saving') : t('usage.credentials.saveAndTest')}
        </button>
      </div>
      {status !== 'idle' && (
        <div className={`usage-guide-result usage-guide-result--${status}`} role="status" aria-live="polite">
          <span aria-hidden="true">{status === 'success' ? '✓' : status === 'saving' ? '…' : '!'}</span>
          <span>{message}</span>
        </div>
      )}
    </form>
  );
}

function GuideStep({ number, title, children }: { number: string; title: string; children: ReactNode }) {
  return (
    <article className="usage-guide-step">
      <span className="usage-guide-step-number">{number}</span>
      <div className="usage-guide-step-content">
        <h3>{title}</h3>
        {children}
      </div>
    </article>
  );
}

function UsageBar({ w }: { w: UsageWindow }) {
  const pct = w.usedPercent;                                  // 已用百分比
  const remaining = pct != null ? round1(100 - pct) : null;   // 剩余百分比
  const severity = usageSeverity(w);
  const tone = severity >= 2 ? 'danger' : severity >= 1 ? 'warn' : 'ok';
  const resetText = w.resetAt ? formatResetTime(w.resetAt) : null;
  const label = windowLabel(w.label);

  if (w.isPrepaid) {
    // Goal ①: prepaid providers report absolute USD amounts. Most balance APIs
    // only expose the remaining balance (no separate "used" figure), so we
    // prefer remainingCredits and fall back to limit - used when available.
    const rem = w.remainingCredits != null
      ? w.remainingCredits
      : (w.limitCredits != null && w.usedCredits != null)
        ? w.limitCredits - w.usedCredits
        : null;
    const hasComparableLimit = w.usedCredits != null && w.limitCredits != null && w.limitCredits > 0;
    const remainingPct = rem != null && hasComparableLimit
      ? Math.min(100, Math.max(0, round1((rem / w.limitCredits!) * 100)))
      : null;
    const formatAmount = (value: number) => formatBalanceAmount(value, w.unit);
    const amountText = rem != null ? formatAmount(rem) : '—';
    const detailText = [
      w.usedCredits != null ? `${t_global('usage.usedAmount')} ${formatAmount(w.usedCredits)}` : null,
      hasComparableLimit ? `${t_global('usage.totalAmount')} ${formatAmount(w.limitCredits!)}` : null,
    ].filter(Boolean).join(' · ');

    if (!hasComparableLimit) {
      return (
        <div className={`usage-balance usage-balance--amount usage-bar--${tone}`}>
          <span className="usage-bar-label">{t_global('usage.availableBalance')}</span>
          <strong className="usage-balance-amount">{amountText}</strong>
          {severity >= 2 && <span className="usage-balance-status">{t_global('usage.lowBalance')}</span>}
        </div>
      );
    }

    return (
      <div className="usage-balance">
        <div className={`usage-bar usage-bar--${tone}`}>
          <span className="usage-bar-label">{label}</span>
          <div className="usage-bar-track">
            <div className="usage-bar-fill" style={{ width: remainingPct != null ? `${remainingPct}%` : '100%' }} />
          </div>
          <span className="usage-bar-pct">{remainingPct != null ? `${t_global('usage.remaining')} ${remainingPct}%` : '—'}</span>
          <span className="usage-bar-reset usage-bar-balance-amount">{amountText}</span>
        </div>
        {detailText && <div className="usage-balance-detail">{detailText}</div>}
      </div>
    );
  }

  return (
    <div className={`usage-bar usage-bar--${tone}`}>
      <span className="usage-bar-label">{label}</span>
      <div className="usage-bar-track">
        <div className="usage-bar-fill" style={{ width: remaining != null ? `${Math.min(remaining, 100)}%` : '100%' }} />
      </div>
      <span className="usage-bar-pct">{remaining != null ? `${t_global('usage.remaining')} ${remaining}%` : '?'}</span>
      {resetText && <span className="usage-bar-reset" title={w.resetAt || ''}>{resetText}</span>}
    </div>
  );
}

function getPrepaidRemainingPercent(w: UsageWindow): number | null {
  if (!w.isPrepaid) return null;
  const remaining = w.remainingCredits != null
    ? w.remainingCredits
    : w.limitCredits != null && w.usedCredits != null
      ? w.limitCredits - w.usedCredits
      : null;
  if (remaining == null) return null;
  if (w.limitCredits != null && w.limitCredits > 0) {
    return Math.min(100, Math.max(0, round1((remaining / w.limitCredits) * 100)));
  }
  return remaining <= 0 ? 0 : null;
}

function usageSeverity(w: UsageWindow): number {
  if (w.isPrepaid) {
    const amount = w.remainingCredits != null
      ? w.remainingCredits
      : w.limitCredits != null && w.usedCredits != null ? w.limitCredits - w.usedCredits : null;
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

// ── Helpers ──

function round1(n: number): number { return Math.round(n * 10) / 10; }

function formatBalanceAmount(value: number, unit?: string): string {
  if (!unit || unit.toUpperCase() === 'USD') return `$${value.toFixed(2)}`;
  return `${value.toFixed(2)} ${unit}`;
}

function formatLastUpdated(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

// Backend window labels are stable short codes; presentation is localized.
function windowLabel(label: string): string {
  const map: Record<string, string> = {
    '5h': t_global('usage.window5h'),
    'session': t_global('usage.window5h'),
    'weekly': t_global('usage.windowWeekly'),
    'monthly': t_global('usage.windowMonthly'),
    'limit': t_global('usage.windowLimit'),
    'credits': t_global('usage.windowBalance'),
  };
  return map[label] || label;
}

function compactAlertMessage(message: string, providerName: string): string {
  const prefix = `${providerName} `;
  const compact = message.startsWith(prefix) ? message.slice(prefix.length) : message;
  return compact
    .replace('将在 ', '')
    .replace('后重置，还有 ', '后重置 · ')
    .replace(' 未使用', ' 未用');
}

function formatResetTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = d.getTime() - now.getTime();
    if (diffMs <= 0) return '';
    const sameDay = d.toDateString() === now.toDateString();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const isTomorrow = d.toDateString() === tomorrow.toDateString();
    const hhmm = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    if (sameDay) return hhmm;
    if (isTomorrow) return t_global('usage.resetTomorrow', { time: hhmm });
    const date = d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
    return `${date} ${hhmm}`;
  } catch {
    return '';
  }
}

// Module-level i18n accessor (set by the page component on each render).
let _t: (k: string, ...args: any[]) => string = (k: string) => k;
function t_global(k: string, ...args: any[]): string { return _t(k, ...args); }
// Wire _t from the hook — called once at module eval in UsagePage via the
// `_t = t` assignment pattern below.
