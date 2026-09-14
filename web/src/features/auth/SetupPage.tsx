import { FormEvent, useState } from 'react';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { SessionStore } from '../../app/auth';
import { useI18n } from '../../app/I18nProvider';
import AuthPageFrame from './AuthPageFrame';

export default function SetupPage({ store }: { store: SessionStore }) {
  const { t } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedUsername = username.trim();
    if (!trimmedUsername) { setMessage(t('setup.usernameRequired')); return; }
    if ([...trimmedUsername].length > 64) { setMessage(t('setup.usernameTooLong')); return; }
    if ([...password].length < 12) { setMessage(t('setup.passwordTooShort')); return; }
    if ([...password].length > 256) { setMessage(t('setup.passwordTooLong')); return; }
    if (password !== confirmation) { setMessage(t('setup.passwordMismatch')); return; }
    setBusy(true);
    setMessage(null);
    try {
      await store.setupAdmin(trimmedUsername, password);
      setUsername('');
      setPassword('');
      setConfirmation('');
    } catch {
      setMessage(t('setup.failed'));
    } finally {
      setBusy(false);
    }
  }

  return <AuthPageFrame pageClassName="setup-page" titleId="setup-title" eyebrow={t('setup.firstRun')} title={t('setup.title')} description={t('setup.description')} note={t('setup.oneTimeNote')}><form className="login-form setup-form" onSubmit={submit}><label>{t('auth.username')}<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus required /></label><label>{t('auth.password')}<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="new-password" required /></label><label>{t('setup.confirmPassword')}<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} type="password" autoComplete="new-password" required /></label><p className="setup-guidance"><ShieldCheck size={15} /> {t('setup.passwordGuidance')}</p>{message && <p className="form-message" role="alert">{message}</p>}<button className="button button-primary submit-button" type="submit" disabled={busy}>{busy ? t('setup.creating') : t('setup.create')}<ArrowRight size={18} /></button></form></AuthPageFrame>;
}
