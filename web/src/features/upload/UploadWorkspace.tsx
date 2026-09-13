import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Check, FileImage, LoaderCircle, UploadCloud, X } from 'lucide-react';
import { useI18n } from '../../app/I18nProvider';
import type { ApiClient, Folder, UploadProgress } from '../../app/api';
import { queuedItemsFromFiles, shouldAutoStartAfterSelection, type UploadSelection } from './uploadSelection';

type UploadItem = { file: File; status: 'queued' | 'uploading' | 'done' | 'failed' | 'cancelled'; progress: number; message?: string };

export default function UploadWorkspace({ api, selection, onSelectionConsumed }: { api: ApiClient; selection?: UploadSelection | null; onSelectionConsumed?: (id: number) => void }) {
  const { t, formatCount } = useI18n();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderId, setFolderId] = useState('');
  const [items, setItems] = useState<UploadItem[]>([]);
  const [running, setRunning] = useState(false);
  const controllers = useMemo(() => new Map<number, AbortController>(), []);
  const consumedSelectionRef = useRef<number | null>(null);
  const autoStartFilesRef = useRef<File[]>([]);
  useEffect(() => { void api.listFolders().then((response) => { setFolders(response.items); if (!folderId && response.items[0]) setFolderId(response.items[0].id); }).catch(() => undefined); }, [api, folderId]);
  useEffect(() => {
    if (!selection || selection.id === consumedSelectionRef.current) return;
    consumedSelectionRef.current = selection.id;
    setItems((current) => [...current, ...queuedItemsFromFiles(selection.files)]);
    requestAutoStart(selection.files);
    onSelectionConsumed?.(selection.id);
  }, [onSelectionConsumed, selection]);
  const completed = useMemo(() => items.filter((item) => item.status === 'done').length, [items]);

  function selectFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;
    setItems((current) => [...current, ...queuedItemsFromFiles(files)]);
    requestAutoStart(files);
  }
  function update(index: number, patch: Partial<UploadItem>) { setItems((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item)); }
  function requestAutoStart(files: File[]) {
    if (shouldAutoStartAfterSelection(files)) autoStartFilesRef.current.push(...files);
  }
  async function start() {
    if (!folderId || running) return;
    autoStartFilesRef.current = [];
    setRunning(true);
    const queue = items.map((item, index) => ({ item, index })).filter(({ item }) => item.status === 'queued' || item.status === 'failed' || item.status === 'cancelled');
    let cursor = 0;
    async function worker() { while (cursor < queue.length) { const job = queue[cursor++]; if (!job) return; const controller = new AbortController(); controllers.set(job.index, controller); update(job.index, { status: 'uploading', progress: 0, message: undefined }); try { await api.uploadPhoto(job.item.file, folderId, (progress: UploadProgress) => update(job.index, { progress: progress.total ? Math.round(progress.loaded / progress.total * 100) : 0 }), controller.signal); update(job.index, { status: 'done', progress: 100 }); } catch (error) { update(job.index, { status: error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ABORTED' ? 'cancelled' : 'failed', message: t('upload.failed') }); } finally { controllers.delete(job.index); } } }
    await Promise.all([worker(), worker()]);
    setRunning(false);
  }
  useEffect(() => {
    const pendingFiles = autoStartFilesRef.current;
    if (pendingFiles.length === 0 || running || !folderId || items.length === 0) return;
    if (!pendingFiles.every((file) => items.some((item) => item.file === file && item.status === 'queued'))) return;
    autoStartFilesRef.current = [];
    void start();
  }, [folderId, items, running]);

  return <section className="upload-workspace" aria-labelledby="upload-title"><div className="workspace-heading"><div><span className="eyebrow">{t('upload.addToLibrary')}</span><h1 id="upload-title">{t('upload.title')}</h1></div><span className="upload-count">{t('upload.complete', { completed: formatCount(completed), total: formatCount(items.length || 0) })}</span></div><label className="folder-select-label">{t('upload.destination')}<select value={folderId} onChange={(event) => setFolderId(event.target.value)}><option value="">{t('upload.chooseFolder')}</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label><label className="drop-zone"><UploadCloud size={27} /><strong>{t('upload.choosePhotos')}</strong><span>{t('upload.oneRequest')}</span><input type="file" accept="image/jpeg,image/png,video/mp4,video/webm" multiple onChange={selectFiles} /></label>{items.length > 0 && <div className="upload-list">{items.map((item, index) => <div className="upload-row" key={`${item.file.name}-${index}`}><FileImage size={19} /><div className="upload-row-copy"><strong>{item.file.name}</strong><small>{item.status === 'failed' ? t('upload.uploadError') : item.status === 'cancelled' ? t('upload.cancelled') : item.status === 'done' ? t('upload.uploaded') : item.status === 'uploading' ? t('upload.progress', { progress: item.progress }) : t('upload.waiting')}</small><div className="progress-track"><span style={{ width: `${item.progress}%` }} /></div></div>{item.status === 'done' ? <Check size={18} className="success-icon" /> : item.status === 'failed' ? <X size={18} className="error-icon" /> : item.status === 'cancelled' ? <button className="text-button" onClick={() => update(index, { status: 'queued', message: undefined })}>{t('common.retry')}</button> : item.status === 'uploading' ? <button className="icon-button" aria-label={t('upload.cancelFile', { name: item.file.name })} onClick={() => controllers.get(index)?.abort()}><X size={18} /></button> : null}</div>)}</div>}</section>;
}
