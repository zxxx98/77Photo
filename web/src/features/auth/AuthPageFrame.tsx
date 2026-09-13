import type { ReactNode } from 'react';
import { useI18n } from '../../app/I18nProvider';
import BrandMark from '../branding/BrandMark';
import LanguageToggle from '../i18n/LanguageToggle';

export default function AuthPageFrame({ pageClassName = '', titleId, eyebrow, title, description, note, children }: { pageClassName?: string; titleId: string; eyebrow: string; title: string; description: string; note: string; children: ReactNode }) {
  const { t } = useI18n();
  return <main className={`login-page ${pageClassName}`.trim()}><section className="login-atmosphere" aria-label={t('auth.familyLibrary')}><div className="atmosphere-top"><BrandMark /><span>77Photo</span></div><div className="atmosphere-copy"><span className="eyebrow">{t('auth.familyLibrary')}</span><h1>{t('auth.keepMoments')}</h1><p>{t('auth.atmosphereDescription')}</p></div><div className="memory-strips" aria-hidden="true"><span className="memory-strip strip-one" /><span className="memory-strip strip-two" /><span className="memory-strip strip-three" /></div><span className="atmosphere-foot">{t('auth.storedOnOwnServer')}</span></section><section className="login-panel" aria-labelledby={titleId}><div className="login-panel-inner"><div className="login-toolbar"><div className="mobile-brand"><BrandMark /><strong>77Photo</strong></div><LanguageToggle /></div><div className="login-heading"><span className="eyebrow">{eyebrow}</span><h2 id={titleId}>{title}</h2><p>{description}</p></div>{children}<p className="login-note">{note}</p></div></section></main>;
}
