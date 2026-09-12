import { TouchEvent, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Download, Trash2, X } from 'lucide-react';
import type { ApiClient, Folder, Photo } from '../../app/api';

export default function Viewer({ api, photos, selected, onClose, onDeleted, onUpdated }: { api: ApiClient; photos: Photo[]; selected: number; onClose: () => void; onDeleted: (id: string) => void; onUpdated: (photo: Photo) => void }) {
  const [index, setIndex] = useState(selected);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(photos[selected]?.filename ?? '');
  const [folders, setFolders] = useState<Folder[]>([]);
  const [moveFolder, setMoveFolder] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const touchStart = useRef<number | null>(null);
  const photo = photos[index];
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); if (event.key === 'ArrowLeft') setIndex((value) => Math.max(0, value - 1)); if (event.key === 'ArrowRight') setIndex((value) => Math.min(photos.length - 1, value + 1)); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, photos.length]);
  useEffect(() => { setName(photo?.filename ?? ''); setMessage(null); }, [photo?.id, photo?.filename]);
  useEffect(() => { void api.listFolders().then((response) => setFolders(response.items)).catch(() => undefined); }, [api]);
  if (!photo) return null;
  async function deletePhoto() { if (!confirmDelete) { setConfirmDelete(true); return; } setBusy(true); try { await api.deletePhoto(photo.id); onDeleted(photo.id); onClose(); } catch (error) { setMessage(error instanceof Error ? error.message : 'Delete failed'); } finally { setBusy(false); } }
  async function renamePhoto() { if (!name.trim() || name.trim() === photo.filename) return; setBusy(true); try { const updated = await api.renamePhoto(photo.id, name.trim()); onUpdated(updated); setName(updated.filename); setMessage('Name updated'); } catch (error) { setMessage(error instanceof Error ? error.message : 'Rename failed'); } finally { setBusy(false); } }
  async function movePhoto() { if (!moveFolder || moveFolder === photo.folder_id) return; setBusy(true); try { const updated = await api.movePhoto(photo.id, moveFolder); onUpdated(updated); setMessage('Moved'); } catch (error) { setMessage(error instanceof Error ? error.message : 'Move failed'); } finally { setBusy(false); } }
  function touchEnd(event: TouchEvent) { const start = touchStart.current; touchStart.current = null; const end = event.changedTouches[0]?.clientX; if (start === null || end === undefined || Math.abs(end - start) < 50) return; setIndex((value) => end < start ? Math.min(photos.length - 1, value + 1) : Math.max(0, value - 1)); }
  return <div className="viewer-scrim" role="dialog" aria-modal="true" aria-label={`Details for ${photo.filename}`}><button className="icon-button viewer-close" autoFocus aria-label="Close viewer" onClick={onClose}><X size={21} /></button><button className="icon-button viewer-arrow viewer-prev" aria-label="Previous photo" disabled={index === 0} onClick={() => setIndex((value) => value - 1)}><ArrowLeft size={22} /></button><div className="viewer-stage"><div className="viewer-media" onTouchStart={(event) => { touchStart.current = event.touches[0]?.clientX ?? null; }} onTouchEnd={touchEnd}>{photo.mime_type.startsWith('video/') ? <video src={`/api/v1/photos/${photo.id}/preview`} controls /> : <img src={`/api/v1/photos/${photo.id}/preview`} alt={photo.filename} />}</div><aside className="viewer-inspector"><span className="eyebrow">Photo details</span><h2>{photo.filename}</h2><label className="viewer-field">Filename<input value={name} onChange={(event) => setName(event.target.value)} /><button className="text-button" disabled={busy} onClick={() => void renamePhoto()}>Save name</button></label><label className="viewer-field">Move to<select value={moveFolder} onChange={(event) => setMoveFolder(event.target.value)}><option value="">Choose folder</option>{folders.filter((folder) => folder.id !== photo.folder_id).map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select><button className="text-button" disabled={busy || !moveFolder} onClick={() => void movePhoto()}>Move</button></label><dl><div><dt>Captured</dt><dd>{new Date(photo.captured_at).toLocaleString()}</dd></div><div><dt>Size</dt><dd>{photo.width && photo.height ? `${photo.width} × ${photo.height} · ` : ''}{formatBytes(photo.size)}</dd></div><div><dt>Folder</dt><dd>{photo.folder_id}</dd></div></dl>{message && <p className="viewer-message" role="status">{message}</p>}<div className="viewer-actions"><a className="button button-secondary" href={`/api/v1/photos/${photo.id}/original`} download><Download size={16} /> Download original</a><button className={`button ${confirmDelete ? 'button-danger' : 'button-secondary'}`} disabled={busy} onClick={() => void deletePhoto()}><Trash2 size={16} />{confirmDelete ? 'Confirm delete' : 'Delete'}</button>{confirmDelete && <button className="text-button" onClick={() => setConfirmDelete(false)}>Cancel</button>}</div></aside></div><button className="icon-button viewer-arrow viewer-next" aria-label="Next photo" disabled={index === photos.length - 1} onClick={() => setIndex((value) => value + 1)}><ArrowRight size={22} /></button></div>;
}

function formatBytes(value: number): string { if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`; return `${(value / (1024 * 1024)).toFixed(1)} MB`; }
