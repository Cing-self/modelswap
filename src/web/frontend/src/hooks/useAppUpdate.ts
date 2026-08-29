import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * App-update state machine shared by the desktop titlebar indicator and the
 * settings diagnostics panel:
 *
 *   idle ──check()──▶ checking ──▶ upToDate | available(latest, dmgUrl…)
 *                                    │
 *                              startDownload()
 *                                    ▼
 *                     downloading(polled progress) ──▶ completed ──▶ restart()
 *
 * The initial auto-check is silent (no error surfaced) so it can run on every
 * app open without nagging offline users. `restart()` only exists in the
 * Electron desktop build — it mounts the downloaded DMG, replaces
 * /Applications/OKIT.app, and relaunches; in a browser it falls back to the
 * already-opened installer.
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

export function useAppUpdate(options?: { autoCheck?: boolean }) {
  const autoCheck = options?.autoCheck !== false;
  // Desktop owns installation after an explicit restart action. Browsers keep
  // the manual installer flow after the server opens the DMG.
  const isDesktop = typeof window !== 'undefined' && Boolean((window as any).okitDesktop?.installUpdate);
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle' });
  const [download, setDownload] = useState<UpdateDownload | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const dmgPathRef = useRef<string | null>(null);

  const downloading = download?.status === 'queued' || download?.status === 'downloading';
  const downloadProgress = download?.total && download.total > 0
    ? Math.min(100, Math.floor((download.received / download.total) * 100))
    : null;

  const check = useCallback(async (silent = true): Promise<UpdateState> => {
    setUpdate(prev => (prev.status === 'checking' ? prev : { status: 'checking' }));
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
      setLastCheckedAt(Date.now());
      return next;
    } catch (err: any) {
      const next: UpdateState = { status: 'error', error: err.message };
      // A silent background check must not clobber a known-good state on a
      // transient network failure — only explicit checks surface the error.
      setUpdate(prev => (silent && prev.status === 'available' ? prev : next));
      return next;
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
    const desktop = (window as any).okitDesktop;
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

  useEffect(() => {
    if (autoCheck) void check(true);
  }, [autoCheck, check]);

  return {
    update, download, downloading, downloadProgress, lastCheckedAt, isDesktop,
    check, startDownload, restart, restarting,
  };
}
