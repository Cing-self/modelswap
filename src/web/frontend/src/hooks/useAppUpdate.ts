import { useCallback, useEffect, useRef, useState } from 'react';
import { useDataChanged } from './useDataChanged';

/**
 * App-update state machine shared by the desktop titlebar indicator and the
 * settings diagnostics panel:
 *
 *   idle ──check()──▶ checking ──▶ upToDate | available(latest, dmgUrl…)
 *                                    │
 *                              startDownload()
 *                                    ▼
 *                     downloading(polled progress) ──▶ completed ──▶ auto-install + restart()
 *
 * The initial auto-check is silent (no error surfaced) so it can run on every
 * app open without nagging offline users. `restart()` only exists in the
 * Electron desktop build — it mounts the downloaded DMG, replaces
 * /Applications/MODELSWAP.app, and relaunches; in a browser it falls back to the
 * already-opened installer.
 *
 * Beyond the startup check, two silent paths keep a long-running app aware:
 * the server-side update watcher publishes the 'update-available' SSE section
 * when it observes a new release (received via useDataChanged), and regaining
 * window focus re-checks once the focus cooldown has elapsed.
 */

export type UpdateState = {
  status: 'idle' | 'checking' | 'upToDate' | 'available' | 'error';
  latest?: string;
  dmgUrl?: string;
  releaseUrl?: string;
  publishedAt?: string | null;
  releaseNotes?: ReleaseNotes | null;
  error?: string;
};

export type ReleaseNoteCategory = 'new' | 'improved' | 'fixed';
export type ReleaseNotes = {
  version: string;
  publishedAt: string;
  summary: { zh: string; en: string };
  highlights: Array<{ category: ReleaseNoteCategory; zh: string; en: string }>;
  releaseUrl?: string;
};

export type UpdateDownload = {
  id: string;
  status: 'queued' | 'downloading' | 'completed' | 'failed';
  received: number;
  total: number | null;
  error?: string | null;
  path?: string | null;
};

export function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

/** Focus re-check cooldown: a returning user re-checks at most every 5 min. */
export const FOCUS_RECHECK_COOLDOWN_MS = 5 * 60 * 1000;

/** Give the completed state a moment to paint before the desktop quits. */
export const AUTO_INSTALL_DELAY_MS = 600;

/**
 * Only the packaged desktop app may take over installation. A completed job
 * must include its downloaded DMG path, and each job is scheduled once even
 * when polling delivers the same completed payload more than once.
 */
export function shouldAutoInstallDownloadedUpdate(
  download: UpdateDownload | null,
  isDesktop: boolean,
  restarting: boolean,
  scheduledJobId: string | null,
): boolean {
  return Boolean(
    isDesktop
      && !restarting
      && download?.id
      && download.status === 'completed'
      && download.path
      && scheduledJobId !== download.id,
  );
}

/**
 * Pure focus-recheck policy: check when the window becomes visible again
 * only if the last SUCCESSFUL check is older than the cooldown (or never
 * happened). Extracted so the cooldown logic is testable without a DOM.
 */
export function shouldCheckOnFocus(
  lastSuccessfulCheckAt: number | null,
  now: number,
  cooldownMs: number = FOCUS_RECHECK_COOLDOWN_MS,
): boolean {
  return lastSuccessfulCheckAt === null || now - lastSuccessfulCheckAt > cooldownMs;
}

/**
 * Pure state transitions for check(), extracted so the silent/failure
 * semantics are testable without mounting the hook.
 */
export function beginUpdateCheck(prev: UpdateState, silent: boolean): UpdateState {
  // Re-entry: a check already in flight keeps its state.
  if (prev.status === 'checking') return prev;
  // A silent background check must not tear down a known-good state while
  // the request is running — the titlebar badge, release info, and download
  // entry stay until a definitive result replaces them. (Tearing it down
  // here would also make the failure path below see 'checking' instead of
  // 'available', silently regressing the badge to error.)
  if (silent && (prev.status === 'available' || prev.status === 'upToDate')) return prev;
  return { status: 'checking' };
}

export function failUpdateCheck(prev: UpdateState, silent: boolean, error: string): UpdateState {
  const next: UpdateState = { status: 'error', error };
  // A silent background check must not clobber a known-good state on a
  // transient network failure — only explicit checks surface the error.
  if (silent && (prev.status === 'available' || prev.status === 'upToDate')) return prev;
  return next;
}

export function useAppUpdate(options?: { autoCheck?: boolean }) {
  const autoCheck = options?.autoCheck !== false;
  // Desktop owns installation after a completed download. Browsers keep the
  // manual installer flow after the server opens the DMG.
  const isDesktop = typeof window !== 'undefined' && Boolean((window as any).modelswapDesktop?.installUpdate);
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle' });
  const [download, setDownload] = useState<UpdateDownload | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const lastSuccessfulCheckRef = useRef<number | null>(null);
  const dmgPathRef = useRef<string | null>(null);
  const scheduledAutoInstallJobRef = useRef<string | null>(null);

  const downloading = download?.status === 'queued' || download?.status === 'downloading';
  const downloadProgress = download?.total && download.total > 0
    ? Math.min(100, Math.floor((download.received / download.total) * 100))
    : null;

  const check = useCallback(async (silent = true): Promise<UpdateState> => {
    setUpdate(prev => beginUpdateCheck(prev, silent));
    try {
      const res = await fetch('/api/update-check');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const next: UpdateState = data.upToDate
        ? { status: 'upToDate' }
        : {
          status: 'available',
          latest: data.latestVersion,
          dmgUrl: data.assets?.dmg?.url,
          releaseUrl: data.releaseUrl,
          publishedAt: data.publishedAt,
          releaseNotes: data.releaseNotes || null,
        };
      setUpdate(next);
      if (next.status === 'upToDate' || next.status === 'available') {
        lastSuccessfulCheckRef.current = Date.now();
      }
      setLastCheckedAt(Date.now());
      return next;
    } catch (err: any) {
      setUpdate(prev => failUpdateCheck(prev, silent, err.message));
      // The awaited value stays diagnostically true; only the explicit path
      // consumes it (toast) and explicit failures are always surfaced.
      return { status: 'error', error: err.message };
    }
  }, []);

  const startDownload = useCallback(async () => {
    if (!update.dmgUrl || downloading) return;
    setDownload(null);
    try {
      const res = await fetch('/api/update-download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: update.dmgUrl, open: !isDesktop }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setDownload(data);
    } catch (err: any) {
      setDownload({ id: '', status: 'failed', received: 0, total: null, error: err.message });
    }
  }, [update.dmgUrl, downloading, isDesktop]);

  // Poll the streamed download job so slow networks show real byte progress.
  useEffect(() => {
    if (!download?.id || download.status === 'completed' || download.status === 'failed') return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/update-download/${encodeURIComponent(download.id)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (!cancelled) setDownload(data);
      } catch (err: any) {
        if (!cancelled) setDownload(current => current ? { ...current, status: 'failed', error: err.message } : current);
      }
    };
    void poll();
    const timer = window.setInterval(poll, 400);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [download?.id, download?.status]);

  // Remember the installer path once the job completes — the restart flow
  // needs it to hand the DMG to the desktop installer.
  useEffect(() => {
    if (download?.status === 'completed' && download.path) dmgPathRef.current = download.path;
  }, [download?.status, download?.path]);

  const restart = useCallback(async () => {
    const desktop = (window as any).modelswapDesktop;
    // Browser console: the server already opened the DMG on macOS, so there
    // is nothing to relaunch — the button only renders in the desktop app.
    if (!desktop?.installUpdate) return;
    setRestarting(true);
    try {
      await desktop.installUpdate(dmgPathRef.current || undefined);
    } finally {
      setRestarting(false);
    }
  }, []);

  // A desktop update is transactional: once its DMG is complete, hand it to
  // Electron automatically. The one-shot job guard prevents repeated polling
  // results from scheduling multiple detached installer scripts. Browsers
  // intentionally remain manual because their server has already opened the
  // downloaded installer for the user.
  useEffect(() => {
    if (!shouldAutoInstallDownloadedUpdate(download, isDesktop, restarting, scheduledAutoInstallJobRef.current)) return;
    scheduledAutoInstallJobRef.current = download!.id;
    const timer = window.setTimeout(() => { void restart(); }, AUTO_INSTALL_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [download, isDesktop, restarting, restart]);

  useEffect(() => {
    if (autoCheck) void check(true);
  }, [autoCheck, check]);

  // Server-side update watcher: it publishes 'update-available' over the SSE
  // event stream once per observed new release. Re-check silently — the
  // watcher already refreshed the server cache, so this costs no extra
  // GitHub request, and a failed silent check keeps any known-good state.
  useDataChanged(['update-available'], () => { void check(true); });

  // Focus re-check: a long-running app that slept through SSE heartbeats (or
  // dropped the stream) converges when the user returns to the window, gated
  // by the cooldown so tab-switching never hammers the endpoint.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && shouldCheckOnFocus(lastSuccessfulCheckRef.current, Date.now())) {
        void check(true);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [check]);

  return {
    update, download, downloading, downloadProgress, lastCheckedAt, isDesktop,
    check, startDownload, restart, restarting,
  };
}
