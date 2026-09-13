import type { Locale } from '../../app/i18n';

export function nextLocale(locale: Locale): Locale {
  return locale === 'zh' ? 'en' : 'zh';
}

export function languageToggleLabel(locale: Locale): string {
  return locale === 'zh' ? '切换到 English' : 'Switch to 中文';
}
