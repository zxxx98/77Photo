import { FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, FolderInput, ImageIcon, RefreshCw, ShieldCheck, Trash2, UserRound } from 'lucide-react';
import { useI18n } from '../../app/I18nProvider';
import type { ApiClient, BrokenPhotoScanResult, ImportJob, RescanJob, ThumbnailRebuildJob, ThumbnailRebuildMode, User } from '../../app/api';

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
  const { locale, t, formatCount } = useI18n();
  const [users, setUsers] = useState<User[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [scanJob, setScanJob] = useState<RescanJob | null>(null);
  const [scanStarting, setScanStarting] = useState(false);
  const [thumbnailMessage, setThumbnailMessage] = useState<string | null>(null);
  const [thumbnailJob, setThumbnailJob] = useState<ThumbnailRebuildJob | null>(null);
  const [thumbnailStarting, setThumbnailStarting] = useState(false);
  const [thumbnailMode, setThumbnailMode] = useState<ThumbnailRebuildMode>('incremental');
  const [importSource, setImportSource] = useState('.');
  const [importUserID, setImportUserID] = useState(currentUser.id);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importJob, setImportJob] = useState<ImportJob | null>(null);
  const [importStarting, setImportStarting] = useState(false);
  const [cleanupScan, setCleanupScan] = useState<BrokenPhotoScanResult | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupMessage, setCleanupMessage] = useState<string | null>(null);
  const scanActive = scanStarting || scanJob?.status === 'queued' || scanJob?.status === 'running';
  const thumbnailActive = thumbnailStarting || thumbnailJob?.status === 'queued' || thumbnailJob?.status === 'running';
  const importActive = importStarting || importJob?.status === 'queued' || importJob?.status === 'running';
  const copy = locale === 'zh' ? {
    importTitle: '迁移照片',
    importSource: '导入目录',
    importSourceHelp: '填写原图根目录下的相对路径。填写 . 会导入根目录中除 users、shared、隐藏目录之外的文件。',
    targetUser: '目标用户',
    startImport: '开始导入',
    importing: '正在导入…',
    queued: '导入已排队…',
    complete: '导入完成',
    failed: '导入失败',
    startFailed: '无法启动导入，请检查目录和目标用户。',
    pollFailed: '无法读取导入进度，正在重试…',
    scanned: '已发现',
    moved: '已移动',
    skipped: '已跳过',
    errors: '失败',
    importWarning: '导入会把文件移动到目标用户的 Imported 文件夹，并保留原有子目录结构；已有同名目标文件不会被覆盖。',
    thumbnailTitle: '缩略图缓存',
    rebuildThumbnails: '重新生成缩略图',
    rebuildingThumbnails: '正在重新生成…',
    thumbnailModeLabel: '重建方式',
    thumbnailIncremental: '增量',
    thumbnailFull: '全量',
    thumbnailIncrementalHelp: '仅处理缺失缩略图的照片，已有完整缓存会直接跳过。',
    thumbnailFullHelp: '删除已有缩略图缓存，并为全部支持的照片和视频重新生成三档缩略图。',
    thumbnailQueued: '缩略图重建已排队…',
    thumbnailComplete: '缩略图重建完成',
    thumbnailFailed: '缩略图重建失败',
    thumbnailStartFailed: '无法启动缩略图重建。',
    thumbnailPollFailed: '无法读取缩略图重建进度，正在重试…',
    thumbnailWarning: '原图不会被修改。增量模式适合日常补齐缓存；全量模式适合缩略图规则变更或缓存异常后的彻底重建。',
    thumbnailConfirm: '重新生成全部缩略图可能需要较长时间，确定继续吗？',
    thumbnailTotal: '总数',
    thumbnailProcessed: '已处理',
    thumbnailRegenerated: '已生成',
    cleanupTitle: '坏照片清理',
    scanBroken: '扫描坏照片',
    scanningBroken: '正在扫描…',
    cleanupBroken: (count: number) => `清理 ${formatCount(count)} 张`,
    cleaningBroken: '正在清理…',
    cleanupWarning: '只会清理原文件已丢失或 0 字节的明确坏照片。缩略图生成失败不会被删除；清理前会先显示扫描结果。',
    cleanupNone: '未发现可安全清理的坏照片。',
    cleanupFound: (count: number) => `发现 ${formatCount(count)} 张可安全清理的坏照片。`,
    cleanupComplete: (count: number) => `已清理 ${formatCount(count)} 张坏照片。`,
    cleanupPartial: (deleted: number, failed: number) => `已清理 ${formatCount(deleted)} 张，另有 ${formatCount(failed)} 张清理失败。`,
    cleanupScanFailed: '无法扫描坏照片，请检查存储状态后重试。',
    cleanupFailed: '清理坏照片失败，请重试。',
    cleanupConfirm: (count: number) => `将永久删除 ${formatCount(count)} 张已确认损坏的照片及关联缓存，此操作无法撤销。确定继续吗？`,
    missingReason: '原文件丢失',
    emptyReason: '0 字节文件',
  } : {
    importTitle: 'Import photos',
    importSource: 'Import directory',
    importSourceHelp: 'Enter a path relative to the photo root. Use . to import root files except users, shared and hidden directories.',
    targetUser: 'Target user',
    startImport: 'Start import',
    importing: 'Importing…',
    queued: 'Import queued…',
    complete: 'Import complete',
    failed: 'Import failed',
    startFailed: 'Unable to start import. Check the directory and target user.',
    pollFailed: 'Unable to read import progress. Retrying…',
    scanned: 'Discovered',
    moved: 'Moved',
    skipped: 'Skipped',
    errors: 'Failed',
    importWarning: 'Import moves files into the target user’s Imported folder while preserving subfolders. Existing destination files are never overwritten.',
    thumbnailTitle: 'Thumbnail cache',
    rebuildThumbnails: 'Regenerate thumbnails',
    rebuildingThumbnails: 'Regenerating…',
    thumbnailModeLabel: 'Rebuild mode',
    thumbnailIncremental: 'Incremental',
    thumbnailFull: 'Full',
    thumbnailIncrementalHelp: 'Only repairs photos with missing thumbnail variants. Complete caches are skipped.',
    thumbnailFullHelp: 'Deletes existing thumbnail caches and rebuilds all three sizes for every supported photo and video.',
    thumbnailQueued: 'Thumbnail rebuild queued…',
    thumbnailComplete: 'Thumbnail rebuild complete',
    thumbnailFailed: 'Thumbnail rebuild failed',
    thumbnailStartFailed: 'Unable to start the thumbnail rebuild.',
    thumbnailPollFailed: 'Unable to read thumbnail rebuild progress. Retrying…',
    thumbnailWarning: 'Original media is never modified. Use incremental mode for routine cache repair and full mode after thumbnail rule changes or cache corruption.',
    thumbnailConfirm: 'Regenerating every thumbnail can take a while. Continue?',
    thumbnailTotal: 'Total',
    thumbnailProcessed: 'Processed',
    thumbnailRegenerated: 'Regenerated',
    cleanupTitle: 'Broken photo cleanup',
    scanBroken: 'Scan broken photos',
    scanningBroken: 'Scanning…',
    cleanupBroken: (count: number) => `Clean ${formatCount(count)}`,
    cleaningBroken: 'Cleaning…',
    cleanupWarning: 'Only clearly broken originals that are missing or zero bytes are removed. Thumbnail failures are never treated as broken photos. Results are shown before deletion.',
    cleanupNone: 'No safely removable broken photos were found.',
    cleanupFound: (count: number) => `Found ${formatCount(count)} safely removable broken photos.`,
    cleanupComplete: (count: number) => `Cleaned ${formatCount(count)} broken photos.`,
    cleanupPartial: (deleted: number, failed: number) => `Cleaned ${formatCount(deleted)} photos; ${formatCount(failed)} could not be removed.`,
    cleanupScanFailed: 'Unable to scan for broken photos. Check storage health and try again.',
    cleanupFailed: 'Unable to clean broken photos. Try again.',
    cleanupConfirm: (count: number) => `Permanently delete ${formatCount(count)} confirmed broken photos and related cache files? This cannot be undone.`,
    missingReason: 'Original file missing',
    emptyReason: 'Zero-byte file',
  };

  useEffect(() => {
    if (currentUser.role !== 'admin') return;
    void api.listUsers().then((response) => {
      setUsers(response.items);
      if (!response.items.some((user) => user.id === importUserID)) setImportUserID(response.items[0]?.id ?? currentUser.id);
    }).catch(() => setMessage(t('settings.onlyAdmins')));
  }, [api, currentUser.id, currentUser.role, importUserID, t]);

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
        setThumbnailMessage(copy.thumbnailPollFailed);
        timer = window.setTimeout(() => void poll(), 1000);
      }
    }

    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [api, thumbnailJob?.id, copy.thumbnailPollFailed]);

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
        setImportMessage(copy.pollFailed);
        timer = window.setTimeout(() => void poll(), 1000);
      }
    }

    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [api, importJob?.id, copy.pollFailed]);

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

  async function rebuildThumbnails() {
    if (thumbnailActive) return;
    if (thumbnailMode === 'full' && !window.confirm(copy.thumbnailConfirm)) return;
    setThumbnailStarting(true);
    setThumbnailMessage(null);
    try {
      setThumbnailJob(await api.startThumbnailRebuild(thumbnailMode));
    } catch {
      setThumbnailJob(null);
      setThumbnailMessage(copy.thumbnailStartFailed);
    } finally {
      setThumbnailStarting(false);
    }
  }

  async function scanBrokenPhotos() {
    if (cleanupBusy) return;
    setCleanupBusy(true);
    setCleanupMessage(null);
    try {
      const result = await api.scanBrokenPhotos();
      setCleanupScan(result);
      setCleanupMessage(result.broken === 0 ? copy.cleanupNone : copy.cleanupFound(result.broken));
    } catch {
      setCleanupScan(null);
      setCleanupMessage(copy.cleanupScanFailed);
    } finally {
      setCleanupBusy(false);
    }
  }

  async function cleanupBrokenPhotos() {
    if (cleanupBusy || !cleanupScan?.broken || !window.confirm(copy.cleanupConfirm(cleanupScan.broken))) return;
    setCleanupBusy(true);
    setCleanupMessage(null);
    try {
      const result = await api.cleanupBrokenPhotos();
      setCleanupMessage(result.failed > 0 ? copy.cleanupPartial(result.deleted, result.failed) : copy.cleanupComplete(result.deleted));
      setCleanupScan(await api.scanBrokenPhotos());
    } catch {
      setCleanupMessage(copy.cleanupFailed);
    } finally {
      setCleanupBusy(false);
    }
  }

  async function startImport(event: FormEvent) {
    event.preventDefault();
    if (importActive || !importUserID) return;
    setImportStarting(true);
    setImportMessage(null);
    try {
      setImportJob(await api.startImport({ source_path: importSource.trim() || '.', user_id: importUserID }));
    } catch {
      setImportJob(null);
      setImportMessage(copy.startFailed);
    } finally {
      setImportStarting(false);
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
  const thumbnailStatusLabel = thumbnailJob?.status === 'running'
    ? copy.rebuildingThumbnails
    : thumbnailJob?.status === 'completed'
      ? copy.thumbnailComplete
      : thumbnailJob?.status === 'failed'
        ? copy.thumbnailFailed
        : copy.thumbnailQueued;
  const thumbnailCounts = thumbnailJob?.counts;
  const thumbnailPercent = thumbnailCounts && thumbnailCounts.total > 0
    ? Math.min(100, Math.round((thumbnailCounts.processed / thumbnailCounts.total) * 100))
    : thumbnailJob?.status === 'completed' ? 100 : 0;
  const importStatusLabel = importJob?.status === 'running'
    ? copy.importing
    : importJob?.status === 'completed'
      ? copy.complete
      : importJob?.status === 'failed'
        ? copy.failed
        : copy.queued;

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

      <div className="settings-section-heading scan-heading"><h2>{copy.importTitle}</h2><FolderInput size={17} /></div>
      <form className="new-user-form" onSubmit={startImport}>
        <input aria-label={copy.importSource} placeholder="." value={importSource} onChange={(event) => setImportSource(event.target.value)} disabled={importActive} />
        <UserPicker
          users={users.filter((user) => user.is_active)}
          value={importUserID}
          label={copy.targetUser}
          disabled={importActive}
          onChange={setImportUserID}
        />
        <button className="button button-secondary" disabled={importActive || !importUserID}>{importActive ? copy.importing : copy.startImport}</button>
      </form>
      <p className="inline-state">{copy.importSourceHelp}</p>
      <p className="inline-state">{copy.importWarning}</p>
      {importMessage && <p className="inline-state" role="alert">{importMessage}</p>}
      {importJob && <div className="scan-progress" role="status" aria-live="polite">
        <div className="scan-progress-heading"><span>{importStatusLabel}</span><span>{formatCount(importJob.counts.scanned)}</span></div>
        <div className={`progress-track scan-progress-track ${importActive ? 'is-active' : ''}`} role="progressbar" aria-label={importStatusLabel} aria-valuemin={0} aria-valuemax={100} {...(importJob.status === 'completed' ? { 'aria-valuenow': 100 } : {})}>
          <span className={importJob.status === 'completed' ? 'is-complete' : ''} />
        </div>
        <div className="scan-progress-counts">
          <span>{copy.scanned}: {formatCount(importJob.counts.scanned)}</span>
          <span>{copy.moved}: {formatCount(importJob.counts.moved)}</span>
          <span>{copy.skipped}: {formatCount(importJob.counts.skipped)}</span>
          <span>{copy.errors}: {formatCount(importJob.counts.failed)}</span>
        </div>
      </div>}

      <div className="settings-section-heading scan-heading">
        <h2>{t('settings.libraryIndex')}</h2>
        <button className="button button-secondary" disabled={scanActive} onClick={() => void rescan()}><RefreshCw size={15} /> {t('settings.rescanFiles')}</button>
      </div>
      {scanMessage && <p className="inline-state" role="alert">{scanMessage}</p>}
      {scanJob && counts && <div className="scan-progress" role="status" aria-live="polite">
        <div className="scan-progress-heading"><span>{scanStatusLabel}</span><span>{formatCount(counts.scanned)}</span></div>
        <div className={`progress-track scan-progress-track ${scanActive ? 'is-active' : ''}`} role="progressbar" aria-label={scanStatusLabel} aria-valuemin={0} aria-valuemax={100} {...(scanJob.status === 'completed' ? { 'aria-valuenow': 100 } : {})}>
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

      <div className="settings-section-heading scan-heading">
        <h2>{copy.thumbnailTitle}</h2>
        <div className="thumbnail-actions">
          <div className="thumbnail-mode-toggle" role="group" aria-label={copy.thumbnailModeLabel}>
            <button
              type="button"
              className={`thumbnail-mode-button ${thumbnailMode === 'incremental' ? 'is-selected' : ''}`}
              aria-pressed={thumbnailMode === 'incremental'}
              disabled={thumbnailActive}
              onClick={() => setThumbnailMode('incremental')}
            >{copy.thumbnailIncremental}</button>
            <button
              type="button"
              className={`thumbnail-mode-button ${thumbnailMode === 'full' ? 'is-selected' : ''}`}
              aria-pressed={thumbnailMode === 'full'}
              disabled={thumbnailActive}
              onClick={() => setThumbnailMode('full')}
            >{copy.thumbnailFull}</button>
          </div>
          <button className="button button-secondary" disabled={thumbnailActive} onClick={() => void rebuildThumbnails()}><ImageIcon size={15} /> {thumbnailActive ? copy.rebuildingThumbnails : copy.rebuildThumbnails}</button>
        </div>
      </div>
      <p className="inline-state">{thumbnailMode === 'incremental' ? copy.thumbnailIncrementalHelp : copy.thumbnailFullHelp}</p>
      <p className="inline-state">{copy.thumbnailWarning}</p>
      {thumbnailMessage && <p className="inline-state" role="alert">{thumbnailMessage}</p>}
      {thumbnailJob && thumbnailCounts && <div className="scan-progress" role="status" aria-live="polite">
        <div className="scan-progress-heading"><span>{thumbnailStatusLabel}</span><span>{thumbnailPercent}%</span></div>
        <div className={`progress-track scan-progress-track ${thumbnailActive ? 'is-active' : ''}`} role="progressbar" aria-label={thumbnailStatusLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={thumbnailPercent}>
          <span className={thumbnailJob.status === 'completed' ? 'is-complete' : ''} style={{ width: `${thumbnailPercent}%` }} />
        </div>
        <div className="scan-progress-counts">
          <span>{copy.thumbnailTotal}: {formatCount(thumbnailCounts.total)}</span>
          <span>{copy.thumbnailProcessed}: {formatCount(thumbnailCounts.processed)}</span>
          <span>{copy.thumbnailRegenerated}: {formatCount(thumbnailCounts.regenerated)}</span>
          <span>{copy.errors}: {formatCount(thumbnailCounts.failed)}</span>
        </div>
      </div>}

      <div className="settings-section-heading scan-heading">
        <h2>{copy.cleanupTitle}</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button className="button button-secondary" disabled={cleanupBusy} onClick={() => void scanBrokenPhotos()}><RefreshCw size={15} /> {cleanupBusy ? copy.scanningBroken : copy.scanBroken}</button>
          {cleanupScan && cleanupScan.broken > 0 && <button className="button button-secondary" disabled={cleanupBusy} onClick={() => void cleanupBrokenPhotos()}><Trash2 size={15} /> {cleanupBusy ? copy.cleaningBroken : copy.cleanupBroken(cleanupScan.broken)}</button>}
        </div>
      </div>
      <p className="inline-state">{copy.cleanupWarning}</p>
      {cleanupMessage && <p className="inline-state" role="status">{cleanupMessage}</p>}
      {cleanupScan && cleanupScan.broken > 0 && <div className="scan-progress" aria-live="polite">
        <div className="scan-progress-counts">
          <span>{copy.scanned}: {formatCount(cleanupScan.scanned)}</span>
          <span>{copy.cleanupTitle}: {formatCount(cleanupScan.broken)}</span>
        </div>
        <div className="scan-progress-counts">
          {cleanupScan.items.slice(0, 8).map((item) => <span key={item.id}>{item.filename} · {item.reason === 'missing' ? copy.missingReason : copy.emptyReason}</span>)}
          {cleanupScan.items.length > 8 && <span>+{formatCount(cleanupScan.items.length - 8)}</span>}
        </div>
      </div>}
    </>}
  </section>;
}
