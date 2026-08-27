import type { AlertItem } from '../../lib/usageAlerts';
import type { UsageTranslate } from './usageCatalog';
import { compactAlertMessage } from './usagePresentation';

export function UsageAlertCenter({
  t,
  alerts,
  tone,
  open,
  onToggle,
  onDismiss,
  onReveal,
}: {
  t: UsageTranslate;
  alerts: AlertItem[];
  tone: 'ok' | 'danger' | 'warn' | 'info';
  open: boolean;
  onToggle: () => void;
  onDismiss: (notifyKey: string) => void;
  onReveal: (providerId: string) => void;
}) {
  if (alerts.length === 0) return null;

  return (
    <div className="usage-summary-alert-center">
      <button
        type="button"
        className={`usage-summary-alert-toggle usage-summary-alert-toggle--${tone}${open ? ' is-open' : ''}`}
        onClick={onToggle}
        aria-expanded={open}
        aria-controls="usage-page-alert-list"
      >
        <span className="usage-summary-alert-toggle-dot" aria-hidden="true" />
        <span>
          {alerts.length} {t('home.usageAttention')}
        </span>
      </button>
      {open && (
        <div
          id="usage-page-alert-list"
          className="usage-summary-alert-popover"
          role="region"
          aria-label={t('usage.attentionTitle')}
        >
          <div className="usage-summary-alert-popover-title">
            {t('usage.attentionTitle')}
          </div>
          {alerts.map((alert) => (
            <div
              key={alert.notifyKey}
              className={`usage-summary-alert-item usage-summary-alert-item--${alert.severity}`}
            >
              <span
                className="usage-summary-alert-item-dot"
                aria-hidden="true"
              />
              <button
                type="button"
                className="usage-summary-alert-item-content"
                onClick={() => onReveal(alert.providerId)}
              >
                <strong>{alert.providerName}</strong>
                <span title={alert.message}>
                  {compactAlertMessage(alert.message, alert.providerName)}
                </span>
              </button>
              <button
                type="button"
                className="usage-summary-alert-item-close"
                onClick={() => onDismiss(alert.notifyKey)}
                aria-label={t('usage.dismissAlert')}
                title={t('usage.dismissAlert')}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
