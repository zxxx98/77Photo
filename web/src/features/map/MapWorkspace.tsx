import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronUp, LoaderCircle, MapPinned, RefreshCw, Settings } from 'lucide-react';
import { useI18n } from '../../app/I18nProvider';
import type { ApiClient, BBox, MapConfig, Photo, User } from '../../app/api';
import { readMapFocus } from '../../app/routes';
import Viewer from '../viewer/Viewer';
import { TimelineGroup, groupByMonth } from '../gallery/PhotoGrid';
import { MapSkeleton } from '../loading/LoadingStates';
import { createPhotoMap, type PhotoMap, type Viewport } from './leafletMap';
import {
  PhotoClusters,
  boundsOf,
  countInBBox,
  filterByYear,
  normalizeBBox,
  placeBBox,
  toLocatedPhotos,
  yearRange,
  yearsOf,
  type LocatedPhoto,
  type MarkerSpec,
} from './mapClusters';
import './MapWorkspace.css';

type Scope = { kind: 'area'; bbox: BBox } | { kind: 'place'; bbox: BBox; count: number };

interface PanelState {
  items: Photo[];
  cursor: string | null;
  loading: boolean;
  error: boolean;
}

const emptyPanel: PanelState = { items: [], cursor: null, loading: false, error: false };
const panelPageSize = 50;
const areaDebounceMS = 300;
/** Fitting all photos never zooms closer than a city. */
const fitMaxZoom = 12;
const recentYearCount = 4;
const chinaView = { kind: 'point', lat: 35, lng: 105, zoom: 4 } as const;
const narrowLayoutQuery = '(max-width: 1100px)';

export default function MapWorkspace({ api, currentUser }: { api: ApiClient; currentUser: User }) {
  const { t, locale, formatCount } = useI18n();
  const isAdmin = currentUser.role === 'admin';
  const narrow = useMediaQuery(narrowLayoutQuery);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [config, setConfig] = useState<MapConfig | null>(null);
  const [located, setLocated] = useState<LocatedPhoto[]>([]);
  const [totalPhotos, setTotalPhotos] = useState(0);
  const [year, setYear] = useState<number | null>(null);
  const [map, setMap] = useState<PhotoMap | null>(null);
  const [tilesFailed, setTilesFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope | null>(null);
  const [panel, setPanel] = useState<PanelState>(emptyPanel);
  const [panelAttempt, setPanelAttempt] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [viewer, setViewer] = useState<{ photos: Photo[]; index: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<PhotoMap | null>(null);
  const areaTimer = useRef<number | undefined>(undefined);
  const loadingMore = useRef(false);

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const [nextConfig, points] = await Promise.all([api.getMapConfig(), api.getMapPoints()]);
      setConfig(nextConfig);
      setLocated(toLocatedPhotos(points.items));
      setTotalPhotos(points.total_photos);
      setStatus('ready');
    } catch {
      setStatus('failed');
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => filterByYear(located, year), [located, year]);
  const clusters = useMemo(() => new PhotoClusters(filtered, config?.max_zoom ?? 18), [filtered, config?.max_zoom]);
  const years = useMemo(() => yearsOf(located), [located]);
  const query = useMemo(() => scope && { bbox: scope.bbox, ...(year === null ? {} : yearRange(year)) }, [scope, year]);
  const queryRef = useRef(query);
  queryRef.current = query;
  const formatMonth = useMemo(() => {
    const format = new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'long', timeZone: 'UTC' });
    return (month: string) => format.format(new Date(`${month}-01T00:00:00Z`));
  }, [locale]);
  const compactCount = useMemo(() => {
    const format = new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { notation: 'compact', maximumFractionDigits: 1 });
    return (count: number) => format.format(count);
  }, [locale]);

  function viewportChanged(viewport: Viewport) {
    mapRef.current?.setMarkers(clusters.markers(viewport.bounds, viewport.zoom, viewport.centerLng));
    window.clearTimeout(areaTimer.current);
    areaTimer.current = window.setTimeout(() => {
      const bbox = normalizeBBox(...viewport.bounds);
      setScope((current) => current?.kind === 'area' && sameBBox(current.bbox, bbox) ? current : { kind: 'area', bbox });
    }, areaDebounceMS);
  }

  function markerClicked(spec: MarkerSpec) {
    const instance = mapRef.current;
    if (!instance) return;
    setNotice(null);
    if (spec.clusterId === undefined) {
      void openSingle(spec.coverId);
      return;
    }
    const expansionZoom = clusters.expansionZoom(spec.clusterId);
    const maxZoom = instance.maxZoom();
    if (expansionZoom <= maxZoom && instance.viewport().zoom < maxZoom) {
      instance.setView(spec.lat, spec.lng, expansionZoom);
      return;
    }
    // The photos never separate within the available zoom levels: they were
    // taken at one place, so list them instead of zooming further.
    const leaves = clusters.leaves(spec.clusterId);
    const bbox = placeBBox(leaves);
    if (!bbox) return;
    window.clearTimeout(areaTimer.current);
    setScope({ kind: 'place', bbox, count: leaves.length });
    setDrawerOpen(true);
  }

  function markerLabel(spec: MarkerSpec) {
    return spec.count > 1 ? t('map.photoCount', { count: formatCount(spec.count) }) : t('map.openPhoto');
  }

  // Leaflet keeps the callbacks it was created with; route them to the
  // current render so they always see the latest clusters and translations.
  const handlers = useRef({ viewportChanged, markerClicked, markerLabel });
  handlers.current = { viewportChanged, markerClicked, markerLabel };

  useEffect(() => {
    const container = containerRef.current;
    if (status !== 'ready' || !config?.enabled || !container) return;
    const focus = readMapFocus(window.location.hash);
    const bounds = boundsOf(located);
    const instance = createPhotoMap(container, config, {
      initialView: focus ? { kind: 'point', ...focus } : bounds ? { kind: 'bounds', bounds, maxZoom: fitMaxZoom } : chinaView,
      onViewportChange: (viewport) => handlers.current.viewportChanged(viewport),
      onMarkerClick: (spec) => handlers.current.markerClicked(spec),
      onTilesFailed: () => setTilesFailed(true),
      markerLabel: (spec) => handlers.current.markerLabel(spec),
      formatCount: compactCount,
      zoomInTitle: t('map.zoomIn'),
      zoomOutTitle: t('map.zoomOut'),
    });
    mapRef.current = instance;
    setMap(instance);
    return () => {
      window.clearTimeout(areaTimer.current);
      instance.destroy();
      mapRef.current = null;
      setMap(null);
    };
    // The map is created once per load; later data changes only redraw markers.
  }, [status, config]);

  useEffect(() => {
    if (!map) return;
    const viewport = map.viewport();
    map.setMarkers(clusters.markers(viewport.bounds, viewport.zoom, viewport.centerLng));
  }, [map, clusters]);

  useEffect(() => {
    const showFocus = () => {
      const focus = readMapFocus(window.location.hash);
      if (!focus) return;
      setYear(null);
      mapRef.current?.setView(focus.lat, focus.lng, focus.zoom);
    };
    window.addEventListener('popstate', showFocus);
    return () => window.removeEventListener('popstate', showFocus);
  }, []);

  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    setPanel((current) => ({ ...current, loading: true, error: false }));
    api.listPhotos({ ...query, limit: panelPageSize, signal: controller.signal })
      .then((page) => {
        if (!controller.signal.aborted) setPanel({ items: page.items, cursor: page.next_cursor, loading: false, error: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setPanel((current) => ({ ...current, loading: false, error: true }));
      });
    return () => controller.abort();
  }, [api, query, panelAttempt]);

  const loadMore = useCallback(async () => {
    if (!query || !panel.cursor || loadingMore.current) return;
    loadingMore.current = true;
    try {
      const page = await api.listPhotos({ ...query, cursor: panel.cursor, limit: panelPageSize });
      if (queryRef.current !== query) return;
      setPanel((current) => ({ ...current, items: [...current.items, ...page.items], cursor: page.next_cursor }));
    } catch {
      if (queryRef.current === query) setPanel((current) => ({ ...current, cursor: null, error: true }));
    } finally {
      loadingMore.current = false;
    }
  }, [api, query, panel.cursor]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !panel.cursor || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) void loadMore();
    }, { root: listRef.current, rootMargin: '320px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [panel.cursor, loadMore, narrow, drawerOpen]);

  async function openSingle(id: string) {
    try {
      setViewer({ photos: [await api.getPhoto(id)], index: 0 });
    } catch {
      setNotice(t('map.openFailed'));
    }
  }

  function chooseYear(next: number | null) {
    if (next === year) return;
    setYear(next);
    const instance = mapRef.current;
    if (!instance) return;
    const nextPhotos = filterByYear(located, next);
    const visible = normalizeBBox(...instance.viewport().bounds);
    setScope({ kind: 'area', bbox: visible });
    // Stay put while the view still shows photos from that year.
    if (countInBBox(nextPhotos, visible) > 0) return;
    const bounds = boundsOf(nextPhotos);
    if (bounds) instance.fitBounds(bounds, fitMaxZoom);
  }

  function backToArea() {
    const instance = mapRef.current;
    if (instance) setScope({ kind: 'area', bbox: normalizeBBox(...instance.viewport().bounds) });
  }

  function removePhoto(id: string) {
    setLocated((current) => current.filter((photo) => photo.id !== id));
    setTotalPhotos((count) => Math.max(0, count - 1));
    setPanel((current) => ({ ...current, items: current.items.filter((photo) => photo.id !== id) }));
  }

  function replacePhoto(photo: Photo) {
    const replace = (items: Photo[]) => items.map((item) => item.id === photo.id ? photo : item);
    setPanel((current) => ({ ...current, items: replace(current.items) }));
    setViewer((current) => current && { ...current, photos: replace(current.photos) });
  }

  if (status === 'loading') return <MapSkeleton />;
  if (status === 'failed') {
    return (
      <div className="map-state">
        <div className="inline-state" role="alert">
          {t('map.loadFailed')}
          <button className="button button-secondary" type="button" onClick={() => void load()}><RefreshCw size={16} /> {t('common.retry')}</button>
        </div>
      </div>
    );
  }
  if (!config?.enabled) {
    return (
      <div className="map-state">
        <MapCard title={t('map.disabledTitle')}>
          <p>{isAdmin ? t('map.disabledAdmin') : t('map.disabledMember')}</p>
        </MapCard>
      </div>
    );
  }

  const panelCount = scope?.kind === 'place' ? scope.count : scope ? countInBBox(filtered, scope.bbox) : 0;
  const panelTitle = scope?.kind === 'place'
    ? t('map.atThisPlace', { count: formatCount(panelCount) })
    : t('map.inThisArea', { count: formatCount(panelCount) });
  const coverage = t('map.coverage', { located: formatCount(located.length), total: formatCount(totalPhotos) });
  const openFromPanel = (photo: Photo) => setViewer({ photos: panel.items, index: Math.max(0, panel.items.findIndex((item) => item.id === photo.id)) });
  const panelList = panel.error ? (
    <div className="inline-state" role="alert">
      {t('map.areaFailed')}
      <button className="button button-secondary" type="button" onClick={() => setPanelAttempt((attempt) => attempt + 1)}>{t('common.retry')}</button>
    </div>
  ) : panelCount === 0 && scope ? (
    <p className="map-panel__empty">{t('map.nothingHere')}</p>
  ) : (
    // Months keep an area that spans years readable in a narrow column.
    groupByMonth(panel.items).map(([month, items]) => <TimelineGroup key={month} date={month} heading={formatMonth(month)} photos={items} onSelect={openFromPanel} />)
  );

  return (
    <section className={`map-workspace${located.length === 0 ? ' is-empty' : ''}`} aria-labelledby="map-title">
      <h1 id="map-title" className="sr-only">{t('map.title')}</h1>
      <div className="map-stage">
        <div className="photo-map" ref={containerRef} />
        {years.length > 1 && <YearFilter years={years} selected={year} onSelect={chooseYear} />}
        {(notice || tilesFailed) && (
          <div className="map-banner" role="status">{notice ?? (isAdmin ? t('map.tilesFailedAdmin') : t('map.tilesFailedMember'))}</div>
        )}
        {located.length === 0 && (
          <div className="map-overlay">
            {totalPhotos === 0 ? (
              <MapCard title={t('map.emptyTitle')}><p>{t('map.emptyDescription')}</p></MapCard>
            ) : (
              <MapCard title={t('map.noLocationsTitle')}>
                {isAdmin && <p>{t('map.noLocationsAdmin')}</p>}
                <p>{t('map.noLocationsNote')}</p>
                {isAdmin && <button className="button button-secondary" type="button" onClick={openSettings}><Settings size={16} /> {t('map.openSettings')}</button>}
              </MapCard>
            )}
          </div>
        )}
      </div>

      {located.length > 0 && (
        <aside className={`map-panel${drawerOpen ? ' is-open' : ''}`} aria-labelledby="map-panel-title">
          <header className="map-panel__header">
            {narrow ? (
              <button className="map-panel__toggle" type="button" aria-expanded={drawerOpen} onClick={() => setDrawerOpen((open) => !open)}>
                <span className="map-panel__handle" aria-hidden="true" />
                <span className="map-panel__heading"><strong id="map-panel-title">{panelTitle}</strong><span>{coverage}</span></span>
                <ChevronUp className="map-panel__chevron" size={18} aria-hidden="true" />
                <span className="sr-only">{drawerOpen ? t('map.hidePhotos') : t('map.showPhotos')}</span>
              </button>
            ) : (
              <div className="map-panel__heading"><h2 id="map-panel-title">{panelTitle}</h2><span>{coverage}</span></div>
            )}
            {panel.loading && <LoaderCircle className="spin map-panel__spinner" size={16} aria-hidden="true" />}
            {scope?.kind === 'place' && <button className="button button-secondary map-panel__back" type="button" onClick={backToArea}>{t('map.backToArea')}</button>}
          </header>
          {narrow && !drawerOpen ? (
            <div className="map-panel__strip">
              {panel.error || (panelCount === 0 && scope)
                ? panelList
                : panel.items.slice(0, 16).map((photo) => <StripThumbnail key={photo.id} photo={photo} onOpen={() => openFromPanel(photo)} />)}
            </div>
          ) : (
            <div className="map-panel__list" ref={listRef}>
              {panelList}
              <div ref={sentinelRef} className="map-panel__sentinel" aria-hidden="true" />
            </div>
          )}
        </aside>
      )}

      {viewer && (
        <Viewer
          api={api}
          photos={viewer.photos}
          selected={viewer.index}
          onClose={() => setViewer(null)}
          onDeleted={removePhoto}
          onUpdated={replacePhoto}
        />
      )}
    </section>
  );
}

function YearFilter({ years, selected, onSelect }: { years: number[]; selected: number | null; onSelect: (year: number | null) => void }) {
  const { t } = useI18n();
  const recent = years.slice(0, recentYearCount);
  const older = years.slice(recentYearCount);
  const olderSelected = selected !== null && older.includes(selected);
  return (
    <div className="map-years" role="group" aria-label={t('map.yearFilter')}>
      <button className={`filter-chip${selected === null ? ' is-active' : ''}`} type="button" aria-pressed={selected === null} onClick={() => onSelect(null)}>{t('map.allYears')}</button>
      {recent.map((year) => (
        <button key={year} className={`filter-chip${selected === year ? ' is-active' : ''}`} type="button" aria-pressed={selected === year} onClick={() => onSelect(year)}>{year}</button>
      ))}
      {older.length > 0 && (
        <select
          className={`filter-chip map-years__older${olderSelected ? ' is-active' : ''}`}
          aria-label={t('map.olderYears')}
          value={olderSelected ? String(selected) : ''}
          onChange={(event) => onSelect(Number(event.target.value))}
        >
          <option value="" disabled>{t('map.olderYears')}</option>
          {older.map((year) => <option key={year} value={year}>{year}</option>)}
        </select>
      )}
    </div>
  );
}

function MapCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="map-card">
      <span className="map-card__icon" aria-hidden="true"><MapPinned size={21} strokeWidth={1.7} /></span>
      <h2>{title}</h2>
      {children}
    </div>
  );
}

function StripThumbnail({ photo, onOpen }: { photo: Photo; onOpen: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const retryTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(retryTimer.current), []);
  return (
    <button className="map-strip__item" type="button" aria-label={photo.filename} onClick={onOpen}>
      {!failed && (
        <img
          src={`/api/v1/photos/${encodeURIComponent(photo.id)}/thumbnail?size=256&retry=${attempt}`}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => {
            if (attempt > 0) setFailed(true);
            else retryTimer.current = window.setTimeout(() => setAttempt(1), 1500);
          }}
        />
      )}
    </button>
  );
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}

function sameBBox(a: BBox, b: BBox): boolean {
  return a.every((value, index) => value === b[index]);
}

function openSettings() {
  window.history.pushState({}, '', '#/settings');
  window.dispatchEvent(new PopStateEvent('popstate'));
}
