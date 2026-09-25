import { TouchEvent, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CirclePlay, Download, Info, MoveRight, Pencil, Share2, Trash2, X } from 'lucide-react';
import { useI18n } from '../../app/I18nProvider';
import type { ApiClient, Folder, Photo } from '../../app/api';
import ShareDialog from '../sharing/ShareDialog';
import './Viewer.css';

type ViewerProps = {
  api: ApiClient;
  photos: Photo[];
  selected: number;
  onClose: () => void;
  onDeleted: (id: string) => void;
  onUpdated: (photo: Photo) => void;
};

export default function Viewer({ api, photos, selected, onClose, onDeleted, onUpdated }: ViewerProps) {
  const { t, formatDate } = useI18n();
  const [index, setIndex] = useState(selected);
  const [detailsOpen, setDetailsOpen] = useState(false);
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
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (detailsOpen) setDetailsOpen(false);
        else onClose();
      }
      if (event.key === 'ArrowLeft') setIndex((value) => Math.max(0, value - 1));
      if (event.key === 'ArrowRight') setIndex((value) => Math.min(photos.length - 1, value + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detailsOpen, onClose, photos.length]);

  useEffect(() => {
    setName(photo?.filename ?? '');
    setMoveFolder('');
    setMessage(null);
    setConfirmDelete(false);
  }, [photo?.id, photo?.filename]);

  useEffect(() => {
    void api.listFolders().then((response) => setFolders(response.items)).catch(() => undefined);
  }, [api]);

  useEffect(() => {
    let active = true;
    setCurrentFolder(null);
    if (!photo?.folder_id) return () => { active = false; };
    void api.getFolder(photo.folder_id)
      .then((folder) => { if (active) setCurrentFolder(folder); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [api, photo?.folder_id]);

  if (!photo) return null;

  async function deletePhoto() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    try {
      await api.deletePhoto(photo.id);
      onDeleted(photo.id);
      onClose();
    } catch {
      setMessage(t('viewer.deleteFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function renamePhoto() {
    if (!name.trim() || name.trim() === photo.filename) return;
    setBusy(true);
    try {
      const updated = await api.renamePhoto(photo.id, name.trim());
      onUpdated({ ...updated, is_live_photo: photo.is_live_photo });
      setName(updated.filename);
      setMessage(t('viewer.nameUpdated'));
    } catch {
      setMessage(t('viewer.renameFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function movePhoto() {
    if (!moveFolder || moveFolder === photo.folder_id) return;
    setBusy(true);
    try {
      const updated = await api.movePhoto(photo.id, moveFolder);
      onUpdated({ ...updated, is_live_photo: photo.is_live_photo });
      void api.getFolder(updated.folder_id).then(setCurrentFolder).catch(() => setCurrentFolder(null));
      setMoveFolder('');
      setMessage(t('viewer.moved'));
    } catch {
      setMessage(t('viewer.moveFailed'));
    } finally {
      setBusy(false);
    }
  }

  function touchEnd(event: TouchEvent) {
    const start = touchStart.current;
    touchStart.current = null;
    const end = event.changedTouches[0]?.clientX;
    if (start === null || end === undefined || Math.abs(end - start) < 50) return;
    setIndex((value) => end < start ? Math.min(photos.length - 1, value + 1) : Math.max(0, value - 1));
  }

  const previewURL = photoPreviewURL(photo.id);
  const filmstripStart = Math.max(0, Math.min(index - 4, Math.max(0, photos.length - 9)));
  const filmstrip = photos.slice(filmstripStart, filmstripStart + 9);

  return (
    <div className={`immersive-viewer${detailsOpen ? ' has-details' : ''}`} role="dialog" aria-modal="true" aria-label={t('viewer.detailsFor', { name: photo.filename })}>
      <div className="immersive-viewer__surface">
        <header className="immersive-viewer__topbar">
          <button className="immersive-viewer__icon immersive-viewer__close" autoFocus aria-label={t('common.close')} title={t('common.close')} onClick={onClose}>
            <X size={22} />
          </button>
          <div className="immersive-viewer__title">
            <strong>{photo.filename}</strong>
            <span>{formatDate(photo.captured_at)}</span>
          </div>
          <div className="immersive-viewer__toolbar">
            <button className="immersive-viewer__icon" type="button" aria-label={t('viewer.sharePhoto')} title={t('viewer.sharePhoto')} onClick={() => setShareOpen(true)}>
              <Share2 size={20} />
            </button>
            <a className="immersive-viewer__icon" href={`/api/v1/photos/${encodeURIComponent(photo.id)}/original`} download aria-label={t('common.downloadOriginal')} title={t('common.downloadOriginal')}>
              <Download size={20} />
            </a>
            <button className={`immersive-viewer__icon${detailsOpen ? ' is-active' : ''}`} type="button" aria-label={t('viewer.photoDetails')} title={t('viewer.photoDetails')} aria-expanded={detailsOpen} onClick={() => setDetailsOpen((value) => !value)}>
              <Info size={20} />
            </button>
          </div>
        </header>

        <main className="immersive-viewer__content">
          <button className="immersive-viewer__nav immersive-viewer__nav--prev" aria-label={t('common.previousPhoto')} disabled={index === 0} onClick={() => setIndex((value) => value - 1)}>
            <ArrowLeft size={23} />
          </button>

          <div className="immersive-viewer__media-wrap" onTouchStart={(event) => { touchStart.current = event.touches[0]?.clientX ?? null; }} onTouchEnd={touchEnd}>
            <div className="immersive-viewer__media">
              {photo.is_live_photo ? (
                <LivePhotoMedia key={photo.id} photo={photo} previewURL={previewURL} />
              ) : photo.mime_type.startsWith('video/') ? (
                <video key={photo.id} src={previewURL} controls playsInline preload="metadata" />
              ) : (
                <img src={previewURL} alt={photo.filename} />
              )}
            </div>
          </div>

          <button className="immersive-viewer__nav immersive-viewer__nav--next" aria-label={t('common.nextPhoto')} disabled={index === photos.length - 1} onClick={() => setIndex((value) => value + 1)}>
            <ArrowRight size={23} />
          </button>
        </main>

        <footer className="immersive-viewer__footer">
          <div className="immersive-viewer__live-slot">
            {photo.is_live_photo && <span className="immersive-viewer__live"><CirclePlay size={14} /> LIVE</span>}
          </div>
          <div className="immersive-viewer__filmstrip" aria-label={t('gallery.timeline')}>
            {filmstrip.map((item, offset) => {
              const itemIndex = filmstripStart + offset;
              return (
                <button key={item.id} className={`immersive-viewer__thumb${itemIndex === index ? ' is-current' : ''}`} type="button" aria-label={item.filename} aria-current={itemIndex === index ? 'true' : undefined} onClick={() => setIndex(itemIndex)}>
                  <FilmstripThumbnail photo={item} />
                  {item.is_live_photo && <CirclePlay size={12} className="immersive-viewer__thumb-live" />}
                </button>
              );
            })}
          </div>
          <span className="immersive-viewer__count">{index + 1} / {photos.length}</span>
        </footer>
      </div>

      {detailsOpen && (
        <aside className="immersive-viewer__details">
          <div className="immersive-viewer__details-header">
            <h2>{t('viewer.photoDetails')}</h2>
            <button className="immersive-viewer__details-close" type="button" aria-label={t('common.close')} title={t('common.close')} onClick={() => setDetailsOpen(false)}>
              <X size={19} />
            </button>
          </div>

          <div className="immersive-viewer__details-summary">
            <img src={previewURL} alt="" />
            <div>
              <strong>{photo.filename}</strong>
              <span>{formatDate(photo.captured_at)}</span>
            </div>
          </div>

          <dl className="immersive-viewer__metadata">
            <div><dt>{t('viewer.captured')}</dt><dd>{formatDate(photo.captured_at)}</dd></div>
            <div><dt>{t('viewer.size')}</dt><dd>{photo.width && photo.height ? `${photo.width} × ${photo.height} · ` : ''}{formatBytes(photo.size)}</dd></div>
            <div><dt>{t('viewer.folder')}</dt><dd>{currentFolder?.name ?? t('common.unknownFolder')}</dd></div>
          </dl>

          <div className="immersive-viewer__details-section">
            <label className="immersive-viewer__field">
              <span><Pencil size={15} /> {t('viewer.filename')}</span>
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <button className="immersive-viewer__action" disabled={busy || !name.trim() || name.trim() === photo.filename} onClick={() => void renamePhoto()}>
              <Pencil size={17} />
              <span>{t('viewer.saveName')}</span>
            </button>

            <label className="immersive-viewer__field">
              <span><MoveRight size={15} /> {t('viewer.moveTo')}</span>
              <select value={moveFolder} onChange={(event) => setMoveFolder(event.target.value)}>
                <option value="">{t('common.chooseFolder')}</option>
                {folders.filter((folder) => folder.id !== photo.folder_id).map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
              </select>
            </label>
            <button className="immersive-viewer__action" disabled={busy || !moveFolder} onClick={() => void movePhoto()}>
              <MoveRight size={17} />
              <span>{t('viewer.move')}</span>
            </button>
          </div>

          {message && <p className="immersive-viewer__message" role="status">{message}</p>}

          <div className="immersive-viewer__details-actions">
            <a className="immersive-viewer__action" href={`/api/v1/photos/${encodeURIComponent(photo.id)}/original`} download>
              <Download size={17} />
              <span>{t('common.downloadOriginal')}</span>
            </a>
            <button className="immersive-viewer__action" type="button" onClick={() => setShareOpen(true)}>
              <Share2 size={17} />
              <span>{t('viewer.sharePhoto')}</span>
            </button>
            <button className={`immersive-viewer__action immersive-viewer__action--danger${confirmDelete ? ' is-confirming' : ''}`} disabled={busy} onClick={() => void deletePhoto()}>
              <Trash2 size={17} />
              <span>{confirmDelete ? t('common.confirmDelete') : t('viewer.deletePhoto')}</span>
            </button>
            {confirmDelete && (
              <button className="immersive-viewer__cancel" type="button" onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</button>
            )}
          </div>
        </aside>
      )}

      {shareOpen && <ShareDialog api={api} resource={{ type: 'photo', id: photo.id, name: photo.filename }} onClose={() => setShareOpen(false)} />}
    </div>
  );
}

function FilmstripThumbnail({ photo }: { photo: Photo }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const retryTimer = useRef<number | null>(null);
  const isVideo = photo.mime_type.startsWith('video/');
  const src = failed
    ? isVideo ? videoPlaceholderSource : '/image-placeholder.svg'
    : `/api/v1/photos/${encodeURIComponent(photo.id)}/thumbnail?size=256&retry=${attempt}`;

  useEffect(() => () => {
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
  }, []);

  function handleError() {
    if (attempt < thumbnailRetryLimit) {
      if (retryTimer.current === null) {
        retryTimer.current = window.setTimeout(() => {
          retryTimer.current = null;
          setAttempt((value) => value + 1);
        }, thumbnailRetryDelayMS);
      }
      return;
    }
    setFailed(true);
  }

  return <img src={src} alt="" loading="lazy" onError={handleError} />;
}

function LivePhotoMedia({ photo, previewURL }: { photo: Photo; previewURL: string }) {
  const [playing, setPlaying] = useState(true);

  if (!playing) {
    return (
      <img
        className="immersive-viewer__live-still"
        src={previewURL}
        alt={photo.filename}
        role="button"
        tabIndex={0}
        title="Live Photo · click to replay"
        onClick={() => setPlaying(true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setPlaying(true);
          }
        }}
      />
    );
  }

  return (
    <video
      className="immersive-viewer__live-media"
      src={`/api/v1/live-photos/${encodeURIComponent(photo.id)}`}
      poster={previewURL}
      autoPlay
      muted
      playsInline
      preload="auto"
      onEnded={() => setPlaying(false)}
      onError={() => setPlaying(false)}
      onClick={() => setPlaying(false)}
      aria-label={photo.filename}
      title="Live Photo"
    />
  );
}

function photoPreviewURL(id: string): string {
  return `/api/v1/photos/${encodeURIComponent(id)}/preview`;
}

const thumbnailRetryLimit = 2;
const thumbnailRetryDelayMS = 1000;
const videoPlaceholderSource = '/video-placeholder.svg';

function formatBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
