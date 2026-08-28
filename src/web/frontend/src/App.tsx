import { Routes, Route, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { useState, useEffect, useCallback, useLayoutEffect, lazy, Suspense } from 'react';
import { ArrowDownToLine, CircleAlert, Loader2, PanelLeftClose, PanelLeftOpen, RotateCcw } from 'lucide-react';
import { getOnboarding } from './api/settings';
import { primeOnboardingFromSession, getOnboardingDoneCache, setOnboardingDone } from './lib/onboardingGate';
import Sidebar from './components/Layout/Sidebar';
import ProviderImportModal from './components/shared/ProviderImportModal';
import { useI18n } from './i18n';
import { useAppUpdate } from './hooks/useAppUpdate';
import { useApp } from './components/Layout/AppContext';
import { invalidateProvidersCache, warmupMissingModels } from './api/providers';
import { startModelCacheWarmup } from './lib/modelCacheWarmup';

// Route-level code splitting: heavy pages are loaded on demand so the main
// entry chunk stays small. A lightweight, layout-stable placeholder is shown
// while a chunk loads to avoid visible layout shifts.
const HomePage = lazy(() => import('./components/home/HomePage'));
const ModelsPage = lazy(() => import('./components/models/ModelsPage'));
const ModelDataPage = lazy(() => import('./components/models/ModelDataPage'));
const UsagePage = lazy(() => import('./components/usage/UsagePage'));
const VaultPage = lazy(() => import('./components/vault/VaultPage'));
const SettingsPage = lazy(() => import('./components/settings/SettingsPage'));
const OnboardingPage = lazy(() => import('./components/onboarding/OnboardingPage'));
const AgentsPage = lazy(() => import('./components/agents/AgentsPage'));

function SkeletonProviderRows({ count = 4 }: { count?: number }) {
  return (
    <div className="route-skeleton-provider-list">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="route-skeleton-provider-row">
          <div className="skeleton-shape--icon" />
          <div className="skeleton-line skeleton-line--title" />
          <div className="route-skeleton-toggle" />
        </div>
      ))}
    </div>
  );
}

function UsageRouteSkeleton() {
  return (
    <div className="route-skeleton route-skeleton--usage" aria-busy="true" aria-label="正在加载用量统计">
      <header className="route-skeleton-header">
        <div>
          <div className="skeleton-line route-skeleton-eyebrow" />
          <div className="skeleton-line route-skeleton-vault-title" />
        </div>
        <div className="skeleton-shape--pill route-skeleton-action" />
      </header>
      <div className="route-skeleton-stat-grid">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="route-skeleton-panel route-skeleton-stat-card">
            <div className="skeleton-line skeleton-line--short" />
            <div className="skeleton-line route-skeleton-stat-value" />
            <div className="route-skeleton-progress" />
          </div>
        ))}
      </div>
      <section className="route-skeleton-panel route-skeleton-chart">
        <div className="route-skeleton-panel-head"><div className="skeleton-line skeleton-line--title" /><div className="skeleton-shape--pill route-skeleton-filter" /></div>
        <div className="route-skeleton-chart-bars">
          {Array.from({ length: 12 }).map((_, index) => <div key={index} className="route-skeleton-chart-bar" style={{ height: `${34 + ((index * 17) % 54)}%` }} />)}
        </div>
      </section>
    </div>
  );
}

function ModelsRouteSkeleton() {
  return (
    <div className="route-skeleton route-skeleton--models" aria-busy="true" aria-label="正在加载模型管控">
      <header className="route-skeleton-header">
        <div><div className="skeleton-line route-skeleton-eyebrow" /><div className="skeleton-line route-skeleton-vault-title" /></div>
        <div className="skeleton-shape--pill route-skeleton-action" />
      </header>
      <div className="route-skeleton-model-layout">
        <aside className="route-skeleton-model-nav">
          {Array.from({ length: 7 }).map((_, index) => <div key={index} className="skeleton-line" />)}
        </aside>
        <section className="route-skeleton-model-content">
          <div className="route-skeleton-filter-row"><div className="skeleton-shape--pill route-skeleton-filter" /><div className="skeleton-shape--pill route-skeleton-filter route-skeleton-filter--short" /></div>
          <SkeletonProviderRows />
        </section>
      </div>
    </div>
  );
}

function SettingsRouteSkeleton() {
  return (
    <div className="route-skeleton route-skeleton--settings" aria-busy="true" aria-label="正在加载设置">
      <div className="route-skeleton-settings-layout">
        <aside className="route-skeleton-settings-nav">
          <div className="skeleton-line route-skeleton-settings-brand" />
          {Array.from({ length: 4 }).map((_, index) => <div key={index} className="skeleton-line" />)}
        </aside>
        <section className="route-skeleton-settings-content">
          <div className="skeleton-line route-skeleton-eyebrow" />
          <div className="skeleton-line route-skeleton-vault-title" />
          <div className="skeleton-line route-skeleton-vault-subtitle" />
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="route-skeleton-settings-card">
              <div className="skeleton-line skeleton-line--title" />
              <div className="route-skeleton-filter-row">
                <div className="skeleton-shape--pill route-skeleton-filter" />
                <div className="skeleton-shape--pill route-skeleton-filter" />
                <div className="skeleton-shape--pill route-skeleton-filter route-skeleton-filter--short" />
              </div>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

function CompactRouteSkeleton({ label }: { label: string }) {
  return (
    <div className="route-skeleton route-skeleton--compact" aria-busy="true" aria-label={label}>
      <header className="route-skeleton-header">
        <div><div className="skeleton-line route-skeleton-eyebrow" /><div className="skeleton-line route-skeleton-vault-title" /></div>
      </header>
      <section className="route-skeleton-panel"><SkeletonProviderRows count={5} /></section>
    </div>
  );
}

function PageLoading() {
  const { pathname } = useLocation();

  if (pathname === '/') {
    return (
      <div className="route-skeleton route-skeleton--home" aria-busy="true" aria-label="正在加载快速启动">
        <section className="route-skeleton-panel route-skeleton-usage">
          <div className="route-skeleton-panel-head">
            <div className="skeleton-line skeleton-line--title" />
            <div className="skeleton-shape--pill route-skeleton-action" />
          </div>
          <div className="route-skeleton-filter-row">
            <div className="skeleton-shape--pill route-skeleton-filter" />
            <div className="skeleton-shape--pill route-skeleton-filter route-skeleton-filter--short" />
          </div>
          <div className="route-skeleton-usage-grid">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="route-skeleton-usage-item">
                <div className="skeleton-line skeleton-line--short" />
                <div className="skeleton-line skeleton-line--title" />
              </div>
            ))}
          </div>
        </section>
        <section className="route-skeleton-agent">
          <div className="route-skeleton-panel-head">
            <div className="skeleton-line skeleton-line--title" />
            <div className="route-skeleton-icon-actions">
              <div className="skeleton-shape--icon" />
              <div className="skeleton-shape--icon" />
            </div>
          </div>
          <div className="route-skeleton-agent-tabs">
            {Array.from({ length: 8 }).map((_, index) => <div key={index} className="skeleton-shape--icon" />)}
          </div>
          <SkeletonProviderRows count={3} />
        </section>
      </div>
    );
  }

  if (pathname === '/vault') {
    return (
      <div className="route-skeleton route-skeleton--vault" aria-busy="true" aria-label="正在加载密钥管理">
        <header className="route-skeleton-vault-head">
          <div>
            <div className="skeleton-line route-skeleton-eyebrow" />
            <div className="skeleton-line route-skeleton-vault-title" />
            <div className="skeleton-line route-skeleton-vault-subtitle" />
          </div>
          <div className="route-skeleton-vault-summary">
            <div className="skeleton-line skeleton-line--short" />
            <div className="skeleton-line skeleton-line--short" />
          </div>
        </header>
        <div className="route-skeleton-filter-row route-skeleton-vault-filters">
          {Array.from({ length: 5 }).map((_, index) => <div key={index} className="skeleton-shape--pill route-skeleton-filter" />)}
        </div>
        {Array.from({ length: 2 }).map((_, groupIndex) => (
          <section key={groupIndex} className="route-skeleton-vault-group">
            <div className="route-skeleton-panel-head">
              <div className="skeleton-line skeleton-line--title" />
              <div className="skeleton-line route-skeleton-count" />
            </div>
            {Array.from({ length: groupIndex === 0 ? 4 : 3 }).map((_, rowIndex) => (
              <div key={rowIndex} className="route-skeleton-vault-row">
                <div className="skeleton-shape--icon" />
                <div className="route-skeleton-vault-row-copy">
                  <div className="skeleton-line skeleton-line--title" />
                  <div className="skeleton-line skeleton-line--short" />
                </div>
                <div className="skeleton-shape--icon" />
              </div>
            ))}
          </section>
        ))}
      </div>
    );
  }

  if (pathname === '/models' || pathname === '/model-data') return <ModelsRouteSkeleton />;
  if (pathname === '/usage') return <UsageRouteSkeleton />;
  if (pathname.startsWith('/settings')) return <SettingsRouteSkeleton />;
  if (pathname === '/agents') return <CompactRouteSkeleton label="正在加载 Agent" />;

  return <CompactRouteSkeleton label="正在加载页面" />;
}

function LazyRoute({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<PageLoading />}>{children}</Suspense>;
}

/**
 * Keep document.title in sync with the active route. Every page used to ship
 * the plain "OKIT" title, which made browser history entries and assistive
 * tech page lists indistinguishable.
 */
function DocumentTitle() {
  const { pathname } = useLocation();
  const { t } = useI18n();

  useEffect(() => {
    const titles: Record<string, string> = {
      '/vault': t('nav.vault'),
      '/models': t('nav.models'),
      '/model-data': '模型数据 DEMO',
      '/usage': t('nav.usage'),
      '/agents': t('nav.agents'),
      '/settings': t('nav.settings'),
    };
    const section = titles[pathname] ?? (pathname.startsWith('/settings') ? t('nav.settings') : null);
    document.title = section ? `${section} · OKIT` : 'OKIT';
  }, [pathname, t]);

  return null;
}

function DeepLinkHandler() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [importCode, setImportCode] = useState<string | null>(null);

  useEffect(() => {
    const kind = searchParams.get('import');
    const code = searchParams.get('code');
    if (kind === 'provider' && code) {
      setImportCode(code);
      // Clean URL after capturing the code
      searchParams.delete('import');
      searchParams.delete('code');
      setSearchParams(searchParams, { replace: true });
    }
  }, []);

  if (!importCode) return null;

  return (
    <ProviderImportModal
      code={importCode}
      onClose={() => setImportCode(null)}
      onImported={() => { /* provider list will refresh on next page load */ }}
    />
  );
}

function DataChangeEvents() {
  useEffect(() => {
    const source = new EventSource('/api/events');
    const onDataChanged = (event: MessageEvent<string>) => {
      try {
        const detail = JSON.parse(event.data);
        if (detail?.type === 'data-changed' && Array.isArray(detail.sections)) {
          if (detail.sections.includes('providers')) invalidateProvidersCache();
          window.dispatchEvent(new CustomEvent('okit:data-changed', { detail }));
        }
      } catch { /* Ignore malformed local events and stay connected. */ }
    };
    source.addEventListener('data-changed', onDataChanged);
    return () => source.close();
  }, []);

  return null;
}

function ModelCacheWarmupBootstrap() {
  useLayoutEffect(() => {
    void startModelCacheWarmup(warmupMissingModels);
  }, []);
  return null;
}

/**
 * Electron's macOS window uses a hidden native title bar so its surface can
 * share the same material as the app. This small renderer-owned strip keeps
 * the window recognisable and supplies a safe drag area without affecting the
 * browser version of OKIT.
 */
function DesktopWindowFrame({
  children,
  sidebarCollapsed = true,
  onToggleSidebar,
  showSidebarToggle = false,
}: {
  children: React.ReactNode;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  showSidebarToggle?: boolean;
}) {
  const isDesktop = typeof window !== 'undefined' && Boolean((window as any).okitDesktop);
  const { t } = useI18n();
  if (!isDesktop) return <>{children}</>;
  return (
    <div className="desktop-window-frame">
      <div className="desktop-titlebar" aria-label="OKIT desktop window">
        {showSidebarToggle && (
          <button
            type="button"
            className="desktop-titlebar-sidebar-toggle"
            aria-label={sidebarCollapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
            title={sidebarCollapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
            onClick={onToggleSidebar}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
        )}
        <TitlebarUpdateIndicator />
      </div>
      {children}
    </div>
  );
}

/**
 * Compact update indicator in the desktop titlebar: silent auto-check on app
 * open → "有新版本" download chip → spinning progress → "重启安装" once the
 * installer lands. Hidden entirely when up to date; a no-op in the browser.
 */
function TitlebarUpdateIndicator() {
  const isDesktop = typeof window !== 'undefined' && Boolean((window as any).okitDesktop);
  const { t } = useI18n();
  const { showToast } = useApp() as any;
  const { update, download, downloading, downloadProgress, check, startDownload, restart, restarting } = useAppUpdate({ autoCheck: isDesktop });

  // macOS app-menu "检查更新…" → explicit check with a spoken result.
  useEffect(() => {
    if (!isDesktop) return;
    const desktop = (window as any).okitDesktop;
    const off = desktop?.onCheckUpdate?.(async () => {
      const result = await check(false);
      if (result.status === 'upToDate') showToast(t('update.menuUpToDate'), 'success');
      else if (result.status === 'available') showToast(t('update.menuFound', { version: result.latest ?? '' }), 'success');
      else if (result.status === 'error') showToast(result.error || t('update.checkFailed'), 'error');
    });
    return () => off?.();
  }, [isDesktop, check, showToast, t]);

  if (!isDesktop || update.status !== 'available') return null;

  if (downloading) {
    return (
      <span className="titlebar-update is-downloading" role="status">
        <Loader2 size={14} className="spin" aria-hidden="true" />
        <span>{downloadProgress === null ? t('update.downloading') : `${downloadProgress}%`}</span>
      </span>
    );
  }
  if (download?.status === 'completed') {
    return (
      <button type="button" className="titlebar-update is-ready" onClick={restart} disabled={restarting}>
        <RotateCcw size={14} className={restarting ? 'spin' : undefined} aria-hidden="true" />
        <span>{restarting ? t('update.restarting') : t('update.restartToInstall')}</span>
      </button>
    );
  }
  if (download?.status === 'failed') {
    return (
      <button type="button" className="titlebar-update is-failed" onClick={startDownload} title={download.error || t('update.failedTooltip')}>
        <CircleAlert size={14} aria-hidden="true" />
        <span>{t('update.retryDownload')}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      className="titlebar-update is-available"
      onClick={startDownload}
      title={t('update.availableTooltip', { version: update.latest ?? '' })}
    >
      <ArrowDownToLine size={14} aria-hidden="true" />
      <span>{t('update.found', { version: update.latest ?? '' })}</span>
    </button>
  );
}

/**
 * Keep the frequently revisited pages mounted after their first visit.
 * Switching between routes then changes visibility instead of throwing away
 * their fetched data, scroll position, and local UI state.
 */
function PersistentDashboardRoutes() {
  const location = useLocation();
  const pathname = location.pathname;
  const [visited, setVisited] = useState(() => new Set([pathname]));

  useEffect(() => {
    setVisited(prev => prev.has(pathname) ? prev : new Set(prev).add(pathname));
  }, [pathname]);

  const keepAlivePaths = ['/', '/usage', '/models', '/vault'];
  const isActive = (p: string) => pathname === p;
  // Mount the active page immediately on first navigation; the effect above
  // records it for future switches without introducing a blank frame.
  const wasVisited = (p: string) => visited.has(p) || isActive(p);

  const keepAliveActive = keepAlivePaths.some(isActive);

  return (
    <>
      {wasVisited('/') && (
        <div className="route-keepalive" hidden={!isActive('/')} aria-hidden={!isActive('/')}>
          <LazyRoute><HomePage /></LazyRoute>
        </div>
      )}
      {wasVisited('/usage') && (
        <div className="route-keepalive" hidden={!isActive('/usage')} aria-hidden={!isActive('/usage')}>
          <LazyRoute><UsagePage /></LazyRoute>
        </div>
      )}
      {wasVisited('/models') && (
        <div className="route-keepalive" hidden={!isActive('/models')} aria-hidden={!isActive('/models')}>
          <LazyRoute><ModelsPage /></LazyRoute>
        </div>
      )}
      {wasVisited('/vault') && (
        <div className="route-keepalive" hidden={!isActive('/vault')} aria-hidden={!isActive('/vault')}>
          <LazyRoute><VaultPage /></LazyRoute>
        </div>
      )}
      {!keepAliveActive && (
        <Routes>
          <Route path="/onboarding" element={<LazyRoute><OnboardingPage /></LazyRoute>} />
          <Route path="/vault" element={<LazyRoute><VaultPage /></LazyRoute>} />
          <Route path="/models" element={<LazyRoute><ModelsPage /></LazyRoute>} />
          <Route path="/agents" element={<LazyRoute><AgentsPage /></LazyRoute>} />
          <Route path="/settings" element={<LazyRoute><SettingsPage /></LazyRoute>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      )}
    </>
  );
}

export default function App() {
  // First-entry gate: render NOTHING until we know whether onboarding is
  // done — otherwise the product shell flashes one frame before the wizard
  // redirect kicks in. Cached per session so returning users paint instantly.
  const [gate, setGate] = useState<'checking' | 'app' | 'wizard'>(
    () => (primeOnboardingFromSession() ? 'app' : 'checking'),
  );
  const location = useLocation();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('okit-sidebar-collapsed') !== 'false');

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(collapsed => {
      const next = !collapsed;
      localStorage.setItem('okit-sidebar-collapsed', String(next));
      return next;
    });
  }, []);

  useEffect(() => {
    if (gate !== 'checking') return;
    if (getOnboardingDoneCache() !== null) {
      setGate(getOnboardingDoneCache() ? 'app' : 'wizard');
      return;
    }
    getOnboarding().then(res => {
      setOnboardingDone(!!(res as any).done);
      setGate((res as any).done ? 'app' : 'wizard');
    }).catch(() => setGate('app'));
  }, [gate]);

  // gate 'wizard' renders the wizard standalone (pathname stays '/', so a
  // pathname-based flip would kill it instantly) — completion is signalled
  // by the wizard itself via onComplete.

  if (gate === 'checking') {
    return <DesktopWindowFrame><div className="app-boot-gate" aria-hidden="true" /></DesktopWindowFrame>;
  }

  if (gate === 'wizard') {
    return (
      <DesktopWindowFrame>
        <DocumentTitle />
        <Suspense fallback={<div className="app-boot-gate" aria-hidden="true" />}>
          <OnboardingPage onComplete={() => setGate('app')} />
        </Suspense>
      </DesktopWindowFrame>
    );
  }

  return (
    <DesktopWindowFrame
      sidebarCollapsed={sidebarCollapsed}
      onToggleSidebar={toggleSidebar}
      showSidebarToggle
    >
      <DocumentTitle />
      <ModelCacheWarmupBootstrap />
      <Routes>
        {/* Standalone model/platform data demo — intentionally not part of the product shell. */}
        <Route path="/model-data" element={<LazyRoute><ModelDataPage /></LazyRoute>} />
        <Route path="*" element={
          <div id="app">
            <DeepLinkHandler />
            <DataChangeEvents />
            <Sidebar collapsed={sidebarCollapsed} />
              <main className="main-content">
                <div className="tab-content">
                  <PersistentDashboardRoutes />
                </div>
              </main>
          </div>
        } />
      </Routes>
    </DesktopWindowFrame>
  );
}
