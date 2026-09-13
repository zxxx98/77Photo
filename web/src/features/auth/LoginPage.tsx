import { FormEvent, useState } from 'react';
import { ArrowRight, LockKeyhole } from 'lucide-react';
import { ApiError } from '../../app/api';
import { SessionStore } from '../../app/auth';
import { useI18n } from '../../app/I18nProvider';
import LanguageToggle from '../i18n/LanguageToggle';
import BrandMark from '../branding/BrandMark';

export default function LoginPage({ store }: { store: SessionStore }) {
  const { t } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await store.login(username, password);
    } catch (error) {
      setMessage(error instanceof ApiError && error.status === 429 ? t('auth.tooManyAttempts') : t('auth.invalidCredentials'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-atmosphere" aria-label={t('auth.familyLibrary')}>
        <div className="atmosphere-top"><BrandMark /><span>77Photo</span></div>
        <div className="atmosphere-copy"><span className="eyebrow">{t('auth.familyLibrary')}</span><h1>{t('auth.keepMoments')}</h1><p>{t('auth.atmosphereDescription')}</p></div>
        <div className="memory-strips" aria-hidden="true"><span className="memory-strip strip-one" /><span className="memory-strip strip-two" /><span className="memory-strip strip-three" /></div>
        <span className="atmosphere-foot">{t('auth.storedOnOwnServer')}</span>
      </section>
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-panel-inner">
          <div className="login-toolbar"><div className="mobile-brand"><BrandMark /><strong>77Photo</strong></div><LanguageToggle /></div>
          <div className="login-heading"><span className="eyebrow">{t('auth.welcomeBack')}</span><h2 id="login-title">{t('auth.signInToLibrary')}</h2><p>{t('auth.photosWaiting')}</p></div>
          <form className="login-form" onSubmit={submit}>
            <label>{t('auth.username')}<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus required /></label>
            <label>{t('auth.password')}<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" required /></label>
            {message && <p className="form-message" role="alert"><LockKeyhole size={16} />{message}</p>}
            <button className="button button-primary submit-button" type="submit" disabled={busy}>{busy ? t('auth.signingIn') : t('auth.signIn')}<ArrowRight size={18} /></button>
          </form>
          <p className="login-note">{t('auth.invitedAccess')}</p>
        </div>
      </section>
    </main>
  );
}
