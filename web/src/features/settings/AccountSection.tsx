import { FormEvent, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { useI18n } from '../../app/I18nProvider';
import { ApiError, type ApiClient, type User } from '../../app/api';
import SettingsCard from './SettingsCard';

export default function AccountSection({ api, currentUser }: { api: ApiClient; currentUser: User }) {
  const { t } = useI18n();
  const [ownPassword, setOwnPassword] = useState({ current: '', next: '', confirm: '' });
  const [ownPasswordBusy, setOwnPasswordBusy] = useState(false);
  const [ownPasswordMessage, setOwnPasswordMessage] = useState<{ text: string; ok: boolean } | null>(null);

  async function changeOwnPassword(event: FormEvent) {
    event.preventDefault();
    if (!ownPassword.current || !ownPassword.next) return;
    if (ownPassword.next !== ownPassword.confirm) {
      setOwnPasswordMessage({ text: t('settings.password.mismatch'), ok: false });
      return;
    }
    setOwnPasswordBusy(true);
    setOwnPasswordMessage(null);
    try {
      await api.changePassword(ownPassword.current, ownPassword.next);
      setOwnPassword({ current: '', next: '', confirm: '' });
      setOwnPasswordMessage({ text: t('settings.password.changed'), ok: true });
    } catch (error) {
      const code = error instanceof ApiError ? error.code : '';
      setOwnPasswordMessage({
        text: code === 'CURRENT_PASSWORD_INCORRECT' ? t('settings.password.incorrect')
          : code === 'PASSWORD_INVALID' ? t('settings.passwordInvalid')
            : code === 'LOGIN_RATE_LIMITED' ? t('settings.password.rateLimited')
              : t('settings.password.failed'),
        ok: false,
      });
    } finally {
      setOwnPasswordBusy(false);
    }
  }

  return <>
    <div className="account-summary">
      <span className="avatar">{currentUser.username.slice(0, 1).toUpperCase()}</span>
      <div><strong>{currentUser.username}</strong><small>{currentUser.role === 'admin' ? t('shell.administrator') : t('shell.familyMember')}</small></div>
    </div>
    <SettingsCard icon={KeyRound} title={t('settings.password.title')} summary={t('settings.password.summary')}>
      <form className="password-form" onSubmit={changeOwnPassword}>
        <input aria-label={t('settings.password.current')} placeholder={t('settings.password.current')} type="password" autoComplete="current-password" value={ownPassword.current} onChange={(event) => setOwnPassword({ ...ownPassword, current: event.target.value })} />
        <input aria-label={t('settings.password.new')} placeholder={t('settings.password.new')} type="password" autoComplete="new-password" minLength={12} maxLength={256} value={ownPassword.next} onChange={(event) => setOwnPassword({ ...ownPassword, next: event.target.value })} />
        <input aria-label={t('settings.password.confirm')} placeholder={t('settings.password.confirm')} type="password" autoComplete="new-password" minLength={12} maxLength={256} value={ownPassword.confirm} onChange={(event) => setOwnPassword({ ...ownPassword, confirm: event.target.value })} />
        <button className="button button-secondary" disabled={ownPasswordBusy}>{t('settings.password.save')}</button>
      </form>
      {ownPasswordMessage && <p className="inline-state" role={ownPasswordMessage.ok ? 'status' : 'alert'}>{ownPasswordMessage.text}</p>}
    </SettingsCard>
  </>;
}
