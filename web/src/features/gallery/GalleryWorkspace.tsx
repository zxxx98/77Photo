import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, LoaderCircle, RefreshCw } from 'lucide-react';
import { useI18n } from '../../app/I18nProvider';
import type { ApiClient, Photo } from '../../app/api';
import Viewer from '../viewer/Viewer';
import { GallerySkeleton } from '../loading/LoadingStates';

export default function GalleryWorkspace({ api }: { api: ApiClient }) {
  const { t, formatCount } = useI18n();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);

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
  return (
    <section className="gallery-workspace" aria-labelledby="gallery-title">
      <div className="workspace-heading gallery-heading"><div><span className="eyebrow">{t('gallery.yourLibrary')}</span><h1 id="gallery-title">{t('gallery.timeline')}</h1><p className="gallery-intro">{t('gallery.intro')}</p></div><div className="gallery-heading-actions"><span className="gallery-count">{photos.length ? t('gallery.loaded', { count: formatCount(photos.length) }) : t('gallery.noPhotosYet')}</span><button className="view-toggle" aria-label={t('gallery.refresh')} onClick={() => void load()}><RefreshCw size={18} /></button></div></div>
      <div className="filter-row" aria-label={t('gallery.filters')}><button type="button" className="filter-chip is-active">{t('gallery.allPhotos')}</button><span className="filter-hint">{photos.length ? t('gallery.privateByDefault') : t('gallery.yourPrivateLibrary')}</span></div>
      {loading && <GallerySkeleton />}
      {!loading && error && <div className="inline-state" role="alert">{error}<button className="button button-secondary" onClick={() => void load()}>{t('common.retry')}</button></div>}
      {!loading && !error && photos.length === 0 && <EmptyTimeline />}
      {!loading && !error && groups.map(([date, items]) => <TimelineGroup key={date} date={date} photos={items} onSelect={(photo) => setSelected(photos.findIndex((item) => item.id === photo.id))} />)}
      <div ref={sentinel} className="gallery-sentinel" aria-hidden="true">{loadingMore && <LoaderCircle className="spin" size={18} />}</div>
      {selected !== null && <Viewer api={api} photos={photos} selected={selected} onClose={() => setSelected(null)} onDeleted={(id) => setPhotos((current) => current.filter((photo) => photo.id !== id))} onUpdated={(photo) => setPhotos((current) => current.map((item) => item.id === photo.id ? photo : item))} />}
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

function TimelineGroup({ date, photos, onSelect }: { date: string; photos: Photo[]; onSelect: (photo: Photo) => void }) {
  const { t, formatCount, formatCalendarDate } = useI18n();
  return <div className="timeline-group"><div className="date-heading"><h2>{formatCalendarDate(date)}</h2><span>{photos.length === 1 ? t('gallery.onePhoto', { count: formatCount(photos.length) }) : t('gallery.manyPhotos', { count: formatCount(photos.length) })}</span></div><div className="photo-grid">{photos.map((photo) => <PhotoTile key={photo.id} photo={photo} onSelect={onSelect} />)}</div></div>;
}

function PhotoTile({ photo, onSelect }: { photo: Photo; onSelect: (photo: Photo) => void }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  return <figure className="photo-tile" onClick={() => onSelect(photo)}><div className={`photo-frame ${failed ? 'is-failed' : ''}`}>{failed ? <span>{t('gallery.previewPending')}</span> : <img src={`/api/v1/photos/${encodeURIComponent(photo.id)}/thumbnail?size=256&retry=${retry}`} alt={photo.filename} loading="lazy" onError={() => { setFailed(true); window.setTimeout(() => { setFailed(false); setRetry((value) => value + 1); }, 1800); }} />}</div><figcaption>{photo.filename}</figcaption></figure>;
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
