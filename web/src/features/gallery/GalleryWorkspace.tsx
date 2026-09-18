import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowUpRight, Check, CirclePlay, LoaderCircle, RefreshCw, Trash2, X } from 'lucide-react';
import { useI18n } from '../../app/I18nProvider';
import type { ApiClient, Photo } from '../../app/api';
import Viewer from '../viewer/Viewer';
import { GallerySkeleton } from '../loading/LoadingStates';

export default function GalleryWorkspace({ api }: { api: ApiClient }) {
  const { t, formatCount, locale } = useI18n();
  const [photos, setPhotos] = useState<Photo[]>([]);
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
  const copy = useMemo(() => gallerySelectionCopy(locale, formatCount), [locale, formatCount]);

  const load = useCallback(async (nextCursor?: string) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setError(null);
    nextCursor ? setLoadingMore(true) : setLoading(true);
    try {
      const page = await api.listPhotos({ cursor: nextCursor, limit: 50 });
      setPhotos((current) => nextCursor ? [...current, ...page.items] : page.items);
      setCursor(page.next_cursor);
    } catch {
      setError(t('gallery.loadFailed'));
    } finally {
      loadingRef.current = false;
      setLoading(false);
      setLoadingMore(false);
    }
  }, [api, t]);

  useEffect(() => { void load(); }, [load]);

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
          <span className="gallery-count">{selectionMode ? copy.selected(selectedIds.size) : photos.length ? t('gallery.loaded', { count: formatCount(photos.length) }) : t('gallery.noPhotosYet')}</span>
          {selectionMode ? (
            <button className="button button-secondary" type="button" onClick={exitSelectionMode}>{copy.cancel}</button>
          ) : (
            <>
              {photos.length > 0 && <button className="button button-secondary" type="button" onClick={enterSelectionMode}>{copy.select}</button>}
              <button className="view-toggle" aria-label={t('gallery.refresh')} onClick={() => void load()}><RefreshCw size={18} /></button>
            </>
          )}
        </div>
      </div>
      <div className="filter-row" aria-label={t('gallery.filters')}><button type="button" className="filter-chip is-active">{t('gallery.allPhotos')}</button><span className="filter-hint">{photos.length ? t('gallery.privateByDefault') : t('gallery.yourPrivateLibrary')}</span></div>
      {bulkError && <div className="inline-state" role="alert">{bulkError}</div>}
      {loading && <GallerySkeleton />}
      {!loading && error && <div className="inline-state" role="alert">{error}<button className="button button-secondary" onClick={() => void load()}>{t('common.retry')}</button></div>}
      {!loading && !error && photos.length === 0 && <EmptyTimeline />}
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
      {selected !== null && !selectionMode && <Viewer api={api} photos={photos} selected={selected} onClose={() => setSelected(null)} onDeleted={(id) => setPhotos((current) => current.filter((photo) => photo.id !== id))} onUpdated={(photo) => setPhotos((current) => current.map((item) => item.id === photo.id ? photo : item))} />}

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

function TimelineGroup({ date, photos, selectionMode, selectedIds, selectDayLabel, selectedLabel, deselectedLabel, onToggleDay, onToggle, onSelect }: {
  date: string;
  photos: Photo[];
  selectionMode: boolean;
  selectedIds: Set<string>;
  selectDayLabel: string;
  selectedLabel: string;
  deselectedLabel: string;
  onToggleDay: () => void;
  onToggle: (id: string) => void;
  onSelect: (photo: Photo) => void;
}) {
  const { t, formatCount, formatCalendarDate } = useI18n();
  return (
    <div className="timeline-group">
      <div className="date-heading">
        <h2>{formatCalendarDate(date)}</h2>
        <div style={dateActionsStyle}>
          <span>{photos.length === 1 ? t('gallery.onePhoto', { count: formatCount(photos.length) }) : t('gallery.manyPhotos', { count: formatCount(photos.length) })}</span>
          {selectionMode && <button type="button" className="button button-secondary" style={daySelectButtonStyle} onClick={onToggleDay}>{selectDayLabel}</button>}
        </div>
      </div>
      <div className="photo-grid">
        {photos.map((photo) => (
          <PhotoTile
            key={photo.id}
            photo={photo}
            selectionMode={selectionMode}
            selected={selectedIds.has(photo.id)}
            onToggle={onToggle}
            onSelect={onSelect}
            selectedLabel={selectedLabel}
            deselectedLabel={deselectedLabel}
          />
        ))}
      </div>
    </div>
  );
}

function PhotoTile({ photo, selectionMode, selected, onToggle, onSelect, selectedLabel, deselectedLabel }: {
  photo: Photo;
  selectionMode: boolean;
  selected: boolean;
  onToggle: (id: string) => void;
  onSelect: (photo: Photo) => void;
  selectedLabel: string;
  deselectedLabel: string;
}) {
  const { t } = useI18n();
  const [previewMode, setPreviewMode] = useState<'thumbnail' | 'original' | 'failed'>('thumbnail');
  const [thumbnailAttempt, setThumbnailAttempt] = useState(0);
  const retryTimer = useRef<number | null>(null);
  const failed = previewMode === 'failed';
  const previewSource = previewMode === 'original'
    ? `/api/v1/photos/${encodeURIComponent(photo.id)}/original`
    : `/api/v1/photos/${encodeURIComponent(photo.id)}/thumbnail?size=256&retry=${thumbnailAttempt}`;

  useEffect(() => () => {
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
  }, []);

  function handlePreviewError() {
    if (previewMode === 'thumbnail') {
      if (thumbnailAttempt < thumbnailRetryLimit) {
        if (retryTimer.current === null) {
          retryTimer.current = window.setTimeout(() => {
            retryTimer.current = null;
            setThumbnailAttempt((attempt) => attempt + 1);
          }, thumbnailRetryDelayMS);
        }
        return;
      }
      setPreviewMode('original');
      return;
    }
    if (previewMode === 'original') setPreviewMode('failed');
  }

  const activate = () => selectionMode ? onToggle(photo.id) : onSelect(photo);
  return (
    <figure
      className="photo-tile"
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate();
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={selectionMode ? `${selected ? deselectedLabel : selectedLabel}: ${photo.filename}` : photo.filename}
      aria-pressed={selectionMode ? selected : undefined}
    >
      <div className={`photo-frame ${failed ? 'is-failed' : ''}`} style={selectionMode && selected ? selectedFrameStyle : undefined}>
        {failed ? <span>{t('gallery.previewPending')}</span> : <img src={previewSource} alt={photo.filename} loading="lazy" onError={handlePreviewError} />}
        {photo.is_live_photo && !failed && <span title="Live Photo" style={{ position: 'absolute', left: 9, top: 9, display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 999, padding: '5px 7px', background: 'rgba(32,37,45,.72)', color: '#fff', fontSize: 9, fontWeight: 700, letterSpacing: '.08em', pointerEvents: 'none' }}><CirclePlay size={12} /> LIVE</span>}
        {selectionMode && <span style={{ ...selectionBadgeStyle, ...(selected ? selectedBadgeStyle : {}) }} aria-hidden="true">{selected && <Check size={14} />}</span>}
      </div>
      <figcaption>{photo.filename}</figcaption>
    </figure>
  );
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

function groupByDate(photos: Photo[]): Array<[string, Photo[]]> {
  const groups = new Map<string, Photo[]>();
  for (const photo of photos) {
    const date = photo.captured_at.slice(0, 10);
    const current = groups.get(date) ?? [];
    current.push(photo);
    groups.set(date, current);
  }
  return [...groups.entries()];
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
      confirmMessage: (count: number) => `将永久删除 ${formatCount(count)} 张照片，此操作无法撤销。`,
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
    confirmMessage: (count: number) => `${formatCount(count)} photos will be permanently deleted. This cannot be undone.`,
    deleting: 'Deleting…',
    deleteFailed: 'Unable to delete the selected photos. Try again.',
    partialFailure: (count: number) => `${formatCount(count)} photos could not be deleted and remain selected.`,
  };
}

const thumbnailRetryLimit = 2;
const thumbnailRetryDelayMS = 1000;

const selectionBadgeStyle: CSSProperties = {
  position: 'absolute',
  right: 9,
  top: 9,
  width: 24,
  height: 24,
  borderRadius: '50%',
  border: '2px solid rgba(255,255,255,.95)',
  background: 'rgba(32,37,45,.42)',
  color: '#fff',
  display: 'grid',
  placeItems: 'center',
  boxShadow: '0 1px 5px rgba(0,0,0,.22)',
  pointerEvents: 'none',
};

const selectedBadgeStyle: CSSProperties = { background: '#20252d' };
const selectedFrameStyle: CSSProperties = { boxShadow: 'inset 0 0 0 3px #20252d' };
const dateActionsStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10 };
const daySelectButtonStyle: CSSProperties = { padding: '6px 10px', minHeight: 0, fontSize: 12 };
const bulkBarStyle: CSSProperties = { position: 'sticky', bottom: 18, zIndex: 20, margin: '18px auto 0', width: 'fit-content', maxWidth: 'calc(100% - 24px)', display: 'flex', alignItems: 'center', gap: 18, padding: '10px 12px 10px 18px', borderRadius: 999, background: 'rgba(255,255,255,.96)', boxShadow: '0 12px 40px rgba(20,24,30,.18)', backdropFilter: 'blur(16px)' };
const bulkDeleteButtonStyle: CSSProperties = { border: 0, borderRadius: 999, padding: '10px 16px', background: '#9f2f27', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, font: 'inherit', fontWeight: 700, cursor: 'pointer' };
const dialogBackdropStyle: CSSProperties = { position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(20,24,30,.46)', display: 'grid', placeItems: 'center', padding: 20 };
const dialogStyle: CSSProperties = { width: 'min(460px, 100%)', borderRadius: 22, background: '#fff', padding: 22, display: 'grid', gap: 18, boxShadow: '0 24px 80px rgba(0,0,0,.24)' };
const dialogHeaderStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 };
const dialogActionsStyle: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' };
const previewRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minHeight: 58 };
const previewThumbStyle: CSSProperties = { width: 58, height: 58, borderRadius: 10, objectFit: 'cover', background: '#eee' };
const previewMoreStyle: CSSProperties = { width: 58, height: 58, borderRadius: 10, display: 'grid', placeItems: 'center', background: '#f1f1ef', fontWeight: 700 };
