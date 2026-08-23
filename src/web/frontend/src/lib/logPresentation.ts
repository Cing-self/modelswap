import type { LogEntry } from '../api/logs';

type Translate = (key: string, params?: Record<string, string | number>) => string;

export type LogCategory = 'sync' | 'vault' | 'settings' | 'system';

export interface LogPresentation {
  title: string;
  target: string;
  summary: string;
  category: LogCategory;
  rawDetail: string;
  technicalId: string;
}

const ACTION_KEYS: Record<string, string> = {
  'auto-sync-push': 'logs.event.autoSyncPush',
  'auto-sync-pull': 'logs.event.autoSyncPull',
  'sync-push': 'logs.event.syncPush',
  'sync-pull': 'logs.event.syncPull',
  'sync-code-import': 'logs.event.syncCodeImport',
  'peek-remote': 'logs.event.peekRemote',
  'pull-skip': 'logs.event.pullSkip',
  'platform-test': 'logs.event.platformTest',
  'settings-update': 'logs.event.settingsUpdate',
  'vault-set': 'logs.event.vaultSet',
  'vault-delete': 'logs.event.vaultDelete',
  'migrate-groups': 'logs.event.migrateGroups',
  'cf-sync': 'logs.event.cloudflareSync',
  'lan-enable': 'logs.event.lanEnable',
  'lan-disable': 'logs.event.lanDisable',
  'lan-regenerate': 'logs.event.lanRegenerate',
  'lan-pairing-create': 'logs.event.lanPairingCreate',
  'lan-pair': 'logs.event.lanPair',
  'lan-pair-exchange': 'logs.event.lanPairExchange',
  'lan-blob-receive': 'logs.event.lanBlobReceive',
  'lan-sync-start': 'logs.event.lanSyncStart',
  'onboarding-dismiss': 'logs.event.onboardingDismiss',
  'onboarding-reset': 'logs.event.onboardingReset',
  install: 'logs.actionInstall',
  upgrade: 'logs.actionUpgrade',
  uninstall: 'logs.actionUninstall',
  auth: 'logs.actionAuth',
  open: 'logs.actionOpen',
};

const TARGET_KEYS: Record<string, string> = {
  scheduler: 'logs.target.autoSync',
  lan: 'logs.target.lan',
  webdav: 'logs.target.webdav',
  icloud: 'logs.target.icloud',
  supabase: 'logs.target.supabase',
  volcengine: 'logs.target.volcengine',
  cloudflare: 'logs.target.cloudflare',
  'cloudflare-r2': 'logs.target.cloudflareR2',
  'cloudflare-kv': 'logs.target.cloudflareKV',
  'cloudflare-d1': 'logs.target.cloudflareD1',
  settings: 'logs.target.settings',
  onboarding: 'logs.target.onboarding',
};

const SYNC_ACTIONS = new Set([
  'auto-sync-push', 'auto-sync-pull', 'sync-push', 'sync-pull', 'sync-code-import',
  'peek-remote', 'pull-skip', 'platform-test', 'cf-sync', 'lan-enable', 'lan-disable',
  'lan-regenerate', 'lan-pairing-create', 'lan-pair', 'lan-pair-exchange',
  'lan-blob-receive', 'lan-sync-start',
]);

function categoryOf(action: string): LogCategory {
  if (SYNC_ACTIONS.has(action)) return 'sync';
  if (action.startsWith('vault-') || action === 'migrate-groups') return 'vault';
  if (action.startsWith('settings-') || action.startsWith('onboarding-')) return 'settings';
  return 'system';
}

function targetLabel(name: string, t: Translate) {
  const key = TARGET_KEYS[name];
  if (key) return t(key);
  if (name.startsWith('store:')) return t('logs.target.cloudflareStore');
  return name || t('logs.unknownTarget');
}

function secretCount(raw: string) {
  const match = raw.match(/(\d+)\s+secrets?/i);
  return match ? Number(match[1]) : null;
}

function byteCount(raw: string) {
  const match = raw.match(/(\d+)\s+bytes?/i);
  return match ? Number(match[1]) : null;
}

function portNumber(raw: string) {
  const match = raw.match(/(?:port\s+|:)(\d{2,5})\b/i);
  return match ? Number(match[1]) : null;
}

function syncPullCounts(raw: string) {
  const match = raw.match(/\+(\d+)\s+~(\d+)/);
  return match ? { added: Number(match[1]), updated: Number(match[2]) } : null;
}

function cloudflareCounts(raw: string) {
  const match = raw.match(/created:(\d+)\s+updated:(\d+)\s+deleted:(\d+)\s+failed:(\d+)/i);
  return match ? { created: Number(match[1]), updated: Number(match[2]), deleted: Number(match[3]), failed: Number(match[4]) } : null;
}

function describeSummary(log: LogEntry, target: string, title: string, raw: string, t: Translate) {
  const count = secretCount(raw);
  const failed = !log.success;

  if (failed) {
    if (log.action === 'peek-remote' || log.action === 'pull-skip') {
      return t('logs.summary.remoteUnavailable', { target });
    }
    if (log.action === 'platform-test') return t('logs.summary.connectionFailed', { target });
    return t('logs.summary.failed', { event: title, target });
  }

  if (log.action === 'auto-sync-push') {
    return count === null ? t('logs.summary.autoSyncComplete') : t('logs.summary.autoSyncSecrets', { n: count });
  }
  if (log.action === 'sync-push') {
    return count === null ? t('logs.summary.syncPushComplete', { target }) : t('logs.summary.syncPushSecrets', { n: count, target });
  }
  if (log.action === 'sync-code-import') {
    return count === null ? t('logs.summary.syncCodeImported', { target }) : t('logs.summary.syncCodeSecrets', { n: count, target });
  }
  if (log.action === 'auto-sync-pull') {
    const counts = syncPullCounts(raw);
    return counts ? t('logs.summary.syncPullCounts', counts) : t('logs.summary.autoPullComplete');
  }
  if (log.action === 'sync-pull') {
    const counts = syncPullCounts(raw);
    return counts ? t('logs.summary.syncPullFromCounts', { target, ...counts }) : t('logs.summary.syncPullComplete', { target });
  }
  if (log.action === 'platform-test') return t('logs.summary.connectionOk', { target });
  if (log.action === 'peek-remote') return t('logs.summary.remoteChecked', { target });
  if (log.action === 'pull-skip') return t('logs.summary.remoteSkipped', { target });

  if (log.action === 'lan-blob-receive') {
    const bytes = byteCount(raw);
    return bytes === null
      ? t('logs.summary.lanDataReceived')
      : t('logs.summary.lanDataReceivedSize', { size: bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB` });
  }
  if (log.action === 'lan-sync-start' || log.action === 'lan-enable') {
    const port = portNumber(raw);
    return port ? t('logs.summary.lanStartedPort', { port }) : t('logs.summary.lanStarted');
  }
  if (log.action === 'lan-disable') return t('logs.summary.lanStopped');
  if (log.action === 'lan-regenerate') return t('logs.summary.lanTokenChanged');
  if (log.action === 'lan-pairing-create') return t('logs.summary.pairingCreated');
  if (log.action === 'lan-pair' || log.action === 'lan-pair-exchange') return t('logs.summary.devicePaired');

  if (log.action === 'vault-set') return t('logs.summary.vaultSaved', { target });
  if (log.action === 'vault-delete') return t('logs.summary.vaultDeleted', { target });
  if (log.action === 'migrate-groups') return t('logs.summary.groupsMigrated');
  if (log.action === 'settings-update') return t('logs.summary.settingsUpdated');
  if (log.action === 'onboarding-dismiss') return t('logs.summary.onboardingDismissed');
  if (log.action === 'onboarding-reset') return t('logs.summary.onboardingReset');

  if (log.action === 'cf-sync') {
    const counts = cloudflareCounts(raw);
    return counts ? t('logs.summary.cloudflareCounts', counts) : t('logs.summary.cloudflareComplete');
  }

  return raw || t('logs.summary.complete', { event: title });
}

export function presentLog(log: LogEntry, t: Translate): LogPresentation {
  const rawDetail = log.output || log.message || log.command || '';
  const target = targetLabel(log.name, t);
  const actionKey = ACTION_KEYS[log.action];
  const title = actionKey ? t(actionKey) : (log.action || t('logs.unknownAction'));

  return {
    title,
    target,
    summary: describeSummary(log, target, title, rawDetail, t),
    category: categoryOf(log.action),
    rawDetail,
    technicalId: [log.name, log.action].filter(Boolean).join(' · '),
  };
}
