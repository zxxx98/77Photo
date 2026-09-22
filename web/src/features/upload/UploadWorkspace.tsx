import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Check, CirclePlay, FileImage, UploadCloud, X } from 'lucide-react';
import { useI18n } from '../../app/I18nProvider';
import type { ApiClient, Folder, UploadProgress } from '../../app/api';
import { queuedItemsFromFiles, type UploadDestination, type UploadSelection } from './uploadSelection';

type UploadItem = {
  file: File;
  liveVideo?: File;
  photoId?: string;
  status: 'queued' | 'uploading' | 'done' | 'failed' | 'cancelled';
  progress: number;
  message?: string;
};

type Props = {
  api: ApiClient;
  selection?: UploadSelection | null;
  onSelectionConsumed?: (id: number) => void;
  onUploadComplete?: (destination: UploadDestination) => void;
};

export default function UploadWorkspace({ api, selection, onSelectionConsumed, onUploadComplete }: Props) {
  const { t, formatCount } = useI18n();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderId, setFolderId] = useState('');
  const [preferredDestination, setPreferredDestination] = useState<UploadDestination | null>(null);
  const [returnDestination, setReturnDestination] = useState<UploadDestination | null>(null);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [running, setRunning] = useState(false);
  const controllers = useMemo(() => new Map<number, AbortController>(), []);
  const consumedSelectionRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const completionReportedRef = useRef(false);
  const selectionPending = Boolean(selection && selection.id !== consumedSelectionRef.current);

  useEffect(() => {
    let active = true;
    void api.listFolders().then((response) => {
      if (!active) return;
      setFolders(response.items);
      setFolderId((current) => current || response.items[0]?.id || '');
    }).catch(() => undefined);
    return () => { active = false; };
  }, [api]);

  useEffect(() => {
    if (!selection || selection.id === consumedSelectionRef.current) return;
    consumedSelectionRef.current = selection.id;
    if (selection.destination) {
      setPreferredDestination(selection.destination);
      setFolderId(selection.destination.id);
      setReturnDestination(selection.returnToFolder ? selection.destination : null);
    } else {
      setPreferredDestination(null);
      setReturnDestination(null);
    }
    setItems((current) => [...current, ...queuedItemsFromFiles(selection.files)]);
    onSelectionConsumed?.(selection.id);
  }, [onSelectionConsumed, selection]);

  const completed = useMemo(() => items.filter((item) => item.status === 'done').length, [items]);
  const folderOptions = useMemo<Array<Pick<Folder, 'id' | 'name'>>>(() => {
    if (!preferredDestination || folders.some((folder) => folder.id === preferredDestination.id)) return folders;
    return [preferredDestination, ...folders];
  }, [folders, preferredDestination]);

  function selectFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;
    setItems((current) => [...current, ...queuedItemsFromFiles(files)]);
  }

  function update(index: number, patch: Partial<UploadItem>) {
    setItems((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  }

  function changeDestination(nextFolderID: string) {
    setFolderId(nextFolderID);
    if (!returnDestination) return;
    const next = folderOptions.find((folder) => folder.id === nextFolderID);
    setReturnDestination(next ? { id: next.id, name: next.name } : null);
  }

  async function start() {
    if (!folderId || runningRef.current) return;
    runningRef.current = true;
    completionReportedRef.current = false;
    setRunning(true);
    const queue = items.map((item, index) => ({ item, index })).filter(({ item }) => item.status === 'queued');
    let cursor = 0;

    async function worker() {
      while (cursor < queue.length) {
        const job = queue[cursor++];
        if (!job) return;
        const controller = new AbortController();
        controllers.set(job.index, controller);
        update(job.index, { status: 'uploading', progress: 0, message: undefined });
        try {
          let photoId = job.item.photoId;
          if (!photoId) {
            const photo = job.item.liveVideo
              ? await api.uploadLivePhoto(job.item.file, job.item.liveVideo, folderId, (progress: UploadProgress) => update(job.index, { progress: progress.total ? Math.round(progress.loaded / progress.total * 100) : 0 }), controller.signal)
              : await api.uploadPhoto(job.item.file, folderId, (progress: UploadProgress) => update(job.index, { progress: progress.total ? Math.round(progress.loaded / progress.total * 100) : 0 }), controller.signal);
            photoId = photo.id;
            update(job.index, { photoId, progress: 100 });
          }
          update(job.index, { status: 'done', progress: 100 });
        } catch (error) {
          const cancelled = error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ABORTED';
          update(job.index, {
            status: cancelled ? 'cancelled' : 'failed',
            message: cancelled ? undefined : error instanceof Error ? error.message : t('upload.uploadError'),
          });
        } finally {
          controllers.delete(job.index);
        }
      }
    }

    await Promise.all([worker(), worker()]);
    runningRef.current = false;
    setRunning(false);
  }

  useEffect(() => {
    // Wait for an incoming selection to be added before scheduling or reporting completion.
    if (selectionPending || running || !folderId || items.length === 0) return;
    if (items.some((item) => item.status === 'queued')) {
      void start();
    } else if (items.every((item) => item.status === 'done') && returnDestination && !completionReportedRef.current) {
      completionReportedRef.current = true;
      onUploadComplete?.(returnDestination);
    }
  }, [folderId, items, running, selectionPending, returnDestination, onUploadComplete]);

  return <section className="upload-workspace" aria-labelledby="upload-title"><div className="workspace-heading"><div><span className="eyebrow">{t('upload.addToLibrary')}</span><h1 id="upload-title">{t('upload.title')}</h1></div><span className="upload-count">{t('upload.complete', { completed: formatCount(completed), total: formatCount(items.length || 0) })}</span></div><label className="folder-select-label">{t('upload.destination')}<select value={folderId} onChange={(event) => changeDestination(event.target.value)}><option value="">{t('upload.chooseFolder')}</option>{folderOptions.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label><label className="drop-zone"><UploadCloud size={27} /><strong>{t('upload.choosePhotos')}</strong><span>{t('upload.oneRequest')}</span><input type="file" accept="image/jpeg,image/png,image/heic,image/heif,video/mp4,video/webm,video/quicktime,.mov" multiple onChange={selectFiles} /></label>{items.length > 0 && <div className="upload-list">{items.map((item, index) => <div className="upload-row" key={`${item.file.name}-${index}`}><FileImage size={19} /><div className="upload-row-copy"><strong>{item.file.name}{item.liveVideo && <span className="live-upload-mark" title="Live Photo"><CirclePlay size={14} /> LIVE</span>}</strong><small>{item.status === 'failed' ? item.message ?? t('upload.uploadError') : item.status === 'cancelled' ? t('upload.cancelled') : item.status === 'done' ? t('upload.uploaded') : item.status === 'uploading' ? t('upload.progress', { progress: item.progress }) : t('upload.waiting')}</small><div className="progress-track"><span style={{ width: `${item.progress}%` }} /></div></div>{item.status === 'done' ? <Check size={18} className="success-icon" /> : item.status === 'failed' || item.status === 'cancelled' ? <button className="text-button" onClick={() => update(index, { status: 'queued', message: undefined })}>{t('common.retry')}</button> : item.status === 'uploading' ? <button className="icon-button" aria-label={t('upload.cancelFile', { name: item.file.name })} onClick={() => controllers.get(index)?.abort()}><X size={18} /></button> : null}</div>)}</div>}</section>;
}
