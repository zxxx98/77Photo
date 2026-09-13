import { createContext, ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { browserStorage, formatCalendarDate, formatCount, formatDate, readStoredLocale, setStoredLocale, translate, type Locale, type TranslationKey, type TranslationParams } from './i18n';

export interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey, params?: TranslationParams) => string;
  formatCount: (value: number) => string;
  formatDate: (value: string | number | Date) => string;
  formatCalendarDate: (value: string | number | Date) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => readStoredLocale(browserStorage()));
  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    setStoredLocale(browserStorage(), next);
  }, []);
  const value = useMemo<I18nContextValue>(() => ({
    locale,
    setLocale,
    t: (key, params) => translate(locale, key, params),
    formatCount: (value) => formatCount(locale, value),
    formatDate: (value) => formatDate(locale, value),
    formatCalendarDate: (value) => formatCalendarDate(locale, value),
  }), [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used within I18nProvider');
  return context;
}
