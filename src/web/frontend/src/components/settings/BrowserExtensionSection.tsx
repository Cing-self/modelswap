import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, CircleAlert, FolderOpen, Loader2, Puzzle, RefreshCw } from 'lucide-react';
import { useApp } from '../Layout/AppContext';
import { useI18n } from '../../i18n';

type ExtensionDiagnostics = {
  extension: { connected: boolean; version: string | null; protocol: string | null };
};

export type ExtensionConnectionState = 'checking' | 'connected' | 'disconnected' | 'unavailable';

type ExtensionDetail = { version: string | null; protocol: string | null };

type ExtensionConnectionCardProps = {
  state: ExtensionConnectionState;
  detail: ExtensionDetail;
  installStepsExpanded: boolean;
  onRefresh: () => void;
  onReveal: () => void;
  onToggleInstallSteps: () => void;
  t: (key: string) => string;
};

export function shouldCollapseExtensionInstallSteps(state: ExtensionConnectionState) {
  return state === 'connected';
}

/** Presentation is separate from diagnostics calls for deterministic DOM coverage. */
export function ExtensionConnectionCard({
  state, detail, installStepsExpanded, onRefresh, onReveal, onToggleInstallSteps, t,
}: ExtensionConnectionCardProps) {
  const isConnected = state === 'connected';
  const isDisconnected = state === 'disconnected';
  const statusKey = state === 'checking'
    ? 'common.checking'
    : isConnected
      ? 'settings.extensionConnected'
      : isDisconnected
        ? 'settings.extensionDisconnected'
        : 'settings.extensionStatusUnavailable';

  return (
    <div className={`settings-card settings-extension-card is-${state}`} data-extension-state={state}>
      <div className="settings-card-body settings-extension-status">
        <div className="settings-extension-summary">
          <span className={`settings-extension-pill is-${state}`} role="status" aria-live="polite">
            {state === 'checking' ? <Loader2 size={15} className="home-config-save-spin" aria-hidden="true" />
              : isConnected ? <CheckCircle2 size={15} aria-hidden="true" />
                : <CircleAlert size={15} aria-hidden="true" />}
            <strong>{t(statusKey)}</strong>
          </span>
          {isConnected && (detail.version || detail.protocol) && (
            <dl className="settings-extension-facts">
              {detail.version && <div><dt>{t('settings.extensionVersion')}</dt><dd>v{detail.version}</dd></div>}
              {detail.protocol && <div><dt>{t('settings.extensionProtocol')}</dt><dd>{detail.protocol}</dd></div>}
            </dl>
          )}
          {isDisconnected && <p className="settings-extension-hint">{t('settings.extensionDisconnectedHint')}</p>}
          {state === 'unavailable' && <p className="settings-extension-hint">{t('settings.extensionStatusUnavailableHint')}</p>}
        </div>

        <div className="settings-extension-actions">
          <button
            type="button"
            className="settings-system-icon-button"
            onClick={onRefresh}
            disabled={state === 'checking'}
            title={t('settings.extensionRefreshStatus')}
            aria-label={t('settings.extensionRefreshStatus')}
          >
            <RefreshCw size={15} className={state === 'checking' ? 'home-config-save-spin' : undefined} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={isDisconnected ? 'settings-system-download' : 'settings-extension-reveal-button'}
            onClick={onReveal}
            title={t('settings.extensionRevealHint')}
          >
            <FolderOpen size={14} aria-hidden="true" />
            {t('settings.revealExtension')}
          </button>
        </div>
      </div>

      {isDisconnected && (
        <div className="settings-extension-install">
          <button
            type="button"
            className="settings-extension-install-toggle"
            onClick={onToggleInstallSteps}
            aria-expanded={installStepsExpanded}
            aria-controls="extension-install-steps"
          >
            <span>{t(installStepsExpanded ? 'settings.extensionHideSteps' : 'settings.extensionShowSteps')}</span>
            <ChevronDown size={15} aria-hidden="true" className={installStepsExpanded ? 'is-open' : undefined} />
          </button>
          {installStepsExpanded && (
            <ol className="settings-extension-steps" id="extension-install-steps">
              <li><span>{t('settings.extensionStep1Prefix')}</span>{' '}<code className="settings-extension-code">chrome://extensions</code></li>
              <li>{t('settings.extensionStep2')}</li>
              <li><span>{t('settings.extensionStep3Prefix')}</span>{' '}<code className="settings-extension-code">~/.okit/extension</code>{' '}<small>{t('settings.extensionStep3Note')}</small></li>
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

/** Settings → 浏览器插件: connection status and minimal installation guidance. */
export default function BrowserExtensionSection() {
  const { t } = useI18n();
  const { showToast } = useApp() as any;
  const [state, setState] = useState<ExtensionConnectionState>('checking');
  const [detail, setDetail] = useState<ExtensionDetail>({ version: null, protocol: null });
  const [installStepsExpanded, setInstallStepsExpanded] = useState(false);

  const refresh = useCallback(async () => {
    setState('checking');
    try {
      const res = await fetch('/api/diagnostics');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: ExtensionDiagnostics = await res.json();
      if (!data.extension || typeof data.extension.connected !== 'boolean') throw new Error('missing extension diagnostics');
      setState(data.extension.connected ? 'connected' : 'disconnected');
      setDetail({ version: data.extension.version ?? null, protocol: data.extension.protocol ?? null });
    } catch {
      setState('unavailable');
      setDetail({ version: null, protocol: null });
    }
  }, []);

  useEffect(() => {
    if (shouldCollapseExtensionInstallSteps(state)) setInstallStepsExpanded(false);
  }, [state]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const listener = (event: Event) => {
      const sections = (event as CustomEvent<{ sections?: string[] }>).detail?.sections;
      if (sections?.includes('extension')) void refresh();
    };
    window.addEventListener('okit:data-changed', listener);
    return () => window.removeEventListener('okit:data-changed', listener);
  }, [refresh]);

  async function revealExtension() {
    try {
      const desktop = (window as any).okitDesktop;
      if (desktop?.revealExtension) {
        await desktop.revealExtension();
      } else {
        const res = await fetch('/api/extension/reveal', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      }
    } catch (err: any) {
      showToast(err.message || t('settings.extensionRevealFail'), 'error');
    }
  }

  return (
    <section className="settings-extension">
      <header className="settings-page-header">
        <span className="settings-page-eyebrow"><Puzzle size={14} />{t('settings.extensionEyebrow')}</span>
        <h2>{t('settings.extensionTitle')}</h2>
        <p>{t('settings.extensionDesc')}</p>
      </header>
      <ExtensionConnectionCard
        state={state}
        detail={detail}
        installStepsExpanded={installStepsExpanded}
        onRefresh={() => { void refresh(); }}
        onReveal={() => { void revealExtension(); }}
        onToggleInstallSteps={() => setInstallStepsExpanded(expanded => !expanded)}
        t={t}
      />
    </section>
  );
}
