import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Check, FileImage, LoaderCircle, UploadCloud, X } from 'lucide-react';
import type { ApiClient, Folder, UploadProgress } from '../../app/api';
import { queuedItemsFromFiles, type UploadSelection } from './uploadSelection';

type UploadItem = { file: File; status: 'queued' | 'uploading' | 'done' | 'failed' | 'cancelled'; progress: number; message?: string };

export default function UploadWorkspace({ api, selection, onSelectionConsumed }: { api: ApiClient; selection?: UploadSelection | null; onSelectionConsumed?: (id: number) => void }) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderId, setFolderId] = useState('');
  const [items, setItems] = useState<UploadItem[]>([]);
  const [running, setRunning] = useState(false);
  const controllers = useMemo(() => new Map<number, AbortController>(), []);
  const consumedSelectionRef = useRef<number | null>(null);
  useEffect(() => { void api.listFolders().then((response) => { setFolders(response.items); if (!folderId && response.items[0]) setFolderId(response.items[0].id); }).catch(() => undefined); }, [api, folderId]);
  useEffect(() => {
    if (!selection || selection.id === consumedSelectionRef.current) return;
    consumedSelectionRef.current = selection.id;
    setItems((current) => [...current, ...queuedItemsFromFiles(selection.files)]);
    onSelectionConsumed?.(selection.id);
  }, [onSelectionConsumed, selection]);
  const completed = useMemo(() => items.filter((item) => item.status === 'done').length, [items]);

  function selectFiles(event: ChangeEvent<HTMLInputElement>) { setItems((current) => [...current, ...queuedItemsFromFiles(Array.from(event.target.files ?? []))]); event.target.value = ''; }
  function update(index: number, patch: Partial<UploadItem>) { setItems((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item)); }
  async function start() {
    if (!folderId || running) return;
    setRunning(true);
    const queue = items.map((item, index) => ({ item, index })).filter(({ item }) => item.status === 'queued' || item.status === 'failed' || item.status === 'cancelled');
    let cursor = 0;
    async function worker() { while (cursor < queue.length) { const job = queue[cursor++]; if (!job) return; const controller = new AbortController(); controllers.set(job.index, controller); update(job.index, { status: 'uploading', progress: 0, message: undefined }); try { await api.uploadPhoto(job.item.file, folderId, (progress: UploadProgress) => update(job.index, { progress: progress.total ? Math.round(progress.loaded / progress.total * 100) : 0 }), controller.signal); update(job.index, { status: 'done', progress: 100 }); } catch (error) { update(job.index, { status: error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ABORTED' ? 'cancelled' : 'failed', message: error instanceof Error ? error.message : 'Upload failed' }); } finally { controllers.delete(job.index); } } }
    await Promise.all([worker(), worker()]);
    setRunning(false);
  }

  return <section className="upload-workspace" aria-labelledby="upload-title"><div className="workspace-heading"><div><span className="eyebrow">Add to your library</span><h1 id="upload-title">Upload</h1></div><span className="upload-count">{completed}/{items.length || 0} complete</span></div><label className="folder-select-label">Destination<select value={folderId} onChange={(event) => setFolderId(event.target.value)}><option value="">Choose a folder</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label><label className="drop-zone"><UploadCloud size={27} /><strong>Choose photos or videos</strong><span>JPEG, PNG, MP4 or WebM · one request per file</span><input type="file" accept="image/jpeg,image/png,video/mp4,video/webm" multiple onChange={selectFiles} /></label>{items.length > 0 && <div className="upload-list">{items.map((item, index) => <div className="upload-row" key={`${item.file.name}-${index}`}><FileImage size={19} /><div className="upload-row-copy"><strong>{item.file.name}</strong><small>{item.status === 'failed' ? item.message : item.status === 'cancelled' ? 'Cancelled' : item.status === 'done' ? 'Uploaded' : item.status === 'uploading' ? `${item.progress}%` : 'Waiting'}</small><div className="progress-track"><span style={{ width: `${item.progress}%` }} /></div></div>{item.status === 'done' ? <Check size={18} className="success-icon" /> : item.status === 'failed' ? <X size={18} className="error-icon" /> : item.status === 'cancelled' ? <button className="text-button" onClick={() => update(index, { status: 'queued', message: undefined })}>Retry</button> : item.status === 'uploading' ? <button className="icon-button" aria-label={`Cancel ${item.file.name}`} onClick={() => controllers.get(index)?.abort()}><X size={18} /></button> : null}</div>)}</div>}<button className="button button-primary upload-start" disabled={!folderId || !items.some((item) => item.status === 'queued' || item.status === 'failed' || item.status === 'cancelled') || running} onClick={() => void start()}>{running ? 'Uploading…' : 'Start upload'}</button></section>;
}
