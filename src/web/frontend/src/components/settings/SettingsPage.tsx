import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Activity, ArrowDownToLine, CheckCircle2, Copy, FolderOpen, Globe2, Loader2, Package, Palette, RefreshCw } from 'lucide-react';
import { getSettings } from '../../api/settings';
import { useApp } from '../Layout/AppContext';
import { useI18n } from '../../i18n';
import LogsPage from '../logs/LogsPage';
import DeviceSyncSection from './DeviceSyncSection';
import SnapshotsSection from './SnapshotsSection';
import packageInfo from '../../../../../../package.json';
import { useTransientFeedback } from '../../hooks/useTransientFeedback';

/* 界面风格包：id 对应 <html data-style>，swatch 为 [暗色面板色, 强调色, 亮色面板色] */
const UI_STYLES = [
  { id: 'command', nameKey: 'settings.styleCommand', descKey: 'settings.styleCommandDesc', preview: { rail: '#101512', canvas: '#f4f1e8', surface: '#ffffff', accent: '#526f2c', line: '#d4d9cf' } },
  { id: 'kraft', nameKey: 'settings.styleKraft', descKey: 'settings.styleKraftDesc', preview: { rail: '#2a2118', canvas: '#f3ebdf', surface: '#fffaf2', accent: '#b0671a', line: '#d8c5a8' } },
  { id: 'ocean', nameKey: 'settings.styleOcean', descKey: 'settings.styleOceanDesc', preview: { rail: '#0d1524', canvas: '#edf1f8', surface: '#ffffff', accent: '#0369a1', line: '#c6d2e4' } },
  { id: 'mono', nameKey: 'settings.styleMono', descKey: 'settings.styleMonoDesc', preview: { rail: '#131313', canvas: '#f0f0ef', surface: '#ffffff', accent: '#1a1a19', line: '#d4d4d2' } },
  { id: 'ember', nameKey: 'settings.styleEmber', descKey: 'settings.styleEmberDesc', preview: { rail: '#241713', canvas: '#f5eee9', surface: '#fffdfb', accent: '#c2410c', line: '#dcc7ba' } },
];

export default function SettingsPage() {
  const { showToast, setConnectionStatus, theme, themeMode, setThemeMode, uiStyle, setUiStyle } = useApp() as any;
  const { t, lang, setLang } = useI18n();
  const [serviceReady, setServiceReady] = useState<boolean | null>(null);
  const { activeKey: copiedAction, showFeedback: showCopied } = useTransientFeedback();
  // Update check (Plan A): poll GitHub's latest Release on demand, then guide
  // the user to download the desktop installer. CLI installs upgrade via
  // `okit upgrade`; this UI targets the desktop app.
  const [update, setUpdate] = useState<{
    status: 'idle' | 'checking' | 'upToDate' | 'available' | 'error';
    latest?: string; dmgUrl?: string; releaseUrl?: string; error?: string;
  }>({ status: 'idle' });
  const [downloading, setDownloading] = useState(false);
  const [downloaded, setDownloaded] = useState(false);

  async function handleCheckUpdate() {
    setUpdate({ status: 'checking' });
    try {
      const res = await fetch('/api/update-check');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.upToDate) {
        setUpdate({ status: 'upToDate' });
      } else {
        setUpdate({
          status: 'available',
          latest: data.latestVersion,
          dmgUrl: data.assets?.dmg?.url,
          releaseUrl: data.releaseUrl,
        });
      }
    } catch (err: any) {
      setUpdate({ status: 'error', error: err.message });
    }
  }

  async function handleDownloadUpdate() {
    if (!update.dmgUrl || downloading) return;
    setDownloading(true);
    try {
      const res = await fetch('/api/update-download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: update.dmgUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setDownloaded(true);
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setDownloading(false);
    }
  }

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    try {
      const settingsData = await getSettings();
      setConnectionStatus('connected');
      setServiceReady(Boolean(settingsData));
    } catch { setConnectionStatus('error'); setServiceReady(false); }
  }

  async function copyDiagnostics() {
    // Server-side summary (real port, runtime, extension link, agent config
    // presence, recent failures) enriches the browser-side basics — support
    // requests then carry the actual failure context instead of guesses.
    let server: any = null;
    try {
      server = await fetch('/api/diagnostics').then(r => r.ok ? r.json() : null);
    } catch { /* fall back to browser-side basics only */ }

    const lines = [
      `OKIT ${packageInfo.version}`,
      `Service: ${serviceReady === null ? 'checking' : serviceReady ? 'connected' : 'unavailable'}`,
      `Address: ${window.location.origin}`,
    ];
    if (server) {
      lines.push(
        `Port: ${server.port ?? 'unknown'}`,
        `Runtime: Node ${server.nodeVersion} on ${server.platform}`,
        `Extension: ${server.extension?.connected ? `connected (v${server.extension.version ?? '?'}, ${server.extension.protocol ?? '?'})` : 'not connected'}`,
        `Agents present: ${(server.agents || [])
          .filter((a: any) => a.files.some((f: any) => f.exists))
          .map((a: any) => a.id)
          .join(', ') || 'none'}`,
      );
      for (const fail of server.recentFailures || []) {
        lines.push(`Recent failure: [${fail.timestamp}] ${fail.action} ${fail.name}${fail.output ? ` — ${fail.output}` : ''}`);
      }
    }
    lines.push(
      `Data: ~/.okit`,
      `Language: ${lang}`,
      `Platform: ${navigator.platform}`,
    );
    const summary = lines.join('\n');
    try {
      await navigator.clipboard.writeText(summary);
      showCopied('diagnostics');
    } catch {
      showToast(t('settings.diagnosticsCopyFail'), 'error');
    }
  }

  const [searchParams] = useSearchParams();
  const rawSection = searchParams.get('section') || 'appearance';
  const section = ['appearance', 'sync', 'snapshots', 'diagnostics'].includes(rawSection) ? rawSection : 'appearance';

  return (
    <div className={`access-workspace settings-workspace settings-workspace--${theme}`}>
      {/* Appearance */}
      {section === 'appearance' && (
      <div className="settings-section settings-section--top" id="appearance">
        <header className="settings-page-header">
          <span className="settings-page-eyebrow"><Palette size={14} />{t('settings.preferences')}</span>
          <h2>{t('settings.appearance')}</h2>
          <p>{t('settings.appearanceDesc')}</p>
        </header>

        <div className="settings-block">
          <div className="settings-block-title">{t('settings.language')}</div>
          <div className="settings-card">
            <div className="settings-card-body">
              <div className="settings-mode-grid settings-mode-grid--lang" role="group" aria-label={t('settings.language')}>
                <button
                  type="button"
                  className={`settings-mode-option settings-mode-option--text${lang === 'zh' ? ' active' : ''}`}
                  onClick={() => setLang('zh')}
                  aria-pressed={lang === 'zh'}
                >
                  <span className="settings-mode-name">中文</span>
                </button>
                <button
                  type="button"
                  className={`settings-mode-option settings-mode-option--text${lang === 'en' ? ' active' : ''}`}
                  onClick={() => setLang('en')}
                  aria-pressed={lang === 'en'}
                >
                  <span className="settings-mode-name">English</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="settings-block">
          <div className="settings-block-title">{t('settings.themeMode')}</div>
          <div className="settings-card">
            <div className="settings-card-body">
              <div className="settings-mode-grid" role="group" aria-label={t('settings.themeMode')}>
                <button
                  type="button"
                  className={`settings-mode-option${themeMode === 'system' ? ' active' : ''}`}
                  onClick={() => setThemeMode('system')}
                  aria-pressed={themeMode === 'system'}
                >
                  <span className="settings-mode-preview settings-mode-preview--system">
                    <span className="settings-mode-canvas"><span className="settings-mode-dot" /></span>
                    <span className="settings-mode-panel" />
                  </span>
                  <span className="settings-mode-name">{t('settings.themeSystem')}</span>
                </button>
                <button
                  type="button"
                  className={`settings-mode-option${themeMode === 'dark' ? ' active' : ''}`}
                  onClick={() => setThemeMode('dark')}
                  aria-pressed={themeMode === 'dark'}
                >
                  <span className="settings-mode-preview settings-mode-preview--dark">
                    <span className="settings-mode-canvas">
                      <span className="settings-mode-dot" />
                    </span>
                    <span className="settings-mode-panel" />
                  </span>
                  <span className="settings-mode-name">{t('settings.themeDark')}</span>
                </button>
                <button
                  type="button"
                  className={`settings-mode-option${themeMode === 'light' ? ' active' : ''}`}
                  onClick={() => setThemeMode('light')}
                  aria-pressed={themeMode === 'light'}
                >
                  <span className="settings-mode-preview settings-mode-preview--light">
                    <span className="settings-mode-canvas">
                      <span className="settings-mode-dot" />
                    </span>
                    <span className="settings-mode-panel" />
                  </span>
                  <span className="settings-mode-name">{t('settings.themeLight')}</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="settings-block">
          <div className="settings-block-heading">
            <div className="settings-block-title">{t('settings.uiStyle')}</div>
            <p>{t('settings.uiStyleDesc')}</p>
          </div>
          <div className="settings-card">
            <div className="settings-card-body">
              <div className="settings-style-grid" role="group" aria-label={t('settings.uiStyle')}>
                {UI_STYLES.map(s => (
                  <button
                    key={s.id}
                    type="button"
                    className={`settings-style-option${uiStyle === s.id ? ' active' : ''}`}
                    onClick={() => setUiStyle(s.id)}
                    aria-pressed={uiStyle === s.id}
                  >
                    <span
                      className="settings-style-preview"
                      data-preview-style={s.id}
                      style={{
                        '--preview-rail': s.preview.rail,
                        '--preview-canvas': s.preview.canvas,
                        '--preview-surface': s.preview.surface,
                        '--preview-accent': s.preview.accent,
                        '--preview-line': s.preview.line,
                      } as React.CSSProperties}
                    >
                      <span className="settings-style-mini-rail">
                        <i className="settings-style-mini-brand" />
                        <i /><i /><i />
                      </span>
                      <span className="settings-style-mini-main">
                        <span className="settings-style-mini-top"><i /><b /></span>
                        <span className="settings-style-mini-hero"><i /><i /></span>
                        <span className="settings-style-mini-cards"><i /><i /></span>
                      </span>
                    </span>
                    <span className="settings-style-copy">
                      <strong>{t(s.nameKey)}</strong>
                      <small>{t(s.descKey)}</small>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      )}

      {/* Device Sync — merged section (password, devices, LAN pairing, cloud backup, manual ops) */}
      {section === 'sync' && (
      <div id="sync" className="settings-section-wrap">
        <DeviceSyncSection />
      </div>
      )}

      {/* Config Snapshots */}
      {section === 'snapshots' && (
      <div className="settings-section" id="snapshots">
        <SnapshotsSection />
      </div>
      )}

      {/* Support diagnostics */}
      {section === 'diagnostics' && (
      <div className="settings-section settings-diagnostics" id="diagnostics">
        <header className="settings-diagnostics-header">
          <div>
            <span className="settings-diagnostics-eyebrow"><Activity size={14} />{t('settings.diagnostics')}</span>
            <h2>{t('settings.diagnosticsTitle')}</h2>
            <p>{t('settings.diagnosticsDesc')}</p>
          </div>
        </header>

        <section className={`settings-system-overview${serviceReady === null ? ' is-checking' : serviceReady ? ' is-ready' : ' is-error'}`} aria-label={t('settings.runtimeOverview')}>
          <div className="settings-system-primary">
            <span className="settings-system-logo" aria-hidden="true">
              <img src="/okit-icon-180.png" alt="" />
              <i />
            </span>
            <div>
              <span className="settings-system-kicker">{t('settings.runtimeOverview')}</span>
              <h3>{serviceReady === null ? t('settings.serviceCheckingTitle') : serviceReady ? t('settings.serviceHealthyTitle') : t('settings.serviceUnavailableTitle')}</h3>
              <p>{serviceReady === null ? t('settings.serviceCheckingDesc') : serviceReady ? t('settings.serviceHealthyDesc') : t('settings.serviceUnavailableDesc')}</p>
            </div>
          </div>

          <dl className="settings-system-facts">
            <div>
              <dt><Package size={15} />{t('common.version')}</dt>
              <dd>OKIT {packageInfo.version}</dd>
            </div>
            <div>
              <dt><Globe2 size={15} />{t('settings.serviceAddress')}</dt>
              <dd>{window.location.origin}</dd>
            </div>
            <div>
              <dt><FolderOpen size={15} />{t('settings.dataDirectory')}</dt>
              <dd>~/.okit</dd>
            </div>
          </dl>

          <div className="settings-update-row">
            {/* Desktop-only affordance: the app bundles the browser extension
                (asarUnpack) — reveal it in Finder so the user can load it in
                Chrome without needing the CLI. */}
            {(window as any).okitDesktop?.revealExtension && (
              <button
                className="settings-diagnostics-copy"
                type="button"
                onClick={() => {
                  (window as any).okitDesktop.revealExtension()
                    .then((dir: string) => showToast(t('settings.extensionRevealed', { dir }), 'success'))
                    .catch((err: any) => showToast(err.message, 'error'));
                }}
              >
                <FolderOpen size={14} />
                {t('settings.revealExtension')}
              </button>
            )}
            {update.status === 'available' ? (
              <>
                <span className="settings-update-info">
                  {t('settings.updateAvailable')}: {packageInfo.version} → <strong>{update.latest}</strong>
                </span>
                {update.dmgUrl && (
                  <button
                    className="settings-diagnostics-copy"
                    type="button"
                    onClick={handleDownloadUpdate}
                    disabled={downloading}
                    title={t('settings.updateDmgHint')}
                  >
                    {downloading ? <Loader2 size={14} className="home-config-save-spin" /> : <ArrowDownToLine size={14} />}
                    {downloading ? t('settings.updateDownloading') : t('settings.updateDownload')}
                  </button>
                )}
                {update.releaseUrl && (
                  <a className="settings-update-link" href={update.releaseUrl} target="_blank" rel="noreferrer">
                    {t('settings.updateNotes')}
                  </a>
                )}
                {downloaded && <span className="settings-update-info ok">{t('settings.updateDownloaded')}</span>}
              </>
            ) : (
              <>
                <button
                  className="settings-diagnostics-copy"
                  type="button"
                  onClick={handleCheckUpdate}
                  disabled={update.status === 'checking'}
                  title={t('settings.updateDmgHint')}
                >
                  {update.status === 'checking' ? <Loader2 size={14} className="home-config-save-spin" /> : <RefreshCw size={14} />}
                  {t('settings.updateCheck')}
                </button>
                {update.status === 'upToDate' && (
                  <span className="settings-update-info ok">{t('settings.updateUpToDate')}（{packageInfo.version}）</span>
                )}
                {update.status === 'error' && <span className="settings-update-info err">{update.error}</span>}
              </>
            )}
          </div>

          <footer className="settings-system-actions">
            <span><CheckCircle2 size={14} />{t('settings.diagnosticsPrivacy')}</span>
            <button
              className={`settings-diagnostics-copy${copiedAction === 'diagnostics' ? ' is-copied' : ''}`}
              type="button"
              onClick={copyDiagnostics}
              aria-label={copiedAction === 'diagnostics' ? t('common.copied') : t('settings.copyDiagnostics')}
            >
              {copiedAction === 'diagnostics'
                ? <><CheckCircle2 size={15} />{t('common.copied')}</>
                : <><Copy size={15} />{t('settings.copyDiagnostics')}</>}
            </button>
          </footer>
        </section>

        <div className="settings-diagnostics-log-head">
          <div><h3>{t('settings.logsTitle')}</h3><p>{t('settings.logsDesc')}</p></div>
        </div>
        <LogsPage embedded />
      </div>
      )}
    </div>
  );
}
