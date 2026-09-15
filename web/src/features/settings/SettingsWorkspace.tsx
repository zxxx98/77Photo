import { FormEvent, useEffect, useState } from 'react';
import { ShieldCheck, UserRound, RefreshCw } from 'lucide-react';
import { useI18n } from '../../app/I18nProvider';
import type { ApiClient, RescanJob, User } from '../../app/api';

export default function SettingsWorkspace({ api, currentUser }: { api: ApiClient; currentUser: User }) {
  const { t, formatCount } = useI18n();
  const [users, setUsers] = useState<User[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [scanJob, setScanJob] = useState<RescanJob | null>(null);
  const [scanStarting, setScanStarting] = useState(false);
  const scanActive = scanStarting || scanJob?.status === 'queued' || scanJob?.status === 'running';

  useEffect(() => {
    if (currentUser.role !== 'admin') return;
    void api.listUsers().then((response) => setUsers(response.items)).catch(() => setMessage(t('settings.onlyAdmins')));
  }, [api, currentUser.role, t]);

  useEffect(() => {
    const id = scanJob?.id ?? '';
    if (!id) return;
    let disposed = false;
    let timer: number | undefined;

    async function poll() {
      try {
        const next = await api.getRescan(id);
        if (disposed) return;
        setScanJob(next);
        setScanMessage(null);
        if (next.status === 'queued' || next.status === 'running') {
          timer = window.setTimeout(() => void poll(), 1000);
        }
      } catch {
        if (disposed) return;
        setScanMessage(t('settings.scanPollFailed'));
        timer = window.setTimeout(() => void poll(), 1000);
      }
    }

    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [api, scanJob?.id, t]);

  async function toggle(user: User) {
    setBusy(true);
    setMessage(null);
    try {
      const updated = await api.updateUser(user.id, { is_active: !user.is_active });
      setUsers((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch {
      setMessage(t('settings.accountUpdateFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function remove(user: User) {
    if (!window.confirm(t('settings.confirmDelete', { name: user.username }))) return;
    setBusy(true);
    try {
      await api.deleteUser(user.id);
      setUsers((current) => current.filter((item) => item.id !== user.id));
    } catch {
      setMessage(t('settings.accountDeleteFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!newUsername.trim() || !newPassword) return;
    setBusy(true);
    try {
      const user = await api.createUser({ username: newUsername.trim(), password: newPassword, role: 'user' });
      setUsers((current) => [...current, user]);
      setNewUsername('');
      setNewPassword('');
    } catch {
      setMessage(t('settings.accountCreateFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function rescan() {
    if (scanActive) return;
    setScanStarting(true);
    setScanMessage(null);
    try {
      setScanJob(await api.startRescan());
    } catch {
      setScanJob(null);
      setScanMessage(t('settings.scanFailed'));
    } finally {
      setScanStarting(false);
    }
  }

  const scanStatusLabel = scanJob?.status === 'running'
    ? t('settings.scanRunning')
    : scanJob?.status === 'completed'
      ? t('settings.scanCompleted')
      : scanJob?.status === 'failed'
        ? t('settings.scanRunFailed')
        : t('settings.scanQueued');
  const counts = scanJob?.counts;

  return <section className="settings-workspace" aria-labelledby="settings-title">
    <div className="workspace-heading">
      <div><span className="eyebrow">{t('settings.yourAccount')}</span><h1 id="settings-title">{t('settings.title')}</h1></div>
      <UserRound size={21} />
    </div>
    <div className="account-summary">
      <span className="avatar">{currentUser.username.slice(0, 1).toUpperCase()}</span>
      <div><strong>{currentUser.username}</strong><small>{currentUser.role === 'admin' ? t('shell.administrator') : t('shell.familyMember')}</small></div>
    </div>
    {currentUser.role === 'admin' && <>
      <div className="settings-section-heading"><h2>{t('settings.familyAccounts')}</h2><span><ShieldCheck size={15} /> {t('settings.adminAccess')}</span></div>
      {message && <p className="inline-state" role="alert">{message}</p>}
      <form className="new-user-form" onSubmit={create}>
        <input aria-label={t('settings.newUsername')} placeholder={t('settings.newUsername')} value={newUsername} onChange={(event) => setNewUsername(event.target.value)} />
        <input aria-label={t('settings.temporaryPassword')} type="password" placeholder={t('settings.temporaryPassword')} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
        <button className="button button-secondary" disabled={busy}>{t('settings.addMember')}</button>
      </form>
      <div className="user-list">
        {users.map((user) => <div className="user-row" key={user.id}>
          <div><strong>{user.username}</strong><small>{user.role === 'admin' ? t('shell.administrator') : t('shell.familyMember')} · {user.is_active ? t('settings.active') : t('settings.disabled')}</small></div>
          <button className="button button-secondary" disabled={busy || user.id === currentUser.id} onClick={() => void toggle(user)}>{user.is_active ? t('settings.disable') : t('settings.enable')}</button>
          <button className="text-button" disabled={busy || user.id === currentUser.id} onClick={() => void remove(user)}>{t('settings.delete')}</button>
        </div>)}
      </div>
      <div className="settings-section-heading scan-heading">
        <h2>{t('settings.libraryIndex')}</h2>
        <button className="button button-secondary" disabled={scanActive} onClick={() => void rescan()}><RefreshCw size={15} /> {t('settings.rescanFiles')}</button>
      </div>
      {scanMessage && <p className="inline-state" role="alert">{scanMessage}</p>}
      {scanJob && counts && <div className="scan-progress" role="status" aria-live="polite">
        <div className="scan-progress-heading"><span>{scanStatusLabel}</span><span>{formatCount(counts.scanned)}</span></div>
        <div
          className={`progress-track scan-progress-track ${scanActive ? 'is-active' : ''}`}
          role="progressbar"
          aria-label={scanStatusLabel}
          aria-valuemin={0}
          aria-valuemax={100}
          {...(scanJob.status === 'completed' ? { 'aria-valuenow': 100 } : {})}
        >
          <span className={scanJob.status === 'completed' ? 'is-complete' : ''} />
        </div>
        <div className="scan-progress-counts">
          <span>{t('settings.scanScanned', { count: formatCount(counts.scanned) })}</span>
          <span>{t('settings.scanAdded', { count: formatCount(counts.added) })}</span>
          <span>{t('settings.scanUpdated', { count: formatCount(counts.updated) })}</span>
          <span>{t('settings.scanMissing', { count: formatCount(counts.missing) })}</span>
          <span>{t('settings.scanErrors', { count: formatCount(counts.failed) })}</span>
        </div>
      </div>}
    </>}
  </section>;
}
