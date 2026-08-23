import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { I18nProvider, useI18n } from '../../i18n';
import { AlertCircle, CheckCircle2, Info } from 'lucide-react';

interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface ConfirmOptions {
  title?: string;
  type?: 'danger' | 'warn' | 'info';
}

interface AppContextValue {
  theme: 'dark' | 'light';
  themeMode: 'system' | 'dark' | 'light';
  setThemeMode: (theme: 'system' | 'dark' | 'light') => void;
  toggleTheme: () => void;
  uiStyle: string;
  setUiStyle: (style: string) => void;
  toasts: Toast[];
  showToast: (message: string, type?: Toast['type']) => void;
  confirm: (message: string, options?: ConfirmOptions) => Promise<boolean>;
  connectionStatus: 'connecting' | 'connected' | 'error';
  setConnectionStatus: (s: AppContextValue['connectionStatus']) => void;
}

const AppContext = createContext<AppContextValue>(null!);

export function useApp() {
  return useContext(AppContext);
}

function AppProviderInner({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const [themeMode, setThemeModeState] = useState<'system' | 'dark' | 'light'>(() => {
    const saved = localStorage.getItem('okit-theme');
    if (saved === 'dark' || saved === 'light') return saved;
    return 'system';
  });
  const [systemTheme, setSystemTheme] = useState<'dark' | 'light'>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  );
  const theme: 'dark' | 'light' = themeMode === 'system' ? systemTheme : themeMode;
  const [uiStyle, setUiStyleState] = useState(() => {
    const saved = localStorage.getItem('okit-style');
    return saved || 'command';
  });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<AppContextValue['connectionStatus']>('connecting');

  const confirmState = useRef<{
    resolve: (v: boolean) => void;
    message: string;
    options: ConfirmOptions;
    visible: boolean;
  }>({ resolve: () => {}, message: '', options: {}, visible: false });
  const [, forceUpdate] = useState(0);
  const toastIdRef = useRef(0);
  const confirmPanelRef = useRef<HTMLDivElement>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);
  const confirmPreviousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const syncSystemTheme = (event?: MediaQueryListEvent) => {
      setSystemTheme((event?.matches ?? media.matches) ? 'dark' : 'light');
    };
    syncSystemTheme();
    media.addEventListener('change', syncSystemTheme);
    return () => media.removeEventListener('change', syncSystemTheme);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-style', uiStyle);
  }, [uiStyle]);

  const setUiStyle = useCallback((next: string) => {
    localStorage.setItem('okit-style', next);
    setUiStyleState(next);
  }, []);

  const toggleTheme = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('okit-theme', next);
    setThemeModeState(next);
  }, [theme]);

  const setThemeMode = useCallback((next: 'system' | 'dark' | 'light') => {
    if (next === 'system') localStorage.removeItem('okit-theme');
    else localStorage.setItem('okit-theme', next);
    setThemeModeState(next);
  }, []);

  const showToast = useCallback((message: string, type: Toast['type'] = 'success') => {
    const id = ++toastIdRef.current;
    setToasts(prev => [
      ...prev.filter(toast => toast.message !== message),
      { id, message, type },
    ].slice(-3));
    const duration = type === 'error' ? 6000 : type === 'info' ? 4500 : 3000;
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, duration);
  }, []);

  const confirm = useCallback((message: string, options: ConfirmOptions = {}) => {
    return new Promise<boolean>(resolve => {
      confirmState.current = { resolve, message, options, visible: true };
      forceUpdate(n => n + 1);
    });
  }, []);

  const resolveConfirm = useCallback((result: boolean) => {
    confirmState.current.resolve(result);
    confirmState.current.visible = false;
    forceUpdate(n => n + 1);
  }, []);

  const confirmVisible = confirmState.current.visible;
  useEffect(() => {
    if (!confirmVisible) return;
    confirmPreviousFocusRef.current = document.activeElement as HTMLElement | null;
    confirmCancelRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        resolveConfirm(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = Array.from(confirmPanelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') || []);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      confirmPreviousFocusRef.current?.focus();
    };
  }, [confirmVisible, resolveConfirm]);

  return (
<AppContext.Provider
        value={{
          theme,
          themeMode,
          setThemeMode,
          toggleTheme,
          uiStyle,
          setUiStyle,
          toasts,
          showToast,
          confirm,
          connectionStatus,
          setConnectionStatus,
        }}
      >
      {children}
      {/* Toast container */}
      <div className="toast-container">
        {toasts.map(t => (
          <div
            key={t.id}
            className={`toast ${t.type} show`}
            role={t.type === 'error' ? 'alert' : 'status'}
            aria-live={t.type === 'error' ? 'assertive' : 'polite'}
            aria-atomic="true"
          >
            <span className="toast-icon" aria-hidden="true">
              {t.type === 'error'
                ? <AlertCircle size={16} />
                : t.type === 'info'
                  ? <Info size={16} />
                  : <CheckCircle2 size={16} />}
            </span>
            <span className="toast-message">{t.message}</span>
          </div>
        ))}
      </div>
      {/* Confirm modal */}
      {confirmState.current.visible && (
        <div className="auth-overlay" style={{ display: '' }}>
          <div ref={confirmPanelRef} className="confirm-panel" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-message">
            <div className={`confirm-icon confirm-icon--${confirmState.current.options.type || 'danger'}`}>
              <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                <circle cx="14" cy="14" r="12" stroke="currentColor" strokeWidth="2" />
                <path d="M10 18l8-8M18 18l-8-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </div>
            <div className="confirm-body">
              <div className="confirm-title" id="confirm-dialog-title">{confirmState.current.options.title || t('common.confirmAction')}</div>
              <div className="confirm-message" id="confirm-dialog-message" dangerouslySetInnerHTML={{ __html: confirmState.current.message }} />
            </div>
            <div className="confirm-actions">
              <button ref={confirmCancelRef} className="confirm-btn confirm-btn--cancel" onClick={() => resolveConfirm(false)}>{t('common.cancel')}</button>
              <button
                className={`confirm-btn confirm-btn--ok${confirmState.current.options.type === 'danger' ? ' confirm-btn--danger' : ''}`}
                onClick={() => resolveConfirm(true)}
              >
                {t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppContext.Provider>
  );
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <AppProviderInner>{children}</AppProviderInner>
    </I18nProvider>
  );
}
