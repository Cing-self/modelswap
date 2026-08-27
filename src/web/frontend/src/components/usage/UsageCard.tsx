import type { UsageResult, UsageWindow } from '../../api/providers';
import { getProviderIcon, getProviderIconClass } from '../../assets/providers';
import type { UsageTranslate } from './usageCatalog';
import {
  formatBalanceAmount,
  formatResetTime,
  round1,
  usageSeverity,
  windowLabel,
  isGuidedConfigurationMessage,
} from './usagePresentation';

export function UsageCard({
  id,
  name,
  type,
  usage,
  fetching,
  loginPhase,
  onRefresh,
  onLogin,
  onOpenGuide,
  t,
}: {
  id: string;
  name: string;
  type: string;
  usage?: UsageResult;
  fetching: boolean;
  loginPhase?: 'opening' | 'waiting';
  onRefresh: () => void;
  onLogin: () => void;
  onOpenGuide?: () => void;
  t: UsageTranslate;
}) {
  const hasData = usage?.supported && (usage.windows?.length || 0) > 0;
  const hasError = usage?.error;
  const hasNotice = usage?.notice;
  const externalSource = usage?.source === 'console' || usage?.source === 'cli';
  const compactGuideError =
    !!onOpenGuide && isGuidedConfigurationMessage(usage?.error);
  const compactGuideNotice =
    !!onOpenGuide && isGuidedConfigurationMessage(usage?.notice);
  const maxSeverity =
    usage?.windows?.reduce(
      (max, window) => Math.max(max, usageSeverity(window)),
      0,
    ) || 0;
  const statusClass = !hasData
    ? ''
    : maxSeverity >= 2
      ? ' usage-card--danger'
      : maxSeverity >= 1
        ? ' usage-card--warn'
        : ' usage-card--ok';
  const icon = getProviderIcon(id);

  return (
    <article id={`usage-card-${id}`} className={`usage-card${statusClass}`}>
      <div className="usage-card-header">
        <div className="usage-card-identity">
          <span
            className={`usage-card-brand${icon ? '' : ' usage-card-brand--fallback'}`}
            aria-hidden="true"
          >
            {icon ? (
              <img src={icon} alt="" className={getProviderIconClass(id)} />
            ) : (
              name.slice(0, 1).toUpperCase()
            )}
          </span>
          <div className="usage-card-title">
            <h3>{name}</h3>
            <div className="usage-card-meta">
              {type && <span className="usage-card-type">{type}</span>}
              {externalSource && (
                <span className="usage-card-source">
                  {t('usage.consoleView')}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="usage-card-header-actions">
          {onOpenGuide && (
            <button
              className="usage-card-guide"
              type="button"
              onClick={onOpenGuide}
            >
              <span aria-hidden="true">?</span>
              {t('usage.configureGuide')}
            </button>
          )}
          <button
            className="btn-icon usage-card-refresh"
            onClick={onRefresh}
            disabled={fetching}
            title={t('usage.refresh')}
          >
            {fetching ? (
              <span className="provider-status-spinner" aria-hidden="true" />
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
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
            <span>
              {compactGuideError
                ? t('usage.configurationRequired')
                : usage!.error}
            </span>
            {!compactGuideError && usage!.action && (
              <UsageAction action={usage!.action} />
            )}
          </div>
        )}
        {hasNotice && !fetching && (
          <div className="usage-card-notice">
            <span className="usage-card-notice-mark" aria-hidden="true">
              ↗
            </span>
            <div className="usage-card-notice-content">
              <span>
                {compactGuideNotice
                  ? t('usage.configurationRequired')
                  : usage!.notice}
              </span>
              {!compactGuideNotice &&
                usage!.action &&
                (usage!.action.mode === 'extension' ? (
                  <button
                    className="usage-card-action"
                    type="button"
                    onClick={onLogin}
                    disabled={!!loginPhase}
                  >
                    {loginPhase ? (
                      <>
                        <span
                          className="provider-status-spinner"
                          aria-hidden="true"
                        />{' '}
                        {t(
                          loginPhase === 'waiting'
                            ? 'usage.loginWaiting'
                            : 'usage.loginPending',
                        )}
                      </>
                    ) : (
                      <>
                        {usage!.action.label}
                        <span aria-hidden="true">→</span>
                      </>
                    )}
                  </button>
                ) : (
                  <UsageAction action={usage!.action} />
                ))}
            </div>
          </div>
        )}
        {hasData && !fetching && (
          <div className="usage-card-windows">
            {usage!.windows!.map((window, index) => (
              <UsageBar key={index} window={window} t={t} />
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

function UsageAction({
  action,
}: {
  action: NonNullable<UsageResult['action']>;
}) {
  return (
    <a
      className="usage-card-action"
      href={action.url}
      target="_blank"
      rel="noopener noreferrer"
    >
      {action.label}
      <svg
        width="13"
        height="13"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M5.5 3.5h7v7" />
        <path d="M12.5 3.5 7 9" />
        <path d="M11 8.5v3a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V6a1 1 0 0 1 1 1h3" />
      </svg>
    </a>
  );
}

function UsageBar({ window, t }: { window: UsageWindow; t: UsageTranslate }) {
  const pct = window.usedPercent;
  const remaining = pct != null ? round1(100 - pct) : null;
  const severity = usageSeverity(window);
  const tone = severity >= 2 ? 'danger' : severity >= 1 ? 'warn' : 'ok';
  const resetText = window.resetAt ? formatResetTime(window.resetAt, t) : null;
  const label = windowLabel(window.label, t);

  if (window.isPrepaid) {
    const remainingCredits =
      window.remainingCredits != null
        ? window.remainingCredits
        : window.limitCredits != null && window.usedCredits != null
          ? window.limitCredits - window.usedCredits
          : null;
    const hasComparableLimit =
      window.usedCredits != null &&
      window.limitCredits != null &&
      window.limitCredits > 0;
    const remainingPct =
      remainingCredits != null && hasComparableLimit
        ? Math.min(
            100,
            Math.max(
              0,
              round1((remainingCredits / window.limitCredits!) * 100),
            ),
          )
        : null;
    const formatAmount = (value: number) =>
      formatBalanceAmount(value, window.unit);
    const amountText =
      remainingCredits != null ? formatAmount(remainingCredits) : '—';
    const detailText = [
      window.usedCredits != null
        ? `${t('usage.usedAmount')} ${formatAmount(window.usedCredits)}`
        : null,
      hasComparableLimit
        ? `${t('usage.totalAmount')} ${formatAmount(window.limitCredits!)}`
        : null,
    ]
      .filter(Boolean)
      .join(' · ');
    if (!hasComparableLimit) {
      return (
        <div
          className={`usage-balance usage-balance--amount usage-bar--${tone}`}
        >
          <span className="usage-bar-label">{t('usage.availableBalance')}</span>
          <strong className="usage-balance-amount">{amountText}</strong>
          {severity >= 2 && (
            <span className="usage-balance-status">
              {t('usage.lowBalance')}
            </span>
          )}
        </div>
      );
    }
    return (
      <div className="usage-balance">
        <div className={`usage-bar usage-bar--${tone}`}>
          <span className="usage-bar-label">{label}</span>
          <div className="usage-bar-track">
            <div
              className="usage-bar-fill"
              style={{
                width: remainingPct != null ? `${remainingPct}%` : '100%',
              }}
            />
          </div>
          <span className="usage-bar-pct">
            {remainingPct != null
              ? `${t('usage.remaining')} ${remainingPct}%`
              : '—'}
          </span>
          <span className="usage-bar-reset usage-bar-balance-amount">
            {amountText}
          </span>
        </div>
        {detailText && <div className="usage-balance-detail">{detailText}</div>}
      </div>
    );
  }

  return (
    <div className={`usage-bar usage-bar--${tone}`}>
      <span className="usage-bar-label">{label}</span>
      <div className="usage-bar-track">
        <div
          className="usage-bar-fill"
          style={{
            width: remaining != null ? `${Math.min(remaining, 100)}%` : '100%',
          }}
        />
      </div>
      <span className="usage-bar-pct">
        {remaining != null ? `${t('usage.remaining')} ${remaining}%` : '?'}
      </span>
      {resetText && (
        <span className="usage-bar-reset" title={window.resetAt || ''}>
          {resetText}
        </span>
      )}
    </div>
  );
}
