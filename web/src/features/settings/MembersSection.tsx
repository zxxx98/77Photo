import { FormEvent, useState, type Dispatch, type SetStateAction } from 'react';
import { Trash2, UserPlus, Users } from 'lucide-react';
import { useI18n } from '../../app/I18nProvider';
import { ApiError, type ApiClient, type Role, type User } from '../../app/api';
import SettingsCard from './SettingsCard';
import UserPicker from './UserPicker';

type MembersSectionProps = {
  api: ApiClient;
  currentUser: User;
  users: User[];
  setUsers: Dispatch<SetStateAction<User[]>>;
  loadError: string | null;
  maintenanceBusy: boolean;
  onMaintenanceConflict: () => void;
};

export default function MembersSection({ api, currentUser, users, setUsers, loadError, maintenanceBusy, onMaintenanceConflict }: MembersSectionProps) {
  const { t, formatCount } = useI18n();
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<Role>('user');
  const [panel, setPanel] = useState<{ userID: string; kind: 'password' | 'delete' } | null>(null);
  const [resetPasswordValue, setResetPasswordValue] = useState('');
  const [deleteAction, setDeleteAction] = useState<'retain' | 'transfer'>('retain');
  const [transferTargetID, setTransferTargetID] = useState('');
  const visibleUsers = users.filter((user) => !user.deleted_at);
  const activeUsers = visibleUsers.filter((user) => user.is_active);
  const error = message ?? loadError;

  function userErrorMessage(error: unknown, fallback: string) {
    const code = error instanceof ApiError ? error.code : '';
    switch (code) {
      case 'USERNAME_TAKEN': return t('settings.usernameTaken');
      case 'USERNAME_INVALID': return t('settings.usernameInvalid');
      case 'PASSWORD_INVALID': return t('settings.passwordInvalid');
      case 'LAST_ADMIN': return t('settings.lastAdmin');
      default: return fallback;
    }
  }

  function openPanel(user: User, kind: 'password' | 'delete') {
    setPanel(panel?.userID === user.id && panel.kind === kind ? null : { userID: user.id, kind });
    setResetPasswordValue('');
    setDeleteAction('retain');
    setTransferTargetID('');
    setMessage(null);
    setNotice(null);
  }

  async function updateMember(user: User, input: Parameters<ApiClient['updateUser']>[1], fallback: string, done?: string) {
    setBusy(true);
    setMessage(null);
    setNotice(null);
    try {
      const updated = await api.updateUser(user.id, input);
      setUsers((current) => current.map((item) => item.id === updated.id ? updated : item));
      if (done) setNotice(done);
      return true;
    } catch (error) {
      setMessage(userErrorMessage(error, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function toggle(user: User) {
    void updateMember(user, { is_active: !user.is_active }, t('settings.accountUpdateFailed'));
  }

  function changeRole(user: User) {
    void updateMember(user, { role: user.role === 'admin' ? 'user' : 'admin' }, t('settings.accountUpdateFailed'));
  }

  async function resetMemberPassword(event: FormEvent, user: User) {
    event.preventDefault();
    if (!resetPasswordValue) return;
    if (await updateMember(user, { password: resetPasswordValue }, t('settings.accountUpdateFailed'), t('settings.passwordResetDone', { name: user.username }))) {
      setPanel(null);
      setResetPasswordValue('');
    }
  }

  async function remove(user: User, transferTarget?: User) {
    if (deleteAction === 'transfer' && !transferTarget) return;
    setBusy(true);
    setMessage(null);
    setNotice(null);
    try {
      await api.deleteUser(user.id, transferTarget ? { photo_action: 'transfer', transfer_to_user_id: transferTarget.id } : { photo_action: 'retain' });
      setUsers((current) => current.filter((item) => item.id !== user.id));
      setPanel(null);
      setNotice(transferTarget ? t('settings.deleteTransferred', { name: user.username, target: transferTarget.username }) : t('settings.deleteDone', { name: user.username }));
    } catch (error) {
      if (error instanceof ApiError && error.code === 'MAINTENANCE_IN_PROGRESS') onMaintenanceConflict();
      else setMessage(userErrorMessage(error, t('settings.accountDeleteFailed')));
    } finally {
      setBusy(false);
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!newUsername.trim() || !newPassword) return;
    setBusy(true);
    setMessage(null);
    setNotice(null);
    try {
      const user = await api.createUser({ username: newUsername.trim(), password: newPassword, role: newRole });
      setUsers((current) => [...current, user]);
      setNewUsername('');
      setNewPassword('');
      setNewRole('user');
    } catch (error) {
      setMessage(userErrorMessage(error, t('settings.accountCreateFailed')));
    } finally {
      setBusy(false);
    }
  }

  return <>
    {error && <p className="settings-notice is-error" role="alert">{error}</p>}
    {notice && <p className="settings-notice" role="status">{notice}</p>}
    <SettingsCard icon={Users} title={t('settings.members.title')} summary={t('settings.members.summary', { count: formatCount(visibleUsers.length) })}>
      <div className="user-list">
        {visibleUsers.map((user) => {
          const self = user.id === currentUser.id;
          const transferTargets = activeUsers.filter((item) => item.id !== user.id);
          const transferTarget = transferTargets.find((item) => item.id === transferTargetID) ?? transferTargets[0];
          return <div key={user.id}>
            <div className="user-row">
              <div><strong>{user.username}</strong><small>{user.role === 'admin' ? t('shell.administrator') : t('shell.familyMember')} · {user.is_active ? t('settings.active') : t('settings.disabled')}</small></div>
              <button className="text-button" disabled={busy || self} onClick={() => changeRole(user)}>{user.role === 'admin' ? t('settings.makeMember') : t('settings.makeAdmin')}</button>
              <button className="text-button" disabled={busy} aria-expanded={panel?.userID === user.id && panel.kind === 'password'} onClick={() => openPanel(user, 'password')}>{t('settings.resetPassword')}</button>
              <button className="button button-secondary" disabled={busy || self} onClick={() => toggle(user)}>{user.is_active ? t('settings.disable') : t('settings.enable')}</button>
              <button className="text-button" disabled={busy || self} aria-expanded={panel?.userID === user.id && panel.kind === 'delete'} onClick={() => openPanel(user, 'delete')}>{t('settings.delete')}</button>
            </div>
            {panel?.userID === user.id && panel.kind === 'password' && <form className="user-row-panel" onSubmit={(event) => void resetMemberPassword(event, user)}>
              <input aria-label={t('settings.resetPasswordFor', { name: user.username })} placeholder={t('settings.resetPasswordFor', { name: user.username })} type="password" autoComplete="new-password" minLength={12} maxLength={256} value={resetPasswordValue} onChange={(event) => setResetPasswordValue(event.target.value)} />
              <button className="button button-secondary" disabled={busy || !resetPasswordValue}>{t('common.save')}</button>
              <button className="text-button" type="button" onClick={() => setPanel(null)}>{t('common.cancel')}</button>
            </form>}
            {panel?.userID === user.id && panel.kind === 'delete' && <div className="user-row-panel" role="group" aria-label={t('settings.deletePrompt', { name: user.username })}>
              <p>{t('settings.deletePrompt', { name: user.username })}</p>
              <div className="thumbnail-mode-toggle" role="group">
                <button type="button" className={`thumbnail-mode-button ${deleteAction === 'retain' ? 'is-selected' : ''}`} aria-pressed={deleteAction === 'retain'} onClick={() => setDeleteAction('retain')}>{t('settings.deleteRetain')}</button>
                <button type="button" className={`thumbnail-mode-button ${deleteAction === 'transfer' ? 'is-selected' : ''}`} aria-pressed={deleteAction === 'transfer'} disabled={transferTargets.length === 0} onClick={() => setDeleteAction('transfer')}>{t('settings.deleteTransfer')}</button>
              </div>
              {deleteAction === 'transfer' && <UserPicker users={transferTargets} value={transferTarget?.id ?? ''} label={t('settings.deleteTransferTarget')} disabled={busy} onChange={setTransferTargetID} />}
              <button className="button button-danger" disabled={busy || (maintenanceBusy && deleteAction === 'transfer')} onClick={() => void remove(user, deleteAction === 'transfer' ? transferTarget : undefined)}><Trash2 size={15} /> {t('settings.deleteConfirm')}</button>
              <button className="text-button" type="button" onClick={() => setPanel(null)}>{t('common.cancel')}</button>
            </div>}
          </div>;
        })}
      </div>
    </SettingsCard>
    <SettingsCard icon={UserPlus} title={t('settings.members.addTitle')} summary={t('settings.members.addSummary')}>
      <form className="new-user-form with-role" onSubmit={create}>
        <input aria-label={t('settings.newUsername')} placeholder={t('settings.newUsername')} value={newUsername} onChange={(event) => setNewUsername(event.target.value)} />
        <input aria-label={t('settings.temporaryPassword')} type="password" minLength={12} maxLength={256} placeholder={t('settings.temporaryPassword')} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
        <div className="thumbnail-mode-toggle" role="group" aria-label={t('settings.role')}>
          {(['user', 'admin'] as const).map((role) => <button
            key={role}
            type="button"
            className={`thumbnail-mode-button ${newRole === role ? 'is-selected' : ''}`}
            aria-pressed={newRole === role}
            onClick={() => setNewRole(role)}
          >{role === 'admin' ? t('settings.roleAdmin') : t('settings.roleMember')}</button>)}
        </div>
        <button className="button button-secondary" disabled={busy}>{t('settings.addMember')}</button>
      </form>
    </SettingsCard>
  </>;
}
