import { TouchEvent, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CirclePlay, Download, Share2, Trash2, X } from 'lucide-react';
import { useI18n } from '../../app/I18nProvider';
import type { ApiClient, Folder, Photo } from '../../app/api';
import ShareDialog from '../sharing/ShareDialog';

export default function Viewer({ api, photos, selected, onClose, onDeleted, onUpdated }: { api: ApiClient; photos: Photo[]; selected: number; onClose: () => void; onDeleted: (id: string) => void; onUpdated: (photo: Photo) => void }) {
  const { t, formatDate } = useI18n();
  const [index, setIndex] = useState(selected);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(photos[selected]?.filename ?? '');
  const [folders, setFolders] = useState<Folder[]>([]);
  const [currentFolder, setCurrentFolder] = useState<Folder | null>(null);
  const [moveFolder, setMoveFolder] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const touchStart = useRef<number | null>(null);
  const photo = photos[index];
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); if (event.key === 'ArrowLeft') setIndex((value) => Math.max(0, value - 1)); if (event.key === 'ArrowRight') setIndex((value) => Math.min(photos.length - 1, value + 1)); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, photos.length]);
  useEffect(() => { setName(photo?.filename ?? ''); setMessage(null); setConfirmDelete(false); }, [photo?.id, photo?.filename]);
  useEffect(() => { void api.listFolders().then((response) => setFolders(response.items)).catch(() => undefined); }, [api]);
  useEffect(() => {
    let active = true;
    setCurrentFolder(null);
    if (!photo?.folder_id) return () => { active = false; };
    void api.getFolder(photo.folder_id).then((folder) => { if (active) setCurrentFolder(folder); }).catch(() => undefined);
    return () => { active = false; };
  }, [api, photo?.folder_id]);
  if (!photo) return null;
  async function deletePhoto() { if (!confirmDelete) { setConfirmDelete(true); return; } setBusy(true); try { await api.deletePhoto(photo.id); onDeleted(photo.id); onClose(); } catch { setMessage(t('viewer.deleteFailed')); } finally { setBusy(false); } }
  async function renamePhoto() { if (!name.trim() || name.trim() === photo.filename) return; setBusy(true); try { const updated = await api.renamePhoto(photo.id, name.trim()); onUpdated({ ...updated, is_live_photo: photo.is_live_photo }); setName(updated.filename); setMessage(t('viewer.nameUpdated')); } catch { setMessage(t('viewer.renameFailed')); } finally { setBusy(false); } }
  async function movePhoto() { if (!moveFolder || moveFolder === photo.folder_id) return; setBusy(true); try { const updated = await api.movePhoto(photo.id, moveFolder); onUpdated({ ...updated, is_live_photo: photo.is_live_photo }); void api.getFolder(updated.folder_id).then(setCurrentFolder).catch(() => setCurrentFolder(null)); setMessage(t('viewer.moved')); } catch { setMessage(t('viewer.moveFailed')); } finally { setBusy(false); } }
  function touchEnd(event: TouchEvent) { const start = touchStart.current; touchStart.current = null; const end = event.changedTouches[0]?.clientX; if (start === null || end === undefined || Math.abs(end - start) < 50) return; setIndex((value) => end < start ? Math.min(photos.length - 1, value + 1) : Math.max(0, value - 1)); }
  const previewURL = `/api/v1/photos/${encodeURIComponent(photo.id)}/preview`;
  return <div className="viewer-scrim" role="dialog" aria-modal="true" aria-label={t('viewer.detailsFor', { name: photo.filename })}><button className="icon-button viewer-close" autoFocus aria-label={t('common.close')} onClick={onClose}><X size={21} /></button><button className="icon-button viewer-arrow viewer-prev" aria-label={t('common.previousPhoto')} disabled={index === 0} onClick={() => setIndex((value) => value - 1)}><ArrowLeft size={22} /></button><div className="viewer-stage"><div className="viewer-media" onTouchStart={(event) => { touchStart.current = event.touches[0]?.clientX ?? null; }} onTouchEnd={touchEnd}>{photo.is_live_photo ? <><video key={photo.id} src={`/api/v1/live-photos/${encodeURIComponent(photo.id)}`} poster={previewURL} controls playsInline preload="metadata" /><span className="live-photo-viewer-badge"><CirclePlay size={14} /> LIVE</span></> : photo.mime_type.startsWith('video/') ? <video src={previewURL} controls /> : <img src={previewURL} alt={photo.filename} />}</div><aside className="viewer-inspector"><span className="eyebrow">{t('viewer.photoDetails')}</span><h2>{photo.filename}</h2><label className="viewer-field">{t('viewer.filename')}<input value={name} onChange={(event) => setName(event.target.value)} /><button className="text-button" disabled={busy} onClick={() => void renamePhoto()}>{t('viewer.saveName')}</button></label><label className="viewer-field">{t('viewer.moveTo')}<select value={moveFolder} onChange={(event) => setMoveFolder(event.target.value)}><option value="">{t('common.chooseFolder')}</option>{folders.filter((folder) => folder.id !== photo.folder_id).map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select><button className="text-button" disabled={busy || !moveFolder} onClick={() => void movePhoto()}>{t('viewer.move')}</button></label><dl><div><dt>{t('viewer.captured')}</dt><dd>{formatDate(photo.captured_at)}</dd></div><div><dt>{t('viewer.size')}</dt><dd>{photo.width && photo.height ? `${photo.width} × ${photo.height} · ` : ''}{formatBytes(photo.size)}</dd></div><div><dt>{t('viewer.folder')}</dt><dd>{currentFolder?.name ?? t('common.unknownFolder')}</dd></div></dl>{message && <p className="viewer-message" role="status">{message}</p>}<div className="viewer-actions"><a className="icon-button" href={`/api/v1/photos/${encodeURIComponent(photo.id)}/original`} download aria-label={t('common.downloadOriginal')} title={t('common.downloadOriginal')}><Download size={18} /></a><button className={`icon-button ${confirmDelete ? 'button-danger' : ''}`} disabled={busy} onClick={() => void deletePhoto()} aria-label={confirmDelete ? t('common.confirmDelete') : t('viewer.deletePhoto')} title={confirmDelete ? t('common.confirmDelete') : t('viewer.deletePhoto')}><Trash2 size={18} /></button><button className="icon-button" type="button" aria-label={t('viewer.sharePhoto')} title={t('viewer.sharePhoto')} onClick={() => setShareOpen(true)}><Share2 size={18} /></button>{confirmDelete && <button className="text-button" onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</button>}</div></aside></div><button className="icon-button viewer-arrow viewer-next" aria-label={t('common.nextPhoto')} disabled={index === photos.length - 1} onClick={() => setIndex((value) => value + 1)}><ArrowRight size={22} /></button>{shareOpen && <ShareDialog api={api} resource={{ type: 'photo', id: photo.id, name: photo.filename }} onClose={() => setShareOpen(false)} />}</div>;
}

function formatBytes(value: number): string { if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`; return `${(value / (1024 * 1024)).toFixed(1)} MB`; }
