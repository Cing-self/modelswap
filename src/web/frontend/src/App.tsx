import { Routes, Route, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { useState, useEffect, lazy, Suspense } from 'react';
import { getOnboarding } from './api/settings';
import { primeOnboardingFromSession, getOnboardingDoneCache, setOnboardingDone } from './lib/onboardingGate';
import Sidebar from './components/Layout/Sidebar';
import ProviderImportModal from './components/shared/ProviderImportModal';
import { useI18n } from './i18n';

// Route-level code splitting: heavy pages are loaded on demand so the main
// entry chunk stays small. A lightweight, layout-stable placeholder is shown
// while a chunk loads to avoid visible layout shifts.
const HomePage = lazy(() => import('./components/home/HomePage'));
const ModelsPage = lazy(() => import('./components/models/ModelsPage'));
const UsagePage = lazy(() => import('./components/usage/UsagePage'));
const VaultPage = lazy(() => import('./components/vault/VaultPage'));
const SettingsPage = lazy(() => import('./components/settings/SettingsPage'));
const OnboardingPage = lazy(() => import('./components/onboarding/OnboardingPage'));
const AgentsPage = lazy(() => import('./components/agents/AgentsPage'));
const ModelCatalogPage = lazy(() => import('./components/catalog/ModelCatalogPage'));

function PageLoading() {
  return (
    <div
      className="page-loading"
      aria-busy="true"
      style={{ padding: '2rem', color: 'var(--ink-muted)', fontSize: '0.95rem' }}
    >
      加载中…
    </div>
  );
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
      '/usage': t('nav.usage'),
      '/agents': t('nav.agents'),
      '/settings': t('nav.settings'),
      '/catalog': t('catalog.title'),
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
    return <div className="app-boot-gate" aria-hidden="true" />;
  }

  if (gate === 'wizard') {
    return (
      <>
        <DocumentTitle />
        <Suspense fallback={<div className="app-boot-gate" aria-hidden="true" />}>
          <OnboardingPage onComplete={() => setGate('app')} />
        </Suspense>
      </>
    );
  }

  return (
    <>
      <DocumentTitle />
      <Routes>
        {/* Standalone model catalog — outside the app shell, own design. */}
        <Route path="/catalog" element={<LazyRoute><ModelCatalogPage /></LazyRoute>} />
        <Route path="*" element={
          <div id="app">
            <DeepLinkHandler />
            <Sidebar />
              <main className="main-content">
                <div className="tab-content">
                  <PersistentDashboardRoutes />
                </div>
              </main>
          </div>
        } />
      </Routes>
    </>
  );
}
