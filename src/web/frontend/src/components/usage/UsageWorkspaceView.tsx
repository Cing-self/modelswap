import { UsageCard } from './UsageCard';
import {
  CloudBalanceUsageGuide,
  VolcengineUsageGuide,
} from './UsageCredentials';
import { UsageAlertCenter } from './UsageAlertCenter';
import { credentialGuideForProvider } from './usageCatalog';
import { formatLastUpdated } from './usagePresentation';
import type { UsagePageState } from './useUsagePageState';

type UsageCardState = UsagePageState['liveCards'][number];

export function UsageWorkspaceView(props: UsagePageState) {
  const {
    t,
    credentialGuide,
    setCredentialGuide,
    supportedIds,
    metaLoaded,
    lastUpdatedAt,
    usageOverviewReady,
    liveCards,
    visibleCards,
    secondaryCards,
    usageMode,
    setUsageMode,
    modeAlerts,
    alertToneForMode,
    alertCenterOpen,
    setAlertCenterOpen,
    setDismissedAlertKeys,
    fetchingIds,
    handleManualRefresh,
    fetchOne,
    loginPhases,
    handleUsageLogin,
    showSecondary,
    setShowSecondary,
    revealAlertCard,
    saveAndTestCredentials,
  } = props;

  const renderCard = (card: UsageCardState) => {
    const guide = credentialGuideForProvider(card.id);
    return (
      <UsageCard
        key={card.id}
        id={card.id}
        name={card.name}
        type={card.type}
        usage={card.usage}
        fetching={card.fetching}
        onRefresh={() => {
          void fetchOne(card.id);
        }}
        onLogin={() => {
          void handleUsageLogin(card.id);
        }}
        loginPhase={loginPhases[card.id]}
        onOpenGuide={
          guide
            ? () => setCredentialGuide({ guide, providerId: card.id })
            : undefined
        }
        t={t}
      />
    );
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
            <strong>
              {lastUpdatedAt
                ? formatLastUpdated(lastUpdatedAt)
                : t('usage.waitingForData')}
            </strong>
          </div>
          <section className="usage-overview" aria-label={t('usage.overview')}>
            <div className="usage-overview-item usage-overview-item--primary">
              <span>{t('usage.readable')}</span>
              <strong>
                {usageOverviewReady
                  ? liveCards.filter((card) => !card.fetching).length
                  : '—'}
              </strong>
              <small>
                {usageOverviewReady
                  ? t('usage.ofProviders', { total: visibleCards.length })
                  : t('usage.loading')}
              </small>
            </div>
            <button
              type="button"
              className={`usage-overview-item usage-overview-item--alert usage-overview-item--${alertToneForMode}`}
              onClick={() =>
                modeAlerts.length > 0 && setAlertCenterOpen((open) => !open)
              }
              disabled={!usageOverviewReady || modeAlerts.length === 0}
            >
              <span>{t('usage.needsAttention')}</span>
              <strong>{usageOverviewReady ? modeAlerts.length : '—'}</strong>
              <small>
                {usageOverviewReady
                  ? modeAlerts.length > 0
                    ? t('usage.reviewNow')
                    : t('usage.allHealthy')
                  : t('usage.loading')}
              </small>
            </button>
            <button
              type="button"
              className="usage-overview-item usage-overview-item--secondary"
              onClick={() => setShowSecondary((open) => !open)}
              disabled={!usageOverviewReady || secondaryCards.length === 0}
            >
              <span>{t('usage.needsHandling')}</span>
              <strong>
                {usageOverviewReady ? secondaryCards.length : '—'}
              </strong>
              <small>
                {usageOverviewReady
                  ? secondaryCards.length > 0
                    ? t('usage.configureOrOpenConsole')
                    : t('usage.none')
                  : t('usage.loading')}
              </small>
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
            <UsageAlertCenter
              t={t}
              alerts={modeAlerts}
              tone={alertToneForMode}
              open={alertCenterOpen}
              onToggle={() => setAlertCenterOpen((open) => !open)}
              onDismiss={(notifyKey) =>
                setDismissedAlertKeys((prev) => new Set(prev).add(notifyKey))
              }
              onReveal={revealAlertCard}
            />
          )}
          <button
            className="usage-refresh-btn"
            onClick={handleManualRefresh}
            disabled={!usageOverviewReady || fetchingIds.size > 0}
          >
            {!usageOverviewReady || fetchingIds.size > 0 ? (
              <>
                <span className="provider-status-spinner" aria-hidden="true" />{' '}
                {usageOverviewReady
                  ? t('usage.refreshing')
                  : t('usage.loading')}
              </>
            ) : (
              <>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 18 18"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
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
              <span className="usage-section-kicker">
                {t('usage.liveData')}
              </span>
              <h2>
                {usageMode === 'subscription'
                  ? t('usage.subscriptionOverview')
                  : t('usage.balanceOverview')}
              </h2>
            </div>
            <span>
              {liveCards.length} {t('usage.items')}
            </span>
          </div>
          <div className="usage-grid">{liveCards.map(renderCard)}</div>
        </section>
      )}
      {secondaryCards.length > 0 && (
        <section className="usage-section usage-section--secondary">
          <button
            type="button"
            className="usage-secondary-toggle"
            onClick={() => setShowSecondary((open) => !open)}
            aria-expanded={showSecondary}
          >
            <span>
              <strong>{t('usage.otherProviders')}</strong>
              <small>{t('usage.otherProvidersHint')}</small>
            </span>
            <span className="usage-secondary-toggle-count">
              {secondaryCards.length}
            </span>
            <svg
              viewBox="0 0 20 20"
              aria-hidden="true"
              className={showSecondary ? 'is-open' : ''}
            >
              <path d="m6 8 4 4 4-4" />
            </svg>
          </button>
          {showSecondary && (
            <div className="usage-grid usage-grid--secondary">
              {secondaryCards.map(renderCard)}
            </div>
          )}
        </section>
      )}
      {!metaLoaded && (
        <div className="usage-grid" aria-busy="true">
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              key={index}
              className="qs-skeleton-card qs-skeleton-card--usage"
            >
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
        <div className="empty-state">
          <p>{t('usage.noProviders')}</p>
        </div>
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
