import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  closeUsageLoginWindow,
  getSupportedUsageProviders,
  getUsage,
  listProviders,
  openUsageLogin,
  type Provider,
  type UsageResult,
} from '../../api/providers';
import { setVault } from '../../api/vault';
import { useApp } from '../Layout/AppContext';
import { useI18n } from '../../i18n';
import { useUsagePolling } from '../../lib/useUsagePolling';
import { useCoalescedUsageMap } from '../../lib/useCoalescedUsageMap';
import { checkAlerts, fireNotifications } from '../../lib/usageAlerts';
import { useDataChanged } from '../../hooks/useDataChanged';
import {
  PROVIDER_META,
  type CredentialGuideContext,
  type UsageKind,
} from './usageCatalog';
import {
  isConsoleOnlyUsage,
  refreshableUsageIds,
} from './usagePresentation';

export type SaveUsageCredentials = (input: {
  providerId: string;
  key: string;
  value: string;
  group: string;
}) => Promise<UsageResult>;

export function useUsagePageState() {
  const { showToast: toast } = useApp() as any;
  const { t, lang, providerName: translateProviderName } = useI18n();
  const [credentialGuide, setCredentialGuide] =
    useState<CredentialGuideContext | null>(null);
  const [supportedIds, setSupportedIds] = useState<string[]>([]);
  const [manualOnlyIds, setManualOnlyIds] = useState<Set<string>>(new Set());
  const [metaLoaded, setMetaLoaded] = useState(false);
  const [providers, setProviders] = useState<Provider[]>([]);
  const { usageMap, enqueue } = useCoalescedUsageMap();
  const [fetchingIds, setFetchingIds] = useState<Set<string>>(new Set());
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [showSecondary, setShowSecondary] = useState(false);
  const [usageMode, setUsageMode] = useState<UsageKind>('subscription');

  const loadMetadata = useCallback(async () => {
    try {
      const [sup, provData] = await Promise.all([
        getSupportedUsageProviders(),
        listProviders(),
      ]);
      setSupportedIds(sup.providers || []);
      setManualOnlyIds(new Set(sup.manualOnly || []));
      setProviders(provData.providers || []);
    } catch {
      // Keep the current data visible if a background refresh fails.
    } finally {
      setMetaLoaded(true);
    }
  }, []);

  useEffect(() => {
    void loadMetadata();
  }, [loadMetadata]);
  useDataChanged(['providers', 'secrets'], loadMetadata);

  const fetchOne = useCallback(
    async (id: string): Promise<UsageResult | undefined> => {
      setFetchingIds((prev) => new Set(prev).add(id));
      try {
        const result = await getUsage(id);
        enqueue(id, result);
        return result;
      } catch (error: any) {
        enqueue(id, { supported: true, error: error.message });
        return undefined;
      } finally {
        setFetchingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        setLastUpdatedAt(new Date());
      }
    },
    [],
  );

  const saveAndTestCredentials = useCallback<SaveUsageCredentials>(
    async ({ providerId, key, value, group }) => {
      await setVault({
        key,
        value,
        group,
        desc: t('usage.credentials.description'),
      });
      setFetchingIds((prev) => new Set(prev).add(providerId));
      try {
        const result = await getUsage(providerId);
        enqueue(providerId, result);
        return result;
      } catch (error: any) {
        const result: UsageResult = {
          supported: true,
          error: error?.message || t('usage.credentials.testFailed'),
        };
        enqueue(providerId, result);
        return result;
      } finally {
        setFetchingIds((prev) => {
          const next = new Set(prev);
          next.delete(providerId);
          return next;
        });
      }
    },
    [t],
  );

  const providerNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const provider of providers)
      names[provider.id] = translateProviderName(provider.id, provider.name);
    return names;
  }, [providers, translateProviderName]);

  const handlePollResult = useCallback(
    (id: string, result: UsageResult) => {
      enqueue(id, result);
      setLastUpdatedAt(new Date());
    },
    [enqueue],
  );

  useUsagePolling({
    supportedIds,
    onResult: handlePollResult,
    silent: true,
    skipIds: [
      ...manualOnlyIds,
      ...supportedIds.filter((id) => isConsoleOnlyUsage(usageMap[id])),
    ],
  });

  const retryOnExtensionReady = useCallback(() => {
    for (const id of supportedIds) {
      if (manualOnlyIds.has(id) || isConsoleOnlyUsage(usageMap[id])) continue;
      const usage = usageMap[id];
      if (
        usage === undefined ||
        (!usage.windows?.length && (usage.error || usage.notice))
      )
        void fetchOne(id);
    }
  }, [supportedIds, manualOnlyIds, usageMap, fetchOne]);
  useDataChanged(['extension'], retryOnExtensionReady);

  const handleManualRefresh = useCallback(() => {
    for (const id of refreshableUsageIds(supportedIds, usageMap))
      void fetchOne(id);
  }, [supportedIds, usageMap, fetchOne]);

  const alerts = useMemo(
    () => checkAlerts(usageMap, providerNames, lang),
    [usageMap, providerNames, lang],
  );
  const [dismissedAlertKeys, setDismissedAlertKeys] = useState<Set<string>>(
    new Set(),
  );
  const [alertCenterOpen, setAlertCenterOpen] = useState(false);
  const visibleAlerts = alerts.filter(
    (alert) => !dismissedAlertKeys.has(alert.notifyKey),
  );

  useEffect(() => {
    if (alerts.length > 0) fireNotifications(alerts, lang);
  }, [alerts, lang]);

  const providerName = (id: string): string => {
    const provider = providers.find((item) => item.id === id);
    return translateProviderName(
      id,
      provider?.name || PROVIDER_META[id]?.name || id,
    );
  };
  const providerType = (id: string): string => {
    const key = PROVIDER_META[id]?.typeKey;
    return key ? t(key) : '';
  };

  const [loginPhases, setLoginPhases] = useState<
    Record<string, 'opening' | 'waiting' | undefined>
  >({});
  const loginMountedRef = useRef(true);
  useEffect(
    () => () => {
      loginMountedRef.current = false;
    },
    [],
  );

  async function handleUsageLogin(providerId: string) {
    if (loginPhases[providerId]) return;
    setLoginPhases((prev) => ({ ...prev, [providerId]: 'opening' }));
    try {
      toast(t('usage.loginOpeningHint'));
      const result = await openUsageLogin(providerId);
      if (!result.success) {
        toast(result.error || t('usage.loginOpenFailed'), 'error');
        return;
      }
      setLoginPhases((prev) => ({ ...prev, [providerId]: 'waiting' }));
      for (let attempt = 0; attempt < 36; attempt++) {
        await new Promise((resolve) =>
          window.setTimeout(resolve, attempt === 0 ? 3000 : 5000),
        );
        if (!loginMountedRef.current) return;
        const usage = await fetchOne(providerId);
        if (usage?.windows?.length) {
          await closeUsageLoginWindow(providerId).catch(() => {});
          toast(t('usage.loginSessionReady'), 'success');
          return;
        }
      }
      if (loginMountedRef.current) toast(t('usage.loginWaitGiveUp'), 'info');
    } catch (error: any) {
      toast(error?.message || t('usage.loginOpenFailed'), 'error');
    } finally {
      if (loginMountedRef.current)
        setLoginPhases((prev) => ({ ...prev, [providerId]: undefined }));
    }
  }

  const manualOnlyPlaceholder = useCallback(
    (id: string): UsageResult | undefined => {
      if (!manualOnlyIds.has(id) || usageMap[id] !== undefined)
        return undefined;
      return {
        supported: true,
        windows: [],
        source: 'console',
        notice: t('usage.manualOnlyNotice'),
        action: {
          label: t('usage.manualOnlyAction'),
          url: 'https://opencode.ai/',
        },
      };
    },
    [manualOnlyIds, usageMap, t],
  );

  const allCards = supportedIds.map((id) => ({
    id,
    name: providerName(id),
    type: providerType(id),
    kind: usageMap[id]?.kind || PROVIDER_META[id]?.kind || 'subscription',
    usage: usageMap[id] ?? manualOnlyPlaceholder(id),
    fetching: fetchingIds.has(id),
  }));
  const modeCards = allCards.filter((card) => card.kind === usageMode);
  const modeIds = new Set(modeCards.map((card) => card.id));
  const modeAlerts = visibleAlerts.filter((alert) =>
    modeIds.has(alert.providerId),
  );
  const modeAlertRank = new Map(
    modeAlerts.map((alert) => [
      alert.providerId,
      alert.severity === 'danger' ? 0 : alert.severity === 'warn' ? 1 : 2,
    ]),
  );
  const visibleCards = [...modeCards].sort((a, b) => {
    const score = (card: typeof a) =>
      modeAlertRank.get(card.id) ??
      (card.usage?.windows?.length
        ? 3
        : card.fetching
          ? 4
          : card.usage?.error
            ? 5
            : card.usage?.notice
              ? 6
              : 7);
    return score(a) - score(b);
  });
  const liveCards = visibleCards.filter(
    (card) => card.fetching || (card.usage?.windows?.length || 0) > 0,
  );
  const secondaryCards = visibleCards.filter(
    (card) => !card.fetching && !(card.usage?.windows?.length || 0),
  );
  const usageOverviewReady =
    metaLoaded && modeCards.every((card) => card.usage !== undefined);
  const alertToneForMode: 'ok' | 'danger' | 'warn' | 'info' =
    modeAlerts.length === 0
      ? 'ok'
      : modeAlerts.some((alert) => alert.severity === 'danger')
        ? 'danger'
        : modeAlerts.some((alert) => alert.severity === 'warn')
          ? 'warn'
          : 'info';

  useEffect(() => {
    setShowSecondary(false);
    setAlertCenterOpen(false);
  }, [usageMode]);

  const revealAlertCard = (providerId: string) => {
    setShowSecondary(true);
    setAlertCenterOpen(false);
    window.requestAnimationFrame(() => {
      document
        .getElementById(`usage-card-${providerId}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };

  return {
    t,
    credentialGuide,
    setCredentialGuide,
    supportedIds,
    metaLoaded,
    lastUpdatedAt,
    usageOverviewReady,
    liveCards,
    visibleCards,
    secondaryCards,
    usageMode,
    setUsageMode,
    modeAlerts,
    alertToneForMode,
    alertCenterOpen,
    setAlertCenterOpen,
    setDismissedAlertKeys,
    fetchingIds,
    handleManualRefresh,
    fetchOne,
    loginPhases,
    handleUsageLogin,
    showSecondary,
    setShowSecondary,
    revealAlertCard,
    saveAndTestCredentials,
  };
}

export type UsagePageState = ReturnType<typeof useUsagePageState>;
