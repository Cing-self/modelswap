export type SyncImportState =
  | { phase: 'idle' }
  | { phase: 'importing'; filename: string }
  | { phase: 'success'; platform: string; secrets: number }
  | { phase: 'error'; error: string };

type Translate = (key: string, params?: Record<string, string | number>) => string;

export function getSyncImportStatus(state: SyncImportState, t: Translate): { tone: 'loading' | 'success' | 'error'; message: string } | null {
  if (state.phase === 'idle') return null;
  if (state.phase === 'importing') {
    return {
      tone: 'loading',
      message: t('settings.syncFileImporting', { filename: state.filename }),
    };
  }
  if (state.phase === 'success') {
    return {
      tone: 'success',
      message: t('settings.syncFileImported', { platform: state.platform, n: state.secrets }),
    };
  }
  return {
    tone: 'error',
    message: state.error || t('settings.syncFileImportFail'),
  };
}
