import { FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, FolderInput, ImageIcon, KeyRound, RefreshCw, ShieldCheck, Trash2, UserRound } from 'lucide-react';
import { useI18n } from '../../app/I18nProvider';
import { ApiError, type ApiClient, type Role, type BrokenPhotoScanResult, type ImportJob, type MaintenanceActivity, type RescanJob, type ThumbnailRebuildJob, type ThumbnailRebuildMode, type User } from '../../app/api';

type UserPickerProps = {
  users: User[];
  value: string;
  label: string;
  disabled?: boolean;
  onChange: (userID: string) => void;
};

function UserPicker({ users, value, label, disabled = false, onChange }: UserPickerProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxID = useId();
  const selectedIndex = Math.max(0, users.findIndex((user) => user.id === value));
  const selectedUser = users.find((user) => user.id === value) ?? users[0];

  useEffect(() => {
    if (!open) return;
    setActiveIndex(selectedIndex);

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, selectedIndex]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  function moveActive(nextIndex: number) {
    if (users.length === 0) return;
    const wrapped = (nextIndex + users.length) % users.length;
    setActiveIndex(wrapped);
  }

  function choose(userID: string) {
    onChange(userID);
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled || users.length === 0) return;

    if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        setOpen(false);
      }
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(selectedIndex);
      } else {
        moveActive(activeIndex + 1);
      }
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(selectedIndex);
      } else {
        moveActive(activeIndex - 1);
      }
      return;
    }

    if (!open) return;

    if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(users.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(users[activeIndex]?.id ?? value);
    }
  }

  return <div className={`user-picker ${open ? 'is-open' : ''}`} ref={rootRef}>
    <button
      className="user-picker-trigger"
      type="button"
      role="combobox"
      aria-label={label}
      aria-controls={listboxID}
      aria-expanded={open}
      aria-haspopup="listbox"
      aria-activedescendant={open && users[activeIndex] ? `${listboxID}-${users[activeIndex].id}` : undefined}
      disabled={disabled || users.length === 0}
      onClick={() => setOpen((current) => !current)}
      onKeyDown={onKeyDown}
    >
      {selectedUser ? <>
        <span className="user-picker-avatar" aria-hidden="true">{selectedUser.username.slice(0, 1).toUpperCase()}</span>
        <span className="user-picker-name">{selectedUser.username}</span>
      </> : <span className="user-picker-name">{label}</span>}
      <ChevronDown className="user-picker-chevron" size={15} aria-hidden="true" />
    </button>
    {open && <div className="user-picker-menu" id={listboxID} role="listbox" aria-label={label}>
      {users.map((user, index) => {
        const selected = user.id === value;
        return <button
          className={`user-picker-option ${index === activeIndex ? 'is-active' : ''} ${selected ? 'is-selected' : ''}`}
          id={`${listboxID}-${user.id}`}
          key={user.id}
          type="button"
          role="option"
          aria-selected={selected}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => choose(user.id)}
        >
          <span className="user-picker-avatar" aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</span>
          <span className="user-picker-name">{user.username}</span>
          {selected && <Check className="user-picker-check" size={15} aria-hidden="true" />}
        </button>;
      })}
    </div>}
  </div>;
}

export default function SettingsWorkspace({ api, currentUser }: { api: ApiClient; currentUser: User }) {
  const { t, formatCount } = useI18n();
  const [users, setUsers] = useState<User[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<Role>('user');
  const [notice, setNotice] = useState<string | null>(null);
  const [panel, setPanel] = useState<{ userID: string; kind: 'password' | 'delete' } | null>(null);
  const [resetPasswordValue, setResetPasswordValue] = useState('');
  const [deleteAction, setDeleteAction] = useState<'retain' | 'transfer'>('retain');
  const [transferTargetID, setTransferTargetID] = useState('');
  const [ownPassword, setOwnPassword] = useState({ current: '', next: '', confirm: '' });
  const [ownPasswordBusy, setOwnPasswordBusy] = useState(false);
  const [ownPasswordMessage, setOwnPasswordMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [scanJob, setScanJob] = useState<RescanJob | null>(null);
  const [scanStarting, setScanStarting] = useState(false);
  const [thumbnailMessage, setThumbnailMessage] = useState<string | null>(null);
  const [thumbnailJob, setThumbnailJob] = useState<ThumbnailRebuildJob | null>(null);
  const [thumbnailStarting, setThumbnailStarting] = useState(false);
  const [thumbnailMode, setThumbnailMode] = useState<ThumbnailRebuildMode>('incremental');
  const [importSource, setImportSource] = useState('.');
  const [organizeByDate, setOrganizeByDate] = useState(false);
  const [importUserID, setImportUserID] = useState(currentUser.id);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importJob, setImportJob] = useState<ImportJob | null>(null);
  const [importStarting, setImportStarting] = useState(false);
  const [cleanupScan, setCleanupScan] = useState<BrokenPhotoScanResult | null>(null);
  const [cleanupAction, setCleanupAction] = useState<'scan' | 'clean' | null>(null);
  const [cleanupMessage, setCleanupMessage] = useState<string | null>(null);
  const [otherTask, setOtherTask] = useState<MaintenanceActivity | null>(null);
  const scanActive = scanStarting || scanJob?.status === 'queued' || scanJob?.status === 'running';
  const thumbnailActive = thumbnailStarting || thumbnailJob?.status === 'queued' || thumbnailJob?.status === 'running';
  const importActive = importStarting || importJob?.status === 'queued' || importJob?.status === 'running';
  // The server admits one maintenance task at a time; mirror that here.
  const maintenanceBusy = scanActive || thumbnailActive || importActive || cleanupAction !== null || otherTask !== null;
  const visibleUsers = users.filter((user) => !user.deleted_at);
  const importTargets = visibleUsers.filter((user) => user.is_active);
  const importTargetID = importTargets.some((user) => user.id === importUserID) ? importUserID : importTargets[0]?.id ?? '';

  useEffect(() => {
    if (currentUser.role !== 'admin') return;
    void api.listUsers().then((response) => setUsers(response.items)).catch(() => setMessage(t('settings.usersLoadFailed')));
  }, [api, currentUser.role, t]);

  // Re-attach to a maintenance task that is already running (for example after
  // a page reload) so its progress is shown and conflicting actions stay locked.
  const syncMaintenance = useCallback(async () => {
    try {
      const { active } = await api.getMaintenance();
      if (!active) {
        setOtherTask(null);
        return;
      }
      if (active.job_id && active.kind === 'rescan') setScanJob(await api.getRescan(active.job_id));
      else if (active.job_id && active.kind === 'thumbnail_rebuild') setThumbnailJob(await api.getThumbnailRebuild(active.job_id));
      else if (active.job_id && active.kind === 'import') setImportJob(await api.getImport(active.job_id));
      else {
        setOtherTask(active);
        return;
      }
      setOtherTask(null);
    } catch {
      // Keep the current view; the next action reports its own error.
    }
  }, [api]);

  useEffect(() => {
    if (currentUser.role === 'admin') void syncMaintenance();
  }, [currentUser.role, syncMaintenance]);

  useEffect(() => {
    if (!otherTask) return;
    const timer = window.setTimeout(() => void syncMaintenance(), 2000);
    return () => window.clearTimeout(timer);
  }, [otherTask, syncMaintenance]);

  function isConflict(error: unknown) {
    return error instanceof ApiError && error.status === 409;
  }

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
        if (next.status === 'queued' || next.status === 'running') timer = window.setTimeout(() => void poll(), 1000);
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

  useEffect(() => {
    const id = thumbnailJob?.id ?? '';
    if (!id) return;
    let disposed = false;
    let timer: number | undefined;

    async function poll() {
      try {
        const next = await api.getThumbnailRebuild(id);
        if (disposed) return;
        setThumbnailJob(next);
        setThumbnailMessage(null);
        if (next.status === 'queued' || next.status === 'running') timer = window.setTimeout(() => void poll(), 1000);
      } catch {
        if (disposed) return;
        setThumbnailMessage(t('settings.thumbnail.pollFailed'));
        timer = window.setTimeout(() => void poll(), 1000);
      }
    }

    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [api, thumbnailJob?.id, t]);

  useEffect(() => {
    const id = importJob?.id ?? '';
    if (!id) return;
    let disposed = false;
    let timer: number | undefined;

    async function poll() {
      try {
        const next = await api.getImport(id);
        if (disposed) return;
        setImportJob(next);
        setImportMessage(null);
        if (next.status === 'queued' || next.status === 'running') timer = window.setTimeout(() => void poll(), 1000);
      } catch {
        if (disposed) return;
        setImportMessage(t('settings.import.pollFailed'));
        timer = window.setTimeout(() => void poll(), 1000);
      }
    }

    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [api, importJob?.id, t]);

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
      if (error instanceof ApiError && error.code === 'MAINTENANCE_IN_PROGRESS') void syncMaintenance();
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

  async function rescan() {
    if (maintenanceBusy) return;
    setScanStarting(true);
    setScanMessage(null);
    try {
      setScanJob(await api.startRescan());
    } catch (error) {
      setScanJob(null);
      if (isConflict(error)) void syncMaintenance();
      else setScanMessage(t('settings.scanFailed'));
    } finally {
      setScanStarting(false);
    }
  }

  async function resetLibraryIndex() {
    if (maintenanceBusy) return;
    if (!window.confirm(t('settings.reset.confirm'))) return;
    setScanStarting(true);
    setScanMessage(null);
    setCleanupScan(null);
    try {
      setScanJob(await api.resetLibraryIndex());
    } catch (error) {
      setScanJob(null);
      if (isConflict(error)) void syncMaintenance();
      else setScanMessage(t('settings.reset.failed'));
    } finally {
      setScanStarting(false);
    }
  }

  async function rebuildThumbnails() {
    if (maintenanceBusy) return;
    if (thumbnailMode === 'full' && !window.confirm(t('settings.thumbnail.confirm'))) return;
    setThumbnailStarting(true);
    setThumbnailMessage(null);
    try {
      setThumbnailJob(await api.startThumbnailRebuild(thumbnailMode));
    } catch (error) {
      setThumbnailJob(null);
      if (isConflict(error)) void syncMaintenance();
      else setThumbnailMessage(t('settings.thumbnail.startFailed'));
    } finally {
      setThumbnailStarting(false);
    }
  }

  function describeScan(result: BrokenPhotoScanResult) {
    const found = result.broken === 0 ? t('settings.cleanup.none') : t('settings.cleanup.found', { count: formatCount(result.broken) });
    return result.skipped ? `${found} ${t('settings.cleanup.skipped', { count: formatCount(result.skipped) })}` : found;
  }

  async function scanBrokenPhotos() {
    if (maintenanceBusy) return;
    setCleanupAction('scan');
    setCleanupMessage(null);
    try {
      const result = await api.scanBrokenPhotos();
      setCleanupScan(result);
      setCleanupMessage(describeScan(result));
    } catch (error) {
      setCleanupScan(null);
      if (isConflict(error)) void syncMaintenance();
      else setCleanupMessage(t('settings.cleanup.scanFailed'));
    } finally {
      setCleanupAction(null);
    }
  }

  async function cleanupBrokenPhotos() {
    if (maintenanceBusy || !cleanupScan?.broken || !window.confirm(t('settings.cleanup.confirm', { count: formatCount(cleanupScan.broken) }))) return;
    setCleanupAction('clean');
    setCleanupMessage(null);
    try {
      // Only the photos the administrator just reviewed are sent; the server
      // re-verifies each one and leaves anything no longer broken untouched.
      const result = await api.cleanupBrokenPhotos(cleanupScan.items.map((item) => item.id));
      setCleanupMessage(result.failed > 0 ? t('settings.cleanup.partial', { deleted: formatCount(result.deleted), failed: formatCount(result.failed) }) : t('settings.cleanup.completed', { count: formatCount(result.deleted) }));
      setCleanupScan(null);
    } catch (error) {
      if (isConflict(error)) void syncMaintenance();
      else setCleanupMessage(t('settings.cleanup.failed'));
    } finally {
      setCleanupAction(null);
    }
  }

  async function startImport(event: FormEvent) {
    event.preventDefault();
    if (maintenanceBusy || !importTargetID) return;
    setImportStarting(true);
    setImportMessage(null);
    try {
      setImportJob(await api.startImport({ source_path: importSource.trim() || '.', user_id: importTargetID, organize_by_date: organizeByDate }));
    } catch (error) {
      setImportJob(null);
      if (isConflict(error)) void syncMaintenance();
      else setImportMessage(t('settings.import.startFailed'));
    } finally {
      setImportStarting(false);
    }
  }

  const scanStatusLabel = scanJob?.status === 'running'
    ? t(`settings.scanPhase.${scanJob.phase ?? 'discovering'}`)
    : scanJob?.status === 'completed'
      ? t('settings.scanCompleted')
      : scanJob?.status === 'failed'
        ? t('settings.scanRunFailed')
        : t('settings.scanQueued');
  const counts = scanJob?.counts;
  const scanPercent = scanJob?.status === 'completed' ? 100
    : scanJob?.phase === 'indexing' && (scanJob.total ?? 0) > 0
      ? Math.min(99, Math.round(((scanJob.processed ?? 0) / scanJob.total!) * 100)) : undefined;
  const thumbnailStatusLabel = thumbnailJob?.status === 'running'
    ? t('settings.thumbnail.running')
    : thumbnailJob?.status === 'completed'
      ? t('settings.thumbnail.completed')
      : thumbnailJob?.status === 'failed'
        ? t('settings.thumbnail.failed')
        : t('settings.thumbnail.queued');
  const thumbnailCounts = thumbnailJob?.counts;
  const thumbnailPercent = thumbnailCounts && thumbnailCounts.total > 0
    ? Math.min(100, Math.round((thumbnailCounts.processed / thumbnailCounts.total) * 100))
    : thumbnailJob?.status === 'completed' ? 100 : 0;
  const importStatusLabel = importJob?.status === 'running'
    ? t('settings.import.running')
    : importJob?.status === 'completed'
      ? t('settings.import.completed')
      : importJob?.status === 'failed'
        ? t('settings.import.failed')
        : t('settings.import.queued');

  return <section className="settings-workspace" aria-labelledby="settings-title">
    <div className="workspace-heading">
      <div><span className="eyebrow">{t('settings.yourAccount')}</span><h1 id="settings-title">{t('settings.title')}</h1></div>
      <UserRound size={21} />
    </div>
    <div className="account-summary">
      <span className="avatar">{currentUser.username.slice(0, 1).toUpperCase()}</span>
      <div><strong>{currentUser.username}</strong><small>{currentUser.role === 'admin' ? t('shell.administrator') : t('shell.familyMember')}</small></div>
    </div>
    <div className="settings-section-heading"><h2>{t('settings.password.title')}</h2><KeyRound size={17} /></div>
    <form className="password-form" onSubmit={changeOwnPassword}>
      <input aria-label={t('settings.password.current')} placeholder={t('settings.password.current')} type="password" autoComplete="current-password" value={ownPassword.current} onChange={(event) => setOwnPassword({ ...ownPassword, current: event.target.value })} />
      <input aria-label={t('settings.password.new')} placeholder={t('settings.password.new')} type="password" autoComplete="new-password" minLength={12} maxLength={256} value={ownPassword.next} onChange={(event) => setOwnPassword({ ...ownPassword, next: event.target.value })} />
      <input aria-label={t('settings.password.confirm')} placeholder={t('settings.password.confirm')} type="password" autoComplete="new-password" minLength={12} maxLength={256} value={ownPassword.confirm} onChange={(event) => setOwnPassword({ ...ownPassword, confirm: event.target.value })} />
      <button className="button button-secondary" disabled={ownPasswordBusy}>{t('settings.password.save')}</button>
    </form>
    {ownPasswordMessage && <p className="inline-state" role={ownPasswordMessage.ok ? 'status' : 'alert'}>{ownPasswordMessage.text}</p>}
    {currentUser.role === 'admin' && <>
      <div className="settings-section-heading"><h2>{t('settings.familyAccounts')}</h2><span><ShieldCheck size={15} /> {t('settings.adminAccess')}</span></div>
      {message && <p className="inline-state" role="alert">{message}</p>}
      {notice && <p className="inline-state" role="status">{notice}</p>}
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
      <div className="user-list">
        {visibleUsers.map((user) => {
          const self = user.id === currentUser.id;
          const transferTargets = importTargets.filter((item) => item.id !== user.id);
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
              <button className="button button-secondary" disabled={busy || (maintenanceBusy && deleteAction === 'transfer')} onClick={() => void remove(user, deleteAction === 'transfer' ? transferTarget : undefined)}><Trash2 size={15} /> {t('settings.deleteConfirm')}</button>
              <button className="text-button" type="button" onClick={() => setPanel(null)}>{t('common.cancel')}</button>
            </div>}
          </div>;
        })}
      </div>

      {otherTask && <p className="inline-state" role="status">{t('settings.maintenance.busy', { task: t(`settings.maintenance.task.${otherTask.kind}`) })}</p>}
      <div className="settings-section-heading scan-heading"><h2>{t('settings.import.title')}</h2><FolderInput size={17} /></div>
      <label className="import-organize-option">
        <input type="checkbox" checked={organizeByDate} onChange={(event) => setOrganizeByDate(event.target.checked)} disabled={maintenanceBusy} aria-describedby="import-organize-help" />
        <span>{t('settings.import.organizeByDate')}</span>
      </label>
      <p id="import-organize-help" className="inline-state">{t('settings.import.organizeHelp')}</p>
      <form className="new-user-form" onSubmit={startImport}>
        <input aria-label={t('settings.import.source')} placeholder="." value={importSource} onChange={(event) => setImportSource(event.target.value)} disabled={maintenanceBusy} />
        <UserPicker
          users={importTargets}
          value={importTargetID}
          label={t('settings.import.targetUser')}
          disabled={maintenanceBusy}
          onChange={setImportUserID}
        />
        <button className="button button-secondary" disabled={maintenanceBusy || !importTargetID}>{importActive ? t('settings.import.running') : t('settings.import.start')}</button>
      </form>
      <p className="inline-state">{t('settings.import.sourceHelp')}</p>
      <p className="inline-state">{t('settings.import.warning')}</p>
      {importMessage && <p className="inline-state" role="alert">{importMessage}</p>}
      {importJob && <div className="scan-progress" role="status" aria-live="polite">
        <div className="scan-progress-heading"><span>{importStatusLabel}</span><span>{formatCount(importJob.counts.scanned)}</span></div>
        <div className={`progress-track scan-progress-track ${importActive ? 'is-active' : ''}`} role="progressbar" aria-label={importStatusLabel} aria-valuemin={0} aria-valuemax={100} {...(importJob.status === 'completed' ? { 'aria-valuenow': 100 } : {})}>
          <span className={importJob.status === 'completed' ? 'is-complete' : ''} />
        </div>
        <div className="scan-progress-counts">
          <span>{t('settings.import.scanned')}: {formatCount(importJob.counts.scanned)}</span>
          <span>{t('settings.import.moved')}: {formatCount(importJob.counts.moved)}</span>
          <span>{t('settings.import.skipped')}: {formatCount(importJob.counts.skipped)}</span>
          <span>{t('settings.import.errors')}: {formatCount(importJob.counts.failed)}</span>
        </div>
      </div>}

      <div className="settings-section-heading scan-heading">
        <h2>{t('settings.libraryIndex')}</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button className="button button-secondary" disabled={maintenanceBusy} onClick={() => void rescan()}><RefreshCw size={15} /> {t('settings.rescanFiles')}</button>
          <button className="button button-secondary" disabled={maintenanceBusy} onClick={() => void resetLibraryIndex()}><Trash2 size={15} /> {t('settings.reset.action')}</button>
        </div>
      </div>
      <p className="inline-state">{t('settings.reset.help')}</p>
      {scanMessage && <p className="inline-state" role="alert">{scanMessage}</p>}
      {scanJob && counts && <div className="scan-progress" role="status" aria-live="polite">
        <div className="scan-progress-heading"><span>{scanStatusLabel}</span><span>{scanJob.total !== undefined && scanJob.phase !== 'discovering' && scanJob.phase !== 'resetting' ? `${formatCount(scanJob.processed ?? 0)} / ${formatCount(scanJob.total)}` : formatCount(counts.scanned)}</span></div>
        <div className={`progress-track scan-progress-track ${scanActive && scanPercent === undefined ? 'is-active' : ''}`} role="progressbar" aria-label={scanStatusLabel} aria-valuemin={0} aria-valuemax={100} {...(scanPercent !== undefined ? { 'aria-valuenow': scanPercent } : {})}>
          <span style={scanPercent !== undefined ? { width: `${scanPercent}%` } : undefined} className={scanJob.status === 'completed' ? 'is-complete' : ''} />
        </div>
        <div className="scan-progress-counts">
          <span>{t('settings.scanScanned', { count: formatCount(counts.scanned) })}</span>
          <span>{t('settings.scanAdded', { count: formatCount(counts.added) })}</span>
          <span>{t('settings.scanUpdated', { count: formatCount(counts.updated) })}</span>
          <span>{t('settings.scanMissing', { count: formatCount(counts.missing) })}</span>
          <span>{t('settings.scanErrors', { count: formatCount(counts.failed) })}</span>
        </div>
      </div>}

      <div className="settings-section-heading scan-heading">
        <h2>{t('settings.thumbnail.title')}</h2>
        <div className="thumbnail-actions">
          <div className="thumbnail-mode-toggle" role="group" aria-label={t('settings.thumbnail.modeLabel')}>
            <button
              type="button"
              className={`thumbnail-mode-button ${thumbnailMode === 'incremental' ? 'is-selected' : ''}`}
              aria-pressed={thumbnailMode === 'incremental'}
              disabled={maintenanceBusy}
              onClick={() => setThumbnailMode('incremental')}
            >{t('settings.thumbnail.incremental')}</button>
            <button
              type="button"
              className={`thumbnail-mode-button ${thumbnailMode === 'full' ? 'is-selected' : ''}`}
              aria-pressed={thumbnailMode === 'full'}
              disabled={maintenanceBusy}
              onClick={() => setThumbnailMode('full')}
            >{t('settings.thumbnail.full')}</button>
          </div>
          <button className="button button-secondary" disabled={maintenanceBusy} onClick={() => void rebuildThumbnails()}><ImageIcon size={15} /> {thumbnailActive ? t('settings.thumbnail.running') : t('settings.thumbnail.rebuild')}</button>
        </div>
      </div>
      <p className="inline-state">{thumbnailMode === 'incremental' ? t('settings.thumbnail.incrementalHelp') : t('settings.thumbnail.fullHelp')}</p>
      <p className="inline-state">{t('settings.thumbnail.warning')}</p>
      {thumbnailMessage && <p className="inline-state" role="alert">{thumbnailMessage}</p>}
      {thumbnailJob && thumbnailCounts && <div className="scan-progress" role="status" aria-live="polite">
        <div className="scan-progress-heading"><span>{thumbnailStatusLabel}</span><span>{thumbnailPercent}%</span></div>
        <div className={`progress-track scan-progress-track ${thumbnailActive ? 'is-active' : ''}`} role="progressbar" aria-label={thumbnailStatusLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={thumbnailPercent}>
          <span className={thumbnailJob.status === 'completed' ? 'is-complete' : ''} style={{ width: `${thumbnailPercent}%` }} />
        </div>
        <div className="scan-progress-counts">
          <span>{t('settings.thumbnail.total')}: {formatCount(thumbnailCounts.total)}</span>
          <span>{t('settings.thumbnail.processed')}: {formatCount(thumbnailCounts.processed)}</span>
          <span>{t('settings.thumbnail.regenerated')}: {formatCount(thumbnailCounts.regenerated)}</span>
          <span>{t('settings.import.errors')}: {formatCount(thumbnailCounts.failed)}</span>
        </div>
      </div>}

      <div className="settings-section-heading scan-heading">
        <h2>{t('settings.cleanup.title')}</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button className="button button-secondary" disabled={maintenanceBusy} onClick={() => void scanBrokenPhotos()}><RefreshCw size={15} /> {cleanupAction === 'scan' ? t('settings.cleanup.scanning') : t('settings.cleanup.scan')}</button>
          {cleanupScan && cleanupScan.broken > 0 && <button className="button button-secondary" disabled={maintenanceBusy} onClick={() => void cleanupBrokenPhotos()}><Trash2 size={15} /> {cleanupAction === 'clean' ? t('settings.cleanup.cleaning') : t('settings.cleanup.clean', { count: formatCount(cleanupScan.broken) })}</button>}
        </div>
      </div>
      <p className="inline-state">{t('settings.cleanup.warning')}</p>
      {cleanupMessage && <p className="inline-state" role="status">{cleanupMessage}</p>}
      {cleanupScan && cleanupScan.broken > 0 && <div className="scan-progress" aria-live="polite">
        <div className="scan-progress-counts">
          <span>{t('settings.import.scanned')}: {formatCount(cleanupScan.scanned)}</span>
          <span>{t('settings.cleanup.title')}: {formatCount(cleanupScan.broken)}</span>
        </div>
        <div className="scan-progress-counts">
          {cleanupScan.items.slice(0, 8).map((item) => <span key={item.id}>{item.filename} · {item.reason === 'missing' ? t('settings.cleanup.missingReason') : t('settings.cleanup.emptyReason')}</span>)}
          {cleanupScan.items.length > 8 && <span>+{formatCount(cleanupScan.items.length - 8)}</span>}
        </div>
      </div>}
    </>}
  </section>;
}
