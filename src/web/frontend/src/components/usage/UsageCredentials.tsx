import { useState, type FormEvent, type ReactNode } from 'react';
import type { CloudBalanceGuide, UsageTranslate } from './usageCatalog';
import { cloudBalanceGuideConfig } from './usageCredentialGuides';
import type { SaveUsageCredentials } from './useUsagePageState';

export function VolcengineUsageGuide({
  providerId,
  onSaveAndTest,
  onClose,
  t,
}: {
  providerId: string;
  onSaveAndTest: SaveUsageCredentials;
  onClose: () => void;
  t: UsageTranslate;
}) {
  return (
    <div
      className="usage-guide-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="usage-guide-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="volcengine-usage-guide-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="usage-guide-header">
          <div>
            <span className="usage-guide-eyebrow">
              {t('usage.volcGuide.eyebrow')}
            </span>
            <h2 id="volcengine-usage-guide-title">
              {t('usage.volcGuide.title')}
            </h2>
            <p>{t('usage.volcGuide.lede')}</p>
          </div>
          <button
            className="usage-guide-close"
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            ×
          </button>
        </header>
        <div className="usage-guide-warning">
          <span className="usage-guide-warning-mark" aria-hidden="true">
            !
          </span>
          <span>{t('usage.volcGuide.warning')}</span>
        </div>
        <div className="usage-guide-steps">
          <GuideStep number="01" title={t('usage.volcGuide.step1Title')}>
            <p>{t('usage.volcGuide.step1Body')}</p>
            <a
              className="usage-guide-external"
              href="https://console.volcengine.com/iam/keymanage/"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('usage.volcGuide.openIam')} ↗
            </a>
          </GuideStep>
          <GuideStep number="02" title={t('usage.volcGuide.step2Title')}>
            <p>{t('usage.volcGuide.step2Body')}</p>
            <div className="usage-guide-permissions">
              <div>
                <code>{t('usage.volcGuide.accessMode')}</code>
                <span>{t('usage.volcGuide.accessModeLabel')}</span>
              </div>
            </div>
          </GuideStep>
          <GuideStep number="03" title={t('usage.volcGuide.step3Title')}>
            <p>{t('usage.volcGuide.step3Body')}</p>
            <div className="usage-guide-permissions">
              <div>
                <code>BillingCenterReadOnlyAccess</code>
                <span>{t('usage.volcGuide.balancePermission')}</span>
              </div>
              <div>
                <code>ArkReadOnlyAccess</code>
                <span>{t('usage.volcGuide.planPermission')}</span>
              </div>
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
          <a
            className="usage-guide-doc-link"
            href="https://www.volcengine.com/docs/6469/1166573?lang=zh"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('usage.volcGuide.officialDocs')} ↗
          </a>
          <div className="usage-guide-footer-actions">
            <button
              className="usage-guide-secondary"
              type="button"
              onClick={onClose}
            >
              {t('common.close')}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

export function CloudBalanceUsageGuide({
  provider,
  providerId,
  onSaveAndTest,
  onClose,
  t,
}: {
  provider: CloudBalanceGuide;
  providerId: string;
  onSaveAndTest: SaveUsageCredentials;
  onClose: () => void;
  t: UsageTranslate;
}) {
  const config = cloudBalanceGuideConfig(provider, t);
  return (
    <div
      className="usage-guide-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="usage-guide-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${provider}-usage-guide-title`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="usage-guide-header">
          <div>
            <span className="usage-guide-eyebrow">
              {t('usage.cloudGuide.eyebrow')}
            </span>
            <h2 id={`${provider}-usage-guide-title`}>{config.title}</h2>
            <p>{config.lede}</p>
          </div>
          <button
            className="usage-guide-close"
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            ×
          </button>
        </header>
        <div className="usage-guide-warning">
          <span className="usage-guide-warning-mark" aria-hidden="true">
            !
          </span>
          <span>{t('usage.cloudGuide.warning')}</span>
        </div>
        <div className="usage-guide-steps">
          <GuideStep number="01" title={t('usage.cloudGuide.step1Title')}>
            <p>{config.userBody}</p>
            <div className="usage-guide-permissions">
              <div>
                <code>{config.accessMode}</code>
                <span>{config.accessModeLabel}</span>
              </div>
            </div>
            <a
              className="usage-guide-external"
              href={config.consoleUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {config.consoleLabel} ↗
            </a>
          </GuideStep>
          <GuideStep number="02" title={t('usage.cloudGuide.step2Title')}>
            <p>{config.permissionBody}</p>
            <div className="usage-guide-permissions">
              <div>
                <code>{config.permission}</code>
                <span>{config.permissionLabel}</span>
              </div>
            </div>
            {config.permissionUrl && config.permissionUrlLabel && (
              <a
                className="usage-guide-external"
                href={config.permissionUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {config.permissionUrlLabel} ↗
              </a>
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
          <a
            className="usage-guide-doc-link"
            href={config.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {config.docsLabel} ↗
          </a>
          <div className="usage-guide-footer-actions">
            <button
              className="usage-guide-secondary"
              type="button"
              onClick={onClose}
            >
              {t('common.close')}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

export function CredentialSetupForm({
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
  t: UsageTranslate;
}) {
  const [accessKey, setAccessKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [showValues, setShowValues] = useState(false);
  const [status, setStatus] = useState<
    'idle' | 'saving' | 'success' | 'warning' | 'error'
  >('idle');
  const [message, setMessage] = useState('');
  const canSubmit =
    accessKey.trim().length > 0 &&
    secretKey.trim().length > 0 &&
    status !== 'saving';
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
        value: JSON.stringify({
          accessKey: accessKey.trim(),
          secretKey: secretKey.trim(),
        }),
        group,
      });
      if (result.error) {
        setStatus('warning');
        setMessage(
          t('usage.credentials.savedButFailed', { message: result.error }),
        );
      } else if (result.notice || !result.windows?.length) {
        setStatus('warning');
        setMessage(
          t('usage.credentials.savedButUnavailable', {
            message: result.notice || t('usage.empty'),
          }),
        );
      } else {
        setStatus('success');
        setMessage(t('usage.credentials.success'));
      }
    } catch (error: any) {
      setStatus('error');
      setMessage(
        t('usage.credentials.saveFailed', {
          message: error?.message || t('usage.credentials.testFailed'),
        }),
      );
    }
  }
  return (
    <form className="usage-guide-form" onSubmit={handleSubmit}>
      <div className="usage-guide-form-heading">
        <p>{t('usage.credentials.pasteHint')}</p>
        <button
          className="usage-guide-visibility"
          type="button"
          onClick={() => setShowValues((value) => !value)}
        >
          {showValues
            ? t('usage.credentials.hide')
            : t('usage.credentials.show')}
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
            placeholder={t('usage.credentials.pasteAccessKey', {
              label: accessKeyLabel,
            })}
            onChange={(event) => {
              setAccessKey(event.target.value);
              resetFeedback();
            }}
          />
        </label>
        <label className="usage-guide-field">
          <span>{secretKeyLabel}</span>
          <input
            autoComplete="new-password"
            spellCheck={false}
            type={showValues ? 'text' : 'password'}
            value={secretKey}
            placeholder={t('usage.credentials.pasteSecretKey', {
              label: secretKeyLabel,
            })}
            onChange={(event) => {
              setSecretKey(event.target.value);
              resetFeedback();
            }}
          />
        </label>
      </div>
      <div className="usage-guide-form-actions">
        <span className="usage-guide-save-target">
          {t('usage.credentials.savedAs', { name: combinedName })}
        </span>
        <button
          className="usage-guide-primary"
          type="submit"
          disabled={!canSubmit}
        >
          {status === 'saving'
            ? t('usage.credentials.saving')
            : t('usage.credentials.saveAndTest')}
        </button>
      </div>
      {status !== 'idle' && (
        <div
          className={`usage-guide-result usage-guide-result--${status}`}
          role="status"
          aria-live="polite"
        >
          <span aria-hidden="true">
            {status === 'success' ? '✓' : status === 'saving' ? '…' : '!'}
          </span>
          <span>{message}</span>
        </div>
      )}
    </form>
  );
}

function GuideStep({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: ReactNode;
}) {
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
