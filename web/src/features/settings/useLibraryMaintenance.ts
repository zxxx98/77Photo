import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useI18n } from '../../app/I18nProvider';
import { ApiError, type ApiClient, type BrokenPhotoScanResult, type ImportJob, type MaintenanceActivity, type MaintenanceKind, type RescanJob, type ThumbnailRebuildJob, type ThumbnailRebuildMode, type User } from '../../app/api';

function isConflict(error: unknown) {
  return error instanceof ApiError && error.status === 409;
}

/**
 * State, polling and actions for the library maintenance tools. The server
 * admits one maintenance task at a time, so `busy` locks every action while
 * any of them (or a task started elsewhere) is running.
 */
export function useLibraryMaintenance(api: ApiClient, enabled: boolean, users: User[], defaultImportUserID: string) {
  const { t, formatCount } = useI18n();
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [scanJob, setScanJob] = useState<RescanJob | null>(null);
  const [scanStarting, setScanStarting] = useState(false);
  const [thumbnailMessage, setThumbnailMessage] = useState<string | null>(null);
  const [thumbnailJob, setThumbnailJob] = useState<ThumbnailRebuildJob | null>(null);
  const [thumbnailStarting, setThumbnailStarting] = useState(false);
  const [thumbnailMode, setThumbnailMode] = useState<ThumbnailRebuildMode>('incremental');
  const [importSource, setImportSource] = useState('.');
  const [organizeByDate, setOrganizeByDate] = useState(false);
  const [importUserID, setImportUserID] = useState(defaultImportUserID);
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
  const currentTask: MaintenanceKind | null = scanActive ? 'rescan'
    : thumbnailActive ? 'thumbnail_rebuild'
      : importActive ? 'import'
        : cleanupAction ? 'cleanup'
          : otherTask?.kind ?? null;
  const busy = currentTask !== null;
  const importTargets = users.filter((user) => !user.deleted_at && user.is_active);
  const importTargetID = importTargets.some((user) => user.id === importUserID) ? importUserID : importTargets[0]?.id ?? '';

  // Re-attach to a maintenance task that is already running (for example after
  // a page reload) so its progress is shown and conflicting actions stay locked.
  const sync = useCallback(async () => {
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
    if (enabled) void sync();
  }, [enabled, sync]);

  useEffect(() => {
    if (!otherTask) return;
    const timer = window.setTimeout(() => void sync(), 2000);
    return () => window.clearTimeout(timer);
  }, [otherTask, sync]);

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

  async function rescan() {
    if (busy) return;
    setScanStarting(true);
    setScanMessage(null);
    try {
      setScanJob(await api.startRescan());
    } catch (error) {
      setScanJob(null);
      if (isConflict(error)) void sync();
      else setScanMessage(t('settings.scanFailed'));
    } finally {
      setScanStarting(false);
    }
  }

  async function resetLibraryIndex() {
    if (busy) return;
    if (!window.confirm(t('settings.reset.confirm'))) return;
    setScanStarting(true);
    setScanMessage(null);
    setCleanupScan(null);
    try {
      setScanJob(await api.resetLibraryIndex());
    } catch (error) {
      setScanJob(null);
      if (isConflict(error)) void sync();
      else setScanMessage(t('settings.reset.failed'));
    } finally {
      setScanStarting(false);
    }
  }

  async function rebuildThumbnails() {
    if (busy) return;
    if (thumbnailMode === 'full' && !window.confirm(t('settings.thumbnail.confirm'))) return;
    setThumbnailStarting(true);
    setThumbnailMessage(null);
    try {
      setThumbnailJob(await api.startThumbnailRebuild(thumbnailMode));
    } catch (error) {
      setThumbnailJob(null);
      if (isConflict(error)) void sync();
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
    if (busy) return;
    setCleanupAction('scan');
    setCleanupMessage(null);
    try {
      const result = await api.scanBrokenPhotos();
      setCleanupScan(result);
      setCleanupMessage(describeScan(result));
    } catch (error) {
      setCleanupScan(null);
      if (isConflict(error)) void sync();
      else setCleanupMessage(t('settings.cleanup.scanFailed'));
    } finally {
      setCleanupAction(null);
    }
  }

  async function cleanupBrokenPhotos() {
    if (busy || !cleanupScan?.broken || !window.confirm(t('settings.cleanup.confirm', { count: formatCount(cleanupScan.broken) }))) return;
    setCleanupAction('clean');
    setCleanupMessage(null);
    try {
      // Only the photos the administrator just reviewed are sent; the server
      // re-verifies each one and leaves anything no longer broken untouched.
      const result = await api.cleanupBrokenPhotos(cleanupScan.items.map((item) => item.id));
      setCleanupMessage(result.failed > 0 ? t('settings.cleanup.partial', { deleted: formatCount(result.deleted), failed: formatCount(result.failed) }) : t('settings.cleanup.completed', { count: formatCount(result.deleted) }));
      setCleanupScan(null);
    } catch (error) {
      if (isConflict(error)) void sync();
      else setCleanupMessage(t('settings.cleanup.failed'));
    } finally {
      setCleanupAction(null);
    }
  }

  async function startImport(event: FormEvent) {
    event.preventDefault();
    if (busy || !importTargetID) return;
    setImportStarting(true);
    setImportMessage(null);
    try {
      setImportJob(await api.startImport({ source_path: importSource.trim() || '.', user_id: importTargetID, organize_by_date: organizeByDate }));
    } catch (error) {
      setImportJob(null);
      if (isConflict(error)) void sync();
      else setImportMessage(t('settings.import.startFailed'));
    } finally {
      setImportStarting(false);
    }
  }

  return {
    busy,
    currentTask,
    sync,
    scan: { job: scanJob, message: scanMessage, active: scanActive, start: rescan, reset: resetLibraryIndex },
    thumbnail: { job: thumbnailJob, message: thumbnailMessage, active: thumbnailActive, mode: thumbnailMode, setMode: setThumbnailMode, start: rebuildThumbnails },
    importer: {
      job: importJob, message: importMessage, active: importActive,
      source: importSource, setSource: setImportSource,
      organizeByDate, setOrganizeByDate,
      targets: importTargets, targetID: importTargetID, setTargetID: setImportUserID,
      start: startImport,
    },
    cleanup: { result: cleanupScan, action: cleanupAction, message: cleanupMessage, scan: scanBrokenPhotos, clean: cleanupBrokenPhotos },
  };
}

export type LibraryMaintenance = ReturnType<typeof useLibraryMaintenance>;
