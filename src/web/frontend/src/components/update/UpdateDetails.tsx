import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, CheckCircle2, CircleAlert, ExternalLink, Loader2, RefreshCw, RotateCcw, X } from 'lucide-react';
import { formatFileSize, ReleaseNoteCategory, useAppUpdate } from '../../hooks/useAppUpdate';
import { useI18n } from '../../i18n';

type UpdateDetailsContextValue = ReturnType<typeof useAppUpdate> & {
  isOpen: boolean;
  open: (trigger?: HTMLElement | null) => void;
  close: () => void;
};

const UpdateDetailsContext = createContext<UpdateDetailsContextValue | null>(null);

export function useUpdateDetails() {
  const value = useContext(UpdateDetailsContext);
  if (!value) throw new Error('useUpdateDetails must be used within UpdateDetailsProvider');
  return value;
}

export function UpdateDetailsProvider({ children }: { children: React.ReactNode }) {
  const isDesktop = typeof window !== 'undefined' && Boolean((window as any).okitDesktop);
  const updateApi = useAppUpdate({ autoCheck: isDesktop });
  const [isOpen, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const open = useCallback((trigger?: HTMLElement | null) => {
    triggerRef.current = trigger || document.activeElement as HTMLElement | null;
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  const value = useMemo(() => ({ ...updateApi, isOpen, open, close }), [updateApi, isOpen, open, close]);

  return (
    <UpdateDetailsContext.Provider value={value}>
      {children}
      <UpdateDetailsSheet triggerRef={triggerRef} />
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

export function UpdateDetailsSheet({ triggerRef }: { triggerRef?: React.MutableRefObject<HTMLElement | null> }) {
  const { t, lang } = useI18n();
  const { isOpen, close, update, download, downloading, downloadProgress, startDownload, restart, restarting, check, lastCheckedAt, isDesktop } = useUpdateDetails();
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const notes = update.releaseNotes;
  const ready = download?.status === 'completed';
  const downloadFailed = download?.status === 'failed';
  const notesMissing = update.status === 'available' && !notes;
  const unavailable = update.status === 'error';

  useEffect(() => {
    if (!isOpen) return;
    const focusables = () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])') || []);
    const frame = requestAnimationFrame(() => closeButtonRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      triggerRef?.current?.focus();
    };
  }, [isOpen, close, triggerRef]);

  if (!isOpen) return null;
  const version = update.latest || notes?.version?.replace(/^v/, '') || '';
  const date = formatDate(notes?.publishedAt || update.publishedAt, lang);
  const title = ready ? t('update.detailsReady')
    : unavailable ? t('update.detailsOffline')
      : update.status === 'upToDate' ? t('update.detailsUpToDate')
        : notesMissing ? t('update.detailsNotesMissing')
          : t('update.detailsAvailable');
  const description = unavailable ? t('update.detailsNetworkHint')
    : ready ? t('update.detailsInstallHint')
      : notes?.summary[lang] || (notesMissing ? t('update.detailsNotesMissing') : '');
  const releaseUrl = update.releaseUrl || notes?.releaseUrl;
  const action = async () => {
    if (ready) { await restart(); return; }
    if (unavailable || update.status === 'upToDate') { await check(false); return; }
    await startDownload();
  };
  const actionLabel = ready ? (restarting ? t('update.restarting') : t('update.restartToInstall'))
    : unavailable ? t('update.detailsRetry')
      : update.status === 'upToDate' ? t('update.detailsCheckAgain')
        : downloading ? t('update.detailsDownloading')
          : downloadFailed ? t('update.detailsRedownload')
            : t('update.detailsDownload', { version });

  return (
    <div className="modal-overlay update-details-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <section ref={panelRef} className="modal-panel update-details-sheet" role="dialog" aria-modal="true" aria-labelledby="update-details-title" aria-describedby="update-details-description">
        <header className="update-details-header">
          <div className="update-details-heading">
            <span className={`update-details-status-icon${unavailable || downloadFailed ? ' is-error' : ''}`} aria-hidden="true">
              {ready ? <CheckCircle2 size={18} /> : unavailable || downloadFailed ? <CircleAlert size={18} /> : downloading ? <Loader2 size={18} className="spin" /> : <ArrowDownToLine size={18} />}
            </span>
            <div><h2 id="update-details-title">{title}</h2>{version && <p className="update-details-version">{t('update.detailsVersion', { version })}{date ? ` · ${date}` : ''}</p>}</div>
          </div>
          <button ref={closeButtonRef} type="button" className="settings-system-icon-button" onClick={close} aria-label={t('update.detailsClose')}><X size={17} /></button>
        </header>
        <div className="update-details-body">
          {description && <p id="update-details-description" className="update-details-summary">{description}</p>}
          {notes && ['new', 'improved', 'fixed'].map(category => {
            const items = notes.highlights.filter(item => item.category === category);
            return items.length ? <section className="update-details-group" key={category}><h3>{t(categoryKey[category as ReleaseNoteCategory])}</h3><ul>{items.map((item, index) => <li key={`${category}-${index}`}>{item[lang]}</li>)}</ul></section> : null;
          })}
          {unavailable && update.error && <p className="update-details-recovery" role="status">{t('update.detailsNetworkHint')}</p>}
          {downloadFailed && <p className="update-details-download-error" role="status">{t('update.detailsDownloadFailed')}</p>}
          {downloading && <div className="update-details-progress" role="progressbar" aria-label={t('update.detailsDownloading')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={downloadProgress ?? undefined}>
            <div className="update-details-progress-row"><span>{downloadProgress === null ? t('update.detailsDownloading') : `${downloadProgress}%`}</span><span>{downloadProgress === null ? formatFileSize(download?.received || 0) : `${formatFileSize(download?.received || 0)} / ${formatFileSize(download?.total || 0)}`}</span></div>
            <span className="update-details-progress-track"><span style={{ width: `${downloadProgress ?? 12}%` }} /></span>
          </div>}
          {update.status === 'upToDate' && <p className="update-details-last-check">{lastCheckedAt ? t('update.detailsCheckedJustNow') : t('update.detailsCurrent', { version: update.latest || '' })}</p>}
        </div>
        <footer className="update-details-actions" aria-live="polite">
          {releaseUrl && <a href={releaseUrl} target="_blank" rel="noopener noreferrer" className="update-details-release-link">{t('update.detailsRelease')} <ExternalLink size={14} aria-hidden="true" /></a>}
          <div className="update-details-action-buttons">
            {ready && <button type="button" className="update-details-later" onClick={close}>{t('update.detailsLater')}</button>}
            <button type="button" className="settings-system-download update-details-primary" onClick={() => { void action(); }} disabled={downloading || restarting || (update.status === 'available' && !update.dmgUrl)}>
              {ready ? <RotateCcw size={15} /> : unavailable || update.status === 'upToDate' ? <RefreshCw size={15} /> : downloading || restarting ? <Loader2 size={15} className="spin" /> : <ArrowDownToLine size={15} />}
              {actionLabel}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

export function UpdateDetailsEntry() {
  const { t } = useI18n();
  const { update, download, open } = useUpdateDetails();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const label = download?.status === 'completed' ? t('update.restartToInstall')
    : update.status === 'available' ? t('update.details')
      : update.status === 'checking' ? t('settings.updateCheck')
        : t('update.details');
  return <button ref={buttonRef} className="settings-system-download" type="button" onClick={() => open(buttonRef.current)} disabled={update.status === 'checking'}>{update.status === 'checking' ? <Loader2 size={14} className="spin" /> : <ArrowDownToLine size={14} />}{label}</button>;
}
