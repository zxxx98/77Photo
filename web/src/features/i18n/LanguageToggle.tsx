import { useI18n } from '../../app/I18nProvider';
import { languageToggleLabel, nextLocale } from './languageToggle';

export default function LanguageToggle() {
  const { locale, setLocale } = useI18n();
  return <button
    className="language-toggle"
    type="button"
    aria-label={languageToggleLabel(locale)}
    aria-pressed={locale === 'en'}
    onClick={() => setLocale(nextLocale(locale))}
  >
    <span className={locale === 'zh' ? 'is-active' : ''}>中文</span>
    <span aria-hidden="true">/</span>
    <span className={locale === 'en' ? 'is-active' : ''}>English</span>
  </button>;
}
