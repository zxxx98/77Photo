import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowUpRight, LoaderCircle, RefreshCw, Trash2, X } from 'lucide-react';
import { useI18n } from '../../app/I18nProvider';
import type { ApiClient, Folder, ListPhotosParams, Photo } from '../../app/api';
import Viewer from '../viewer/Viewer';
import { GallerySkeleton } from '../loading/LoadingStates';
import { TimelineGroup, groupByDate } from './PhotoGrid';

export default function GalleryWorkspace({ api }: { api: ApiClient }) {
  const { t, formatCount, locale } = useI18n();
  const [initialFilters] = useState(readGalleryFilters);
  const [searchInput, setSearchInput] = useState(initialFilters.q);
  const [query, setQuery] = useState(initialFilters.q);
  const [mediaType, setMediaType] = useState<'' | 'photo' | 'video'>(initialFilters.mediaType);
  const [favorite, setFavorite] = useState(initialFilters.favorite);
  const [favoritesSupported, setFavoritesSupported] = useState(false);
  const [folderId, setFolderId] = useState(initialFilters.folderId);
  const [fromDate, setFromDate] = useState(initialFilters.fromDate);
  const [toDate, setToDate] = useState(initialFilters.toDate);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [libraryEmpty, setLibraryEmpty] = useState<boolean | null>(null);
  const libraryEmptyRef = useRef<boolean | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const requestRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const searchPendingRef = useRef(false);
  const pendingQueryRef = useRef('');
  const copy = useMemo(() => gallerySelectionCopy(locale, formatCount), [locale, formatCount]);

  useEffect(() => {
    let active = true;
    void loadVisibleFolders(api).then((items) => { if (active) setFolders(items); }).catch(() => {});
    return () => { active = false; };
  }, [api]);

  const activeFilters = useMemo(() => ({ q: query, mediaType, folderId, fromDate, toDate, favorite }), [query, mediaType, folderId, fromDate, toDate, favorite]);
  const hasFilters = !!(query || mediaType || folderId || fromDate || toDate || favorite);
  const invalidDates = !!(fromDate && toDate && fromDate > toDate);

  const load = useCallback(async (nextCursor?: string) => {
    if (invalidDates) return;
    if (nextCursor && loadingRef.current) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const generation = ++generationRef.current;
    loadingRef.current = true;
    setError(null);
    nextCursor ? setLoadingMore(true) : setLoading(true);
    try {
      const params: ListPhotosParams = {
        cursor: nextCursor, limit: 50, signal: controller.signal,
        q: activeFilters.q || undefined,
        mediaType: activeFilters.mediaType || undefined,
        favorite: activeFilters.favorite || undefined,
        folderId: activeFilters.folderId || undefined,
        from: activeFilters.fromDate ? localDateBoundary(activeFilters.fromDate) : undefined,
        to: activeFilters.toDate ? localDateBoundary(activeFilters.toDate, true) : undefined,
      };
      const page = await api.listPhotos(params);
      if (generation !== generationRef.current || controller.signal.aborted) return;
      const supported = page.favorites_supported === true || page.items.some((item) => typeof item.is_favorite === 'boolean');
      setFavoritesSupported(supported);
      if (!supported && activeFilters.favorite) setFavorite(false);
      if (!nextCursor && !hasFilters) {
        libraryEmptyRef.current = page.items.length === 0;
        setLibraryEmpty(libraryEmptyRef.current);
      } else if (!nextCursor && page.items.length === 0 && libraryEmptyRef.current === null) {
        const baseline = await api.listPhotos({ limit: 1, signal: controller.signal });
        if (generation !== generationRef.current || controller.signal.aborted) return;
        libraryEmptyRef.current = baseline.items.length === 0;
        setLibraryEmpty(libraryEmptyRef.current);
      }
      setPhotos((current) => nextCursor ? [...current, ...page.items] : page.items);
      setCursor(page.next_cursor);
    } catch {
      if (generation === generationRef.current && !controller.signal.aborted) setError(t('gallery.loadFailed'));
    } finally {
      if (generation === generationRef.current) {
        loadingRef.current = false;
        requestRef.current = null;
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [api, t, activeFilters, hasFilters, invalidDates]);

  useEffect(() => {
    writeGalleryFilters(activeFilters);
    setPhotos([]);
    setCursor(null);
    setSelected(null);
    exitSelectionMode();
    if (invalidDates) { requestRef.current?.abort(); setError(null); setLoading(false); return; }
    void load();
    return () => { requestRef.current?.abort(); generationRef.current += 1; loadingRef.current = false; };
  }, [load, invalidDates]);

  useEffect(() => {
    if (searchInput.trim() === query) {
      if (searchPendingRef.current && query === pendingQueryRef.current) void load();
      searchPendingRef.current = false;
      return;
    }
    if (!searchPendingRef.current) pendingQueryRef.current = query;
    searchPendingRef.current = true;
    requestRef.current?.abort();
    requestRef.current = null;
    generationRef.current += 1;
    loadingRef.current = false;
    setPhotos([]);
    setCursor(null);
    setLoading(!invalidDates);
    const timer = window.setTimeout(() => setQuery(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput, query, load, invalidDates]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !cursor) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) void load(cursor);
    }, { rootMargin: '480px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [cursor, load]);

  const groups = useMemo(() => groupByDate(photos), [photos]);
  const selectedPhotos = useMemo(() => photos.filter((photo) => selectedIds.has(photo.id)), [photos, selectedIds]);

  function enterSelectionMode() {
    setSelected(null);
    setSelectionMode(true);
    setBulkError(null);
  }

  function exitSelectionMode() {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setConfirmBulkDelete(false);
    setBulkError(null);
  }

  function togglePhoto(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
    setBulkError(null);
  }

  function toggleDay(items: Photo[]) {
    setSelectedIds((current) => {
      const next = new Set(current);
      const allSelected = items.every((photo) => next.has(photo.id));
      for (const photo of items) {
        allSelected ? next.delete(photo.id) : next.add(photo.id);
      }
      return next;
    });
    setBulkError(null);
  }

  function refresh() {
    libraryEmptyRef.current = null;
    setLibraryEmpty(null);
    void load();
  }

  async function deleteSelectedPhotos() {
    const ids = [...selectedIds];
    if (!ids.length) return;
    setDeleting(true);
    setBulkError(null);
    try {
      const result = api.deletePhotos
        ? await api.deletePhotos(ids)
        : await deleteIndividually(api, ids);
      const deleted = new Set(result.deleted_ids);
      setPhotos((current) => current.filter((photo) => !deleted.has(photo.id)));
      if (result.failed.length === 0) {
        exitSelectionMode();
        return;
      }
      setSelectedIds(new Set(result.failed.map((failure) => failure.id)));
      setConfirmBulkDelete(false);
      setBulkError(copy.partialFailure(result.failed.length));
    } catch {
      setConfirmBulkDelete(false);
      setBulkError(copy.deleteFailed);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="gallery-workspace" aria-labelledby="gallery-title">
      <div className="workspace-heading gallery-heading">
        <div><span className="eyebrow">{t('gallery.yourLibrary')}</span><h1 id="gallery-title">{t('gallery.timeline')}</h1><p className="gallery-intro">{t('gallery.intro')}</p></div>
        <div className="gallery-heading-actions">
          <span className="gallery-count">{selectionMode ? copy.selected(selectedIds.size) : photos.length || hasFilters ? t('gallery.loaded', { count: formatCount(photos.length) }) : t('gallery.noPhotosYet')}</span>
          {selectionMode ? (
            <button className="button button-secondary" type="button" onClick={exitSelectionMode}>{copy.cancel}</button>
          ) : (
            <>
              {photos.length > 0 && <button className="button button-secondary" type="button" onClick={enterSelectionMode}>{copy.select}</button>}
              <button className="view-toggle" aria-label={t('gallery.refresh')} onClick={refresh}><RefreshCw size={18} /></button>
            </>
          )}
        </div>
      </div>
      <div className="gallery-search" role="search" aria-label={t('gallery.filters')}>
        <label>{t('gallery.searchName')}<input type="search" value={searchInput} maxLength={100} onChange={(event) => setSearchInput(event.target.value)} placeholder={t('gallery.searchPlaceholder')} /></label>
        <label>{t('gallery.folder')}<select value={folderId} onChange={(event) => setFolderId(event.target.value)}><option value="">{t('gallery.allFolders')}</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
        <label>{t('gallery.fromDate')}<input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label>
        <label>{t('gallery.toDate')}<input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} /></label>
        <div className="gallery-media-filters" aria-label={t('gallery.mediaType')}>
          {(['', 'photo', 'video'] as const).map((type) => <button key={type} type="button" className={`filter-chip${mediaType === type ? ' is-active' : ''}`} aria-pressed={mediaType === type} onClick={() => setMediaType(type)}>{t(type === '' ? 'gallery.allPhotos' : type === 'photo' ? 'gallery.photos' : 'gallery.videos')}</button>)}
        </div>
        {favoritesSupported && <button type="button" className={`filter-chip${favorite ? ' is-active' : ''}`} aria-pressed={favorite} onClick={() => setFavorite((value) => !value)}>{t('gallery.favorites')}</button>}
        {hasFilters && <button type="button" className="button button-secondary" onClick={() => { setSearchInput(''); setQuery(''); setMediaType(''); setFolderId(''); setFromDate(''); setToDate(''); setFavorite(false); }}>{t('gallery.clearFilters')}</button>}
      </div>
      {invalidDates && <div className="inline-state" role="alert">{t('gallery.invalidDates')}</div>}
      {bulkError && <div className="inline-state" role="alert">{bulkError}</div>}
      {loading && <GallerySkeleton />}
      {!loading && error && <div className="inline-state" role="alert">{error}<button className="button button-secondary" onClick={refresh}>{t('common.retry')}</button></div>}
      {!loading && !error && !invalidDates && photos.length === 0 && (hasFilters && !libraryEmpty ? <div className="inline-state">{t('gallery.noResults')}</div> : <EmptyTimeline />)}
      {!loading && !error && groups.map(([date, items]) => (
        <TimelineGroup
          key={date}
          date={date}
          photos={items}
          selectionMode={selectionMode}
          selectedIds={selectedIds}
          selectDayLabel={items.every((photo) => selectedIds.has(photo.id)) ? copy.clearDay : copy.selectDay}
          onToggleDay={() => toggleDay(items)}
          onToggle={togglePhoto}
          onSelect={(photo) => setSelected(photos.findIndex((item) => item.id === photo.id))}
          selectedLabel={copy.selectPhoto}
          deselectedLabel={copy.deselectPhoto}
        />
      ))}
      <div ref={sentinel} className="gallery-sentinel" aria-hidden="true">{loadingMore && <LoaderCircle className="spin" size={18} />}</div>
      {selected !== null && !selectionMode && <Viewer api={api} photos={photos} selected={selected} onClose={() => { setSelected(null); if (favorite) void load(); }} onDeleted={(id) => setPhotos((current) => current.filter((photo) => photo.id !== id))} onUpdated={(photo) => setPhotos((current) => current.map((item) => item.id === photo.id ? photo : item))} onFavoriteSettled={() => { if (favorite) void load(); }} />}

      {selectionMode && (
        <div style={bulkBarStyle} aria-live="polite">
          <strong>{copy.selected(selectedIds.size)}</strong>
          <button
            type="button"
            disabled={selectedIds.size === 0 || deleting}
            onClick={() => setConfirmBulkDelete(true)}
            style={{ ...bulkDeleteButtonStyle, opacity: selectedIds.size === 0 || deleting ? 0.5 : 1 }}
          >
            <Trash2 size={17} /> {copy.deleteSelected(selectedIds.size)}
          </button>
        </div>
      )}

      {confirmBulkDelete && (
        <div style={dialogBackdropStyle}>
          <div role="dialog" aria-modal="true" aria-labelledby="bulk-delete-title" style={dialogStyle}>
            <div style={dialogHeaderStyle}>
              <h2 id="bulk-delete-title" style={{ margin: 0 }}>{copy.confirmTitle}</h2>
              <button type="button" aria-label={t('common.close')} className="view-toggle" onClick={() => setConfirmBulkDelete(false)} disabled={deleting}><X size={18} /></button>
            </div>
            <p style={{ margin: 0 }}>{copy.confirmMessage(selectedIds.size)}</p>
            <div style={previewRowStyle} aria-hidden="true">
              {selectedPhotos.slice(0, 4).map((photo) => <img key={photo.id} src={`/api/v1/photos/${encodeURIComponent(photo.id)}/thumbnail?size=256`} alt="" style={previewThumbStyle} />)}
              {selectedPhotos.length > 4 && <span style={previewMoreStyle}>+{formatCount(selectedPhotos.length - 4)}</span>}
            </div>
            <div style={dialogActionsStyle}>
              <button type="button" className="button button-secondary" onClick={() => setConfirmBulkDelete(false)} disabled={deleting}>{t('common.cancel')}</button>
              <button type="button" style={bulkDeleteButtonStyle} disabled={deleting} onClick={() => void deleteSelectedPhotos()}>
                {deleting ? <LoaderCircle className="spin" size={17} /> : <Trash2 size={17} />} {deleting ? copy.deleting : t('common.confirmDelete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function EmptyTimeline() {
  const { t } = useI18n();
  return <div className="empty-timeline"><div className="empty-timeline-copy"><span className="eyebrow">{t('gallery.yourFirstRoll')}</span><h2>{t('gallery.bringMemoryIntoView')}</h2><p>{t('gallery.emptyDescription')}</p><button className="button button-primary empty-upload" onClick={openUpload}><ArrowUpRight size={17} /> {t('gallery.uploadFirstPhoto')}</button><span className="empty-note">{t('gallery.supportedStored')}</span></div><div className="empty-mosaic" aria-hidden="true"><div className="memory-card memory-card-back memory-card-sage" /><div className="memory-card memory-card-back memory-card-blush" /><div className="memory-card memory-card-main"><div className="memory-card-image" /><div className="memory-card-caption"><span>{t('gallery.firstMemory')}</span><span>{t('gallery.today')}</span></div></div><span className="memory-stamp">77</span></div></div>;
}

function openUpload() {
  window.history.pushState({}, '', '#/upload');
  window.dispatchEvent(new PopStateEvent('popstate'));
}

type GalleryFilters = { q: string; mediaType: '' | 'photo' | 'video'; folderId: string; fromDate: string; toDate: string; favorite: boolean };
const galleryFilterKey = 'gallery-filters';

function readGalleryFilters(): GalleryFilters {
  const hashQuery = window.location.hash.startsWith('#/gallery?') ? window.location.hash.slice('#/gallery?'.length) : '';
  const params = new URLSearchParams(hashQuery || window.sessionStorage.getItem(galleryFilterKey) || '');
  const media = params.get('media_type');
  return {
    q: params.get('q') || '', mediaType: media === 'photo' || media === 'video' ? media : '',
    folderId: params.get('folder_id') || '', fromDate: validLocalDate(params.get('from')), toDate: validLocalDate(params.get('to')), favorite: params.get('favorite') === 'true',
  };
}

function validLocalDate(value: string | null): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() + 1 === month && parsed.getDate() === day ? value : '';
}

function writeGalleryFilters(filters: GalleryFilters) {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.mediaType) params.set('media_type', filters.mediaType);
  if (filters.folderId) params.set('folder_id', filters.folderId);
  if (filters.fromDate) params.set('from', filters.fromDate);
  if (filters.toDate) params.set('to', filters.toDate);
  if (filters.favorite) params.set('favorite', 'true');
  const query = params.toString();
  window.sessionStorage.setItem(galleryFilterKey, query);
  if (window.location.hash.startsWith('#/gallery')) window.history.replaceState(window.history.state, '', `#/gallery${query ? `?${query}` : ''}`);
}

function localDateBoundary(value: string, nextDay = false): string {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day + (nextDay ? 1 : 0)).toISOString();
}

async function loadVisibleFolders(api: ApiClient): Promise<Folder[]> {
  const root = (await api.listFolders()).items;
  const shares = typeof api.listShares === 'function' ? await api.listShares().catch(() => ({ items: [] })) : { items: [] };
  const shared = await Promise.all(shares.items.map((share) => api.getFolder(share.resource_id).catch(() => null)));
  const seen = new Set<string>();
  const pending = [...root, ...shared.filter((folder): folder is Folder => folder !== null)];
  const items: Folder[] = [];
  while (pending.length) {
    const folder = pending.shift()!;
    if (seen.has(folder.id)) continue;
    seen.add(folder.id);
    items.push(folder);
    pending.push(...(await api.listFolders(folder.id)).items);
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

async function deleteIndividually(api: ApiClient, ids: string[]) {
  const deleted_ids: string[] = [];
  const failed: Array<{ id: string; code: string }> = [];
  for (const id of ids) {
    try {
      await api.deletePhoto(id);
      deleted_ids.push(id);
    } catch {
      failed.push({ id, code: 'REQUEST_FAILED' });
    }
  }
  return { deleted_ids, failed };
}

function gallerySelectionCopy(locale: 'zh' | 'en', formatCount: (value: number) => string) {
  if (locale === 'zh') {
    return {
      select: '选择',
      cancel: '取消选择',
      selectDay: '选择当天',
      clearDay: '取消当天',
      selectPhoto: '选择照片',
      deselectPhoto: '取消选择照片',
      selected: (count: number) => `已选择 ${formatCount(count)} 张`,
      deleteSelected: (count: number) => `删除 ${formatCount(count)} 张`,
      confirmTitle: '删除选中的照片？',
      confirmMessage: (count: number) => `将 ${formatCount(count)} 张照片移入回收站，可在到期前恢复。`,
      deleting: '正在删除…',
      deleteFailed: '无法删除所选照片，请重试。',
      partialFailure: (count: number) => `有 ${formatCount(count)} 张照片删除失败，已保留选中状态。`,
    };
  }
  return {
    select: 'Select',
    cancel: 'Cancel selection',
    selectDay: 'Select day',
    clearDay: 'Clear day',
    selectPhoto: 'Select photo',
    deselectPhoto: 'Deselect photo',
    selected: (count: number) => `${formatCount(count)} selected`,
    deleteSelected: (count: number) => `Delete ${formatCount(count)}`,
    confirmTitle: 'Delete selected photos?',
    confirmMessage: (count: number) => `${formatCount(count)} photos will move to trash and can be restored before expiry.`,
    deleting: 'Deleting…',
    deleteFailed: 'Unable to delete the selected photos. Try again.',
    partialFailure: (count: number) => `${formatCount(count)} photos could not be deleted and remain selected.`,
  };
}

const bulkBarStyle: CSSProperties = { position: 'sticky', bottom: 18, zIndex: 20, margin: '18px auto 0', width: 'fit-content', maxWidth: 'calc(100% - 24px)', display: 'flex', alignItems: 'center', gap: 18, padding: '10px 12px 10px 18px', borderRadius: 999, background: 'rgba(255,255,255,.96)', boxShadow: '0 12px 40px rgba(20,24,30,.18)', backdropFilter: 'blur(16px)' };
const bulkDeleteButtonStyle: CSSProperties = { border: 0, borderRadius: 999, padding: '10px 16px', background: '#9f2f27', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, font: 'inherit', fontWeight: 700, cursor: 'pointer' };
const dialogBackdropStyle: CSSProperties = { position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(20,24,30,.46)', display: 'grid', placeItems: 'center', padding: 20 };
const dialogStyle: CSSProperties = { width: 'min(460px, 100%)', borderRadius: 22, background: '#fff', padding: 22, display: 'grid', gap: 18, boxShadow: '0 24px 80px rgba(0,0,0,.24)' };
const dialogHeaderStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 };
const dialogActionsStyle: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' };
const previewRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minHeight: 58 };
const previewThumbStyle: CSSProperties = { width: 58, height: 58, borderRadius: 10, objectFit: 'cover', background: '#eee' };
const previewMoreStyle: CSSProperties = { width: 58, height: 58, borderRadius: 10, display: 'grid', placeItems: 'center', background: '#f1f1ef', fontWeight: 700 };
