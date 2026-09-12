import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import type { ApiClient, Photo } from '../../app/api';
import Viewer from '../viewer/Viewer';

export default function GalleryWorkspace({ api }: { api: ApiClient }) {
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
      setError('Unable to load your library. Try again.');
    } finally {
      loadingRef.current = false;
      setLoading(false);
      setLoadingMore(false);
    }
  }, [api]);

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
      <div className="workspace-heading"><div><span className="eyebrow">Your library</span><h1 id="gallery-title">Timeline</h1></div><button className="view-toggle" aria-label="Refresh gallery" onClick={() => void load()}><RefreshCw size={18} /></button></div>
      <div className="filter-row" aria-label="Gallery filters"><span className="filter-chip is-active">All photos</span><span className="filter-hint">{photos.length ? `${photos.length} memories` : 'Private by default'}</span></div>
      {loading && <div className="inline-state"><LoaderCircle className="spin" size={18} /> Loading your library…</div>}
      {!loading && error && <div className="inline-state" role="alert">{error}<button className="button button-secondary" onClick={() => void load()}>Retry</button></div>}
      {!loading && !error && photos.length === 0 && <div className="empty-timeline"><span className="eyebrow">Your library</span><h2>Start with a first memory</h2><p>Upload a photo and it will appear here, grouped by the day it was captured.</p></div>}
      {!loading && !error && groups.map(([date, items]) => <TimelineGroup key={date} date={date} photos={items} onSelect={(photo) => setSelected(photos.findIndex((item) => item.id === photo.id))} />)}
      <div ref={sentinel} className="gallery-sentinel" aria-hidden="true">{loadingMore && <LoaderCircle className="spin" size={18} />}</div>
      {selected !== null && <Viewer api={api} photos={photos} selected={selected} onClose={() => setSelected(null)} onDeleted={(id) => setPhotos((current) => current.filter((photo) => photo.id !== id))} onUpdated={(photo) => setPhotos((current) => current.map((item) => item.id === photo.id ? photo : item))} />}
    </section>
  );
}

function TimelineGroup({ date, photos, onSelect }: { date: string; photos: Photo[]; onSelect: (photo: Photo) => void }) {
  return <div className="timeline-group"><div className="date-heading"><h2>{date}</h2><span>{photos.length} {photos.length === 1 ? 'photo' : 'photos'}</span></div><div className="photo-grid">{photos.map((photo) => <PhotoTile key={photo.id} photo={photo} onSelect={onSelect} />)}</div></div>;
}

function PhotoTile({ photo, onSelect }: { photo: Photo; onSelect: (photo: Photo) => void }) {
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  return <figure className="photo-tile" onClick={() => onSelect(photo)}><div className={`photo-frame ${failed ? 'is-failed' : ''}`}>{failed ? <span>Preview pending</span> : <img src={`/api/v1/photos/${encodeURIComponent(photo.id)}/thumbnail?size=256&retry=${retry}`} alt={photo.filename} loading="lazy" onError={() => { setFailed(true); window.setTimeout(() => { setFailed(false); setRetry((value) => value + 1); }, 1800); }} />}</div><figcaption>{photo.filename}</figcaption></figure>;
}

function groupByDate(photos: Photo[]): Array<[string, Photo[]]> {
  const groups = new Map<string, Photo[]>();
  for (const photo of photos) {
    const date = new Date(photo.captured_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    const current = groups.get(date) ?? [];
    current.push(photo);
    groups.set(date, current);
  }
  return [...groups.entries()];
}
