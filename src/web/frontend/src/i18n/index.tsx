import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import zh from './zh';
import en from './en';

type Lang = 'zh' | 'en';
type Translations = Record<keyof typeof zh, string>;

const translations: Record<Lang, Translations> = { zh, en };

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  /** Translate a provider name — falls back to original if no translation key exists */
  providerName: (id: string, fallback: string) => string;
}

const I18nContext = createContext<I18nContextValue>(null!);

export function useI18n() {
  return useContext(I18nContext);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    const saved = localStorage.getItem('okit-lang');
    if (saved === 'en' || saved === 'zh') return saved;
    return 'zh';
  });

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    localStorage.setItem('okit-lang', next);
  }, []);

  const t = useCallback((key: string, params?: Record<string, string | number>): string => {
    const dict = translations[lang] as any;
    let value = dict[key];
    if (value === undefined) {
      // fallback to zh
      value = (translations.zh as any)[key];
    }
    if (value === undefined) return key;
    if (!params) return value;
    return value.replace(/\{(\w+)\}/g, (_: string, k: string) => String(params[k] ?? `{${k}}`));
  }, [lang]);

  const providerName = useCallback((id: string, fallback: string): string => {
    const key = `provider.${id}`;
    const dict = translations[lang] as any;
    return dict[key] ?? fallback;
  }, [lang]);

  return (
    <I18nContext.Provider value={{ lang, setLang, t, providerName }}>
      {children}
    </I18nContext.Provider>
  );
}
