import { createContext, useContext, useMemo } from 'react';
import { ArrowDownToLine, CheckCircle2, CircleAlert, Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import { formatFileSize, ReleaseNoteCategory, UpdateState, useAppUpdate } from '../../hooks/useAppUpdate';
import { useI18n } from '../../i18n';
import { useApp } from '../Layout/AppContext';

type UpdateDetailsContextValue = ReturnType<typeof useAppUpdate>;

const UpdateDetailsContext = createContext<UpdateDetailsContextValue | null>(null);

export function useUpdateDetails() {
  const value = useContext(UpdateDetailsContext);
  if (!value) throw new Error('useUpdateDetails must be used within UpdateDetailsProvider');
  return value;
}

export function UpdateDetailsProvider({ children }: { children: React.ReactNode }) {
  const isDesktop = typeof window !== 'undefined' && Boolean((window as any).modelswapDesktop);
  const updateApi = useAppUpdate({ autoCheck: isDesktop });
  const value = useMemo(() => updateApi, [updateApi]);

  return (
    <UpdateDetailsContext.Provider value={value}>
      {children}
    </UpdateDetailsContext.Provider>
  );
}

const categoryKey: Record<ReleaseNoteCategory, string> = {
  new: 'update.detailsNew',
  improved: 'update.detailsImproved',
  fixed: 'update.detailsFixed',
};

function formatDate(value: string | null | undefined, lang: 'zh' | 'en') {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
}

/**
 * A compact, non-modal release-note preview attached to the desktop titlebar
 * update icon. The icon owns the sole update action; this card is deliberately
 * read-only and disappears as soon as its icon/card hover region loses focus.
 */
export function UpdateHoverCard({ visible }: { visible: boolean }) {
  const { t, lang } = useI18n();
  const { update, download, downloading, downloadProgress, restarting } = useUpdateDetails();
  const notes = update.releaseNotes;
  const ready = download?.status === 'completed';
  const downloadFailed = download?.status === 'failed';
  const notesMissing = !notes;
  if (!visible || update.status !== 'available') return null;
  const version = update.latest || notes?.version?.replace(/^v/, '') || '';
  const date = formatDate(notes?.publishedAt || update.publishedAt, lang);
  const title = ready ? t('update.detailsReady')
    : notesMissing ? t('update.detailsNotesMissing')
      : t('update.detailsAvailable');
  const description = ready ? t('update.detailsInstallHint')
    : notes?.summary[lang] || (notesMissing ? t('update.detailsNotesMissing') : '');

  return (
    <section className="update-hover-card" role="dialog" aria-labelledby="update-hover-card-title" aria-describedby="update-hover-card-description">
      <header className="update-hover-card-header">
        <span className={`update-hover-card-status-icon${downloadFailed ? ' is-error' : ''}`} aria-hidden="true">
          {ready ? <CheckCircle2 size={17} /> : downloadFailed ? <CircleAlert size={17} /> : downloading || restarting ? <Loader2 size={17} className="spin" /> : <ArrowDownToLine size={17} />}
        </span>
        <div>
          <h2 id="update-hover-card-title">{title}</h2>
          {version && <p className="update-hover-card-version">{t('update.detailsVersion', { version })}{date ? ` · ${date}` : ''}</p>}
        </div>
      </header>
      <div className="update-hover-card-body">
        {description && <p id="update-hover-card-description" className="update-hover-card-summary">{description}</p>}
        {notes && ['new', 'improved', 'fixed'].map(category => {
          const items = notes.highlights.filter(item => item.category === category);
          return items.length ? <section className="update-hover-card-group" key={category}><h3>{t(categoryKey[category as ReleaseNoteCategory])}</h3><ul>{items.map((item, index) => <li key={`${category}-${index}`}>{item[lang]}</li>)}</ul></section> : null;
        })}
        {downloadFailed && <p className="update-hover-card-error" role="status">{t('update.detailsDownloadFailed')}</p>}
        {downloading && <div className="update-hover-card-progress" role="progressbar" aria-label={t('update.detailsDownloading')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={downloadProgress ?? undefined}>
          <div><span>{downloadProgress === null ? t('update.detailsDownloading') : `${downloadProgress}%`}</span><span>{downloadProgress === null ? formatFileSize(download?.received || 0) : `${formatFileSize(download?.received || 0)} / ${formatFileSize(download?.total || 0)}`}</span></div>
          <span><span style={{ width: `${downloadProgress ?? 12}%` }} /></span>
        </div>}
      </div>
    </section>
  );
}

/**
 * Feedback for the diagnostics-page explicit "check for updates" action.
 * Deterministic mapping from the awaited check result so the entry's
 * semantics are testable without mounting anything.
 */
export type SettingsUpdateCheckFeedback =
  | { kind: 'upToDate' }
  | { kind: 'found'; version: string }
  | { kind: 'error'; message: string };

/**
 * Run the diagnostics-page update check: an EXPLICIT check (never silent),
 * with the outcome surfaced as feedback. The diagnostics entry deliberately
 * has no path to the details sheet — when a new version is found, the
 * titlebar indicator becomes the single entry point for details, download,
 * and install. Structurally this orchestration never receives `open`.
 */
export async function performSettingsUpdateCheck(
  check: (silent?: boolean) => Promise<UpdateState>,
  notify: (feedback: SettingsUpdateCheckFeedback) => void,
): Promise<void> {
  const result = await check(false);
  if (result.status === 'upToDate') notify({ kind: 'upToDate' });
  else if (result.status === 'available') notify({ kind: 'found', version: String(result.latest ?? '') });
  else notify({ kind: 'error', message: String(result.error ?? '') });
}

/**
 * The diagnostics-page entry: an explicit "check for updates" action only.
 * Findings are reported via toast; the update itself (details, download,
 * install) stays with the titlebar indicator once it appears.
 */
export function UpdateCheckButton() {
  const { t } = useI18n();
  const { update, check } = useUpdateDetails();
  const { showToast } = useApp() as any;
  const checking = update.status === 'checking';
  const onClick = () => {
    void performSettingsUpdateCheck(check, feedback => {
      if (feedback.kind === 'upToDate') showToast(t('update.menuUpToDate'), 'success');
      else if (feedback.kind === 'found') showToast(t('update.menuFound', { version: feedback.version }), 'success');
      else showToast(t('update.checkFailed'), 'error');
    });
  };
  return (
    <button className="settings-system-download" type="button" onClick={onClick} disabled={checking}>
      {checking ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
      {t('settings.updateCheck')}
    </button>
  );
}
