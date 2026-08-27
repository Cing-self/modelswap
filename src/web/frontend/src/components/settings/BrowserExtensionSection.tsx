import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, FolderOpen, Loader2, Puzzle, RefreshCw } from 'lucide-react';
import { useApp } from '../Layout/AppContext';
import { useI18n } from '../../i18n';

type ExtensionDiagnostics = {
  extension: { connected: boolean; version: string | null; protocol: string | null };
};

/**
 * Settings → 浏览器插件: the extension is required for auto key creation and
 * cookie-based usage queries, but it used to live under "关于与诊断" where
 * nobody looked. This dedicated section shows live connection state and the
 * two-step setup (reveal folder → load unpacked in Chrome).
 */
export default function BrowserExtensionSection() {
  const { t } = useI18n();
  const { showToast } = useApp() as any;
  const [state, setState] = useState<'checking' | 'connected' | 'disconnected'>('checking');
  const [detail, setDetail] = useState<{ version: string | null; protocol: string | null }>({ version: null, protocol: null });

  const refresh = useCallback(async () => {
    setState('checking');
    try {
      const res = await fetch('/api/diagnostics');
      const data: ExtensionDiagnostics = await res.json();
      setState(data.extension?.connected ? 'connected' : 'disconnected');
      setDetail({ version: data.extension?.version ?? null, protocol: data.extension?.protocol ?? null });
    } catch {
      setState('disconnected');
    }
  }, []);

  // Re-check on mount and whenever anything in the app signals the extension
  // came online (the SSE 'extension' section) — the status card then flips to
  // "已连接" without a manual refresh.
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

      <div className="settings-block">
        <div className="settings-block-title">{t('settings.extensionStatusTitle')}</div>
        <div className="settings-card">
          <div className="settings-card-body settings-extension-status">
            <span className={`settings-extension-pill is-${state}`} role="status">
              {state === 'checking' ? <Loader2 size={15} className="home-config-save-spin" />
                : state === 'connected' ? <CheckCircle2 size={15} />
                : <CircleAlert size={15} />}
              <strong>{t(state === 'checking' ? 'common.checking' : state === 'connected' ? 'settings.extensionConnected' : 'settings.extensionDisconnected')}</strong>
            </span>
            {state === 'connected' && (
              <dl className="settings-extension-facts">
                {detail.version && <div><dt>{t('settings.extensionVersion')}</dt><dd>v{detail.version}</dd></div>}
                {detail.protocol && <div><dt>{t('settings.extensionProtocol')}</dt><dd>{detail.protocol}</dd></div>}
              </dl>
            )}
            <div className="settings-extension-actions">
              <button type="button" className="settings-system-icon-button" onClick={refresh} title={t('common.refresh')} aria-label={t('common.refresh')}>
                <RefreshCw size={15} />
              </button>
              <button type="button" className="settings-system-download" onClick={revealExtension}>
                <FolderOpen size={14} />
                {t('settings.revealExtension')}
              </button>
            </div>
          </div>
          {state === 'disconnected' && <p className="settings-extension-hint">{t('settings.extensionDisconnectedHint')}</p>}
        </div>
      </div>

      <div className="settings-block">
        <div className="settings-block-title">{t('settings.extensionLoadTitle')}</div>
        <div className="settings-card">
          <div className="settings-card-body">
            <ol className="settings-extension-steps">
              <li>{t('settings.extensionStep1')}</li>
              <li>{t('settings.extensionStep2')}</li>
              <li>{t('settings.extensionStep3')}</li>
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}
