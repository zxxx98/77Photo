import { FormEvent, useState } from 'react';
import { ArrowRight, LockKeyhole } from 'lucide-react';
import { ApiError } from '../../app/api';
import { SessionStore } from '../../app/auth';
import { useI18n } from '../../app/I18nProvider';
import AuthPageFrame from './AuthPageFrame';

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
    <AuthPageFrame titleId="login-title" eyebrow={t('auth.welcomeBack')} title={t('auth.signInToLibrary')} description={t('auth.photosWaiting')} note={t('auth.invitedAccess')}><form className="login-form" onSubmit={submit}><label>{t('auth.username')}<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus required /></label><label>{t('auth.password')}<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" required /></label>{message && <p className="form-message" role="alert"><LockKeyhole size={16} />{message}</p>}<button className="button button-primary submit-button" type="submit" disabled={busy}>{busy ? t('auth.signingIn') : t('auth.signIn')}<ArrowRight size={18} /></button></form></AuthPageFrame>
  );
}
