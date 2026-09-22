import { FormEvent, useEffect, useRef, useState } from 'react';
import { ChevronRight, CirclePlay, Folder, LoaderCircle, Plus, Share2 } from 'lucide-react';
import { useI18n } from '../../app/I18nProvider';
import type { ApiClient, Folder as FolderRecord, Photo } from '../../app/api';
import ShareDialog from '../sharing/ShareDialog';
import Viewer from '../viewer/Viewer';
import { FolderListSkeleton } from '../loading/LoadingStates';
import FolderEmptyState from './FolderEmptyState';

type FolderLocation = Pick<FolderRecord, 'id' | 'name'>;

type Props = {
  api: ApiClient;
  initialFolder?: FolderLocation | null;
  onFolderChange?: (folder: FolderLocation | null) => void;
  onUpload: (folder?: FolderLocation | null) => void;
};

export default function FoldersWorkspace({ api, initialFolder = null, onFolderChange, onUpload }: Props) {
  const { locale, t, formatCount } = useI18n();
  const [parent, setParent] = useState<FolderLocation | null>(initialFolder);
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [photoCursor, setPhotoCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [shareResource, setShareResource] = useState<{ type: 'folder'; id: string; name: string } | null>(null);
  const folderNameRef = useRef<HTMLInputElement>(null);
  const loadGenerationRef = useRef(0);
  const copy = locale === 'zh' ? {
    folders: '文件夹',
    photos: '照片',
    loadMore: '加载更多照片',
    loadingMore: '正在加载…',
    photoLoadFailed: '无法加载更多照片。',
  } : {
    folders: 'Folders',
    photos: 'Photos',
    loadMore: 'Load more photos',
    loadingMore: 'Loading…',
    photoLoadFailed: 'Unable to load more photos.',
  };

  useEffect(() => { onFolderChange?.(parent); }, [onFolderChange, parent?.id, parent?.name]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setSelected(null);
    const folderRequest = api.listFolders(parent?.id);
    const photoRequest = parent
      ? api.listPhotos({ folderId: parent.id, limit: 50 })
      : Promise.resolve({ items: [] as Photo[], next_cursor: null as string | null });
    void Promise.all([folderRequest, photoRequest]).then(([folderResponse, photoResponse]) => {
      if (!active) return;
      setFolders(folderResponse.items);
      setPhotos(photoResponse.items);
      setPhotoCursor(photoResponse.next_cursor);
    }).catch(() => {
      if (active) setError(t('folders.loadFailed'));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
      loadGenerationRef.current += 1;
    };
  }, [api, parent?.id, t]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const folder = await api.createFolder(name.trim(), parent?.id ?? null);
      setFolders((current) => [...current, folder].sort((a, b) => a.name.localeCompare(b.name)));
      setName('');
    } catch {
      setError(t('folders.createFailed'));
    } finally {
      setCreating(false);
    }
  }

  async function loadMorePhotos() {
    if (!parent || !photoCursor || loadingMore) return;
    const generation = loadGenerationRef.current;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await api.listPhotos({ folderId: parent.id, cursor: photoCursor, limit: 50 });
      if (generation !== loadGenerationRef.current) return;
      setPhotos((current) => [...current, ...page.items]);
      setPhotoCursor(page.next_cursor);
    } catch {
      if (generation === loadGenerationRef.current) setError(copy.photoLoadFailed);
    } finally {
      if (generation === loadGenerationRef.current) setLoadingMore(false);
    }
  }

  const empty = folders.length === 0 && photos.length === 0;

  return <section className="folders-workspace" aria-labelledby="folders-title">
    <div className="workspace-heading">
      <div><span className="eyebrow">{t('folders.yourLibrary')}</span><h1 id="folders-title">{t('folders.title')}</h1></div>
      <form className="inline-create" onSubmit={create}>
        <label className="sr-only" htmlFor="folder-name">{t('folders.newFolder')}</label>
        <input ref={folderNameRef} id="folder-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={t('folders.newFolder')} />
        <button className="icon-button" type="submit" disabled={creating} aria-label={t('folders.createFolder')}><Plus size={19} /></button>
      </form>
    </div>

    <div className="breadcrumbs">
      <button className="breadcrumb-button" onClick={() => setParent(null)}>{t('shell.library')}</button>
      {parent && <><ChevronRight size={14} /><span>{parent.name}</span></>}
    </div>

    {loading && <FolderListSkeleton />}
    {!loading && error && <p className="inline-state" role="alert">{error}</p>}
    {!loading && !error && empty && <FolderEmptyState onUpload={() => onUpload(parent)} onCreateFolder={() => folderNameRef.current?.focus()} />}

    {!loading && !error && folders.length > 0 && <div className="timeline-group">
      {parent && <div className="date-heading"><h2>{copy.folders}</h2><span>{formatCount(folders.length)}</span></div>}
      <div className="folder-list">{folders.map((folder) => {
        const photoCount = folder.photo_count ?? 0;
        const childFolderCount = folder.child_folder_count ?? 0;
        return <div className="folder-row" key={folder.id}>
          <button className="folder-row-link" type="button" onClick={() => setParent(folder)}>
            <span className="folder-icon"><Folder size={19} /></span>
            <span className="folder-row-copy"><strong>{folder.name}</strong><small>{photoCount === 1 ? t('folders.onePhoto', { count: formatCount(photoCount) }) : t('folders.manyPhotos', { count: formatCount(photoCount) })} · {childFolderCount === 1 ? t('folders.oneFolder', { count: formatCount(childFolderCount) }) : t('folders.manyFolders', { count: formatCount(childFolderCount) })}</small></span>
            <ChevronRight size={18} />
          </button>
          <button className="icon-button folder-share-button" type="button" aria-label={t('common.shareFolder')} title={t('common.shareFolder')} onClick={() => setShareResource({ type: 'folder', id: folder.id, name: folder.name })}><Share2 size={18} /></button>
        </div>;
      })}</div>
    </div>}

    {!loading && !error && parent && photos.length > 0 && <div className="timeline-group" style={{ marginTop: folders.length > 0 ? 48 : 10 }}>
      <div className="date-heading"><h2>{copy.photos}</h2><span>{formatCount(photos.length)}</span></div>
      <div className="photo-grid">{photos.map((photo, index) => <FolderPhotoTile key={photo.id} photo={photo} onSelect={() => setSelected(index)} />)}</div>
      {photoCursor && <div className="gallery-sentinel"><button className="button button-secondary" disabled={loadingMore} onClick={() => void loadMorePhotos()}>{loadingMore && <LoaderCircle className="spin" size={16} />} {loadingMore ? copy.loadingMore : copy.loadMore}</button></div>}
    </div>}

    {shareResource && <ShareDialog api={api} resource={shareResource} onClose={() => setShareResource(null)} />}
    {selected !== null && <Viewer api={api} photos={photos} selected={selected} onClose={() => setSelected(null)} onDeleted={(id) => setPhotos((current) => current.filter((photo) => photo.id !== id))} onUpdated={(photo) => setPhotos((current) => current.map((item) => item.id === photo.id ? photo : item))} />}
  </section>;
}

function FolderPhotoTile({ photo, onSelect }: { photo: Photo; onSelect: () => void }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  return <figure className="photo-tile" onClick={onSelect}>
    <div className={`photo-frame ${failed ? 'is-failed' : ''}`}>
      {failed ? <span>{t('gallery.previewPending')}</span> : <img src={`/api/v1/photos/${encodeURIComponent(photo.id)}/thumbnail?size=256`} alt={photo.filename} loading="lazy" onError={() => setFailed(true)} />}
      {photo.is_live_photo && !failed && <span title="Live Photo" style={{ position: 'absolute', left: 9, top: 9, display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 999, padding: '5px 7px', background: 'rgba(32,37,45,.72)', color: '#fff', fontSize: 9, fontWeight: 700, letterSpacing: '.08em', pointerEvents: 'none' }}><CirclePlay size={12} /> LIVE</span>}
    </div>
    <figcaption>{photo.filename}</figcaption>
  </figure>;
}
