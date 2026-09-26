import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './leafletMap.css';
import type { BBox, MapConfig } from '../../app/api';
import type { MarkerSpec } from './mapClusters';

export interface Viewport {
  /** Leaflet's bounds as west, south, east, north; longitudes may pass ±180 when the world repeats. */
  bounds: BBox;
  zoom: number;
  centerLng: number;
}

export type InitialView =
  | { kind: 'bounds'; bounds: BBox; maxZoom: number }
  | { kind: 'point'; lat: number; lng: number; zoom: number };

export interface PhotoMapOptions {
  initialView: InitialView;
  onViewportChange: (viewport: Viewport) => void;
  onMarkerClick: (marker: MarkerSpec) => void;
  onTilesFailed: () => void;
  markerLabel: (marker: MarkerSpec) => string;
  formatCount: (count: number) => string;
  zoomInTitle: string;
  zoomOutTitle: string;
}

export interface PhotoMap {
  viewport(): Viewport;
  maxZoom(): number;
  setMarkers(markers: MarkerSpec[]): void;
  fitBounds(bounds: BBox, maxZoom: number): void;
  setView(lat: number, lng: number, zoom: number): void;
  destroy(): void;
}

export interface MiniMap {
  setPosition(lat: number, lng: number): void;
  destroy(): void;
}

const boundsPadding = L.point(48, 48);
/** Consecutive tile failures, with nothing loaded yet, that count as a broken base map. */
const tileFailureThreshold = 4;
const thumbnailRetryDelayMS = 1500;

export function createPhotoMap(container: HTMLElement, config: MapConfig, options: PhotoMapOptions): PhotoMap {
  const map = L.map(container, {
    minZoom: config.min_zoom ?? 1,
    maxZoom: config.max_zoom ?? 18,
    worldCopyJump: true,
    zoomControl: false,
  });
  map.attributionControl.setPrefix(false);
  L.control.zoom({ position: 'topright', zoomInTitle: options.zoomInTitle, zoomOutTitle: options.zoomOutTitle }).addTo(map);
  addTileLayers(map, config, options.onTilesFailed);

  const markerLayer = L.layerGroup().addTo(map);
  let markers = new Map<string, L.Marker>();
  const viewport = (): Viewport => {
    const bounds = map.getBounds();
    return { bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()], zoom: map.getZoom(), centerLng: map.getCenter().lng };
  };
  map.on('moveend', () => options.onViewportChange(viewport()));
  const initial = options.initialView;
  if (initial.kind === 'bounds') fitView(map, initial.bounds, initial.maxZoom, false);
  else map.setView([initial.lat, initial.lng], initial.zoom, { animate: false });

  const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => map.invalidateSize());
  resizeObserver?.observe(container);

  return {
    viewport,
    maxZoom: () => map.getMaxZoom(),
    setMarkers(specs) {
      const next = new Map<string, L.Marker>();
      for (const spec of specs) {
        let marker = markers.get(spec.key);
        if (!marker) {
          marker = L.marker([spec.lat, spec.lng], {
            icon: markerIcon(spec, options.formatCount),
            title: options.markerLabel(spec),
            riseOnHover: true,
            zIndexOffset: spec.thumbnail ? 1000 : 0,
          });
          marker.on('click', () => options.onMarkerClick(spec));
          markerLayer.addLayer(marker);
          marker.getElement()?.setAttribute('aria-label', options.markerLabel(spec));
        }
        next.set(spec.key, marker);
      }
      for (const [key, marker] of markers) {
        if (!next.has(key)) markerLayer.removeLayer(marker);
      }
      markers = next;
    },
    fitBounds: (bounds, maxZoom) => fitView(map, bounds, maxZoom, animationsAllowed()),
    setView: (lat, lng, zoom) => { map.setView([lat, lng], zoom, { animate: animationsAllowed() }); },
    destroy() {
      resizeObserver?.disconnect();
      map.remove();
    },
  };
}

/** A small, non-interactive map centred on one position, used in photo details. */
export function createMiniMap(container: HTMLElement, config: MapConfig, lat: number, lng: number): MiniMap {
  const zoom = Math.min(14, config.max_zoom ?? 18);
  const map = L.map(container, {
    zoomControl: false,
    dragging: false,
    touchZoom: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
  }).setView([lat, lng], zoom);
  map.attributionControl.setPrefix(false);
  addTileLayers(map, config);
  const pin = L.marker([lat, lng], {
    icon: L.divIcon({ className: 'photo-map-pin', iconSize: [18, 18] }),
    interactive: false,
    keyboard: false,
  }).addTo(map);
  return {
    setPosition(nextLat, nextLng) {
      map.setView([nextLat, nextLng], zoom, { animate: false });
      pin.setLatLng([nextLat, nextLng]);
    },
    destroy: () => { map.remove(); },
  };
}

function addTileLayers(map: L.Map, config: MapConfig, onFailure?: () => void) {
  let loaded = 0;
  let failed = 0;
  const attribution = attributionHTML(config);
  for (const layer of config.tile_layers ?? []) {
    const tiles = L.tileLayer(layer.url, {
      subdomains: layer.subdomains,
      minZoom: config.min_zoom ?? 1,
      maxZoom: config.max_zoom ?? 18,
      attribution,
      className: 'photo-map-tiles',
    });
    tiles.on('tileload', () => { loaded += 1; });
    tiles.on('tileerror', () => {
      failed += 1;
      if (loaded === 0 && failed === tileFailureThreshold) onFailure?.();
    });
    tiles.addTo(map);
  }
}

function fitView(map: L.Map, [west, south, east, north]: BBox, maxZoom: number, animate: boolean) {
  map.fitBounds(L.latLngBounds([south, west], [north, east]), { padding: boundsPadding, maxZoom, animate });
}

function markerIcon(spec: MarkerSpec, formatCount: (count: number) => string): L.DivIcon {
  if (!spec.thumbnail) {
    const dot = document.createElement('span');
    dot.className = spec.count > 1 ? 'photo-dot' : 'photo-dot is-single';
    if (spec.count > 1) dot.textContent = formatCount(spec.count);
    const size = spec.count > 1 ? 32 : 16;
    return L.divIcon({ html: dot, className: 'photo-marker photo-marker--dot', iconSize: [size, size] });
  }
  const body = document.createElement('span');
  body.className = 'photo-marker__body';
  const frame = document.createElement('span');
  frame.className = 'photo-marker__frame';
  const image = document.createElement('img');
  image.alt = '';
  image.decoding = 'async';
  image.draggable = false;
  // Pending thumbnails answer 202 without an image; one delayed retry covers
  // the generation queue, after which the frame keeps its placeholder colour.
  let attempt = 0;
  const source = () => `/api/v1/photos/${encodeURIComponent(spec.coverId)}/thumbnail?size=256&retry=${attempt}`;
  image.addEventListener('error', () => {
    if (attempt > 0) {
      frame.classList.add('is-failed');
      return;
    }
    attempt += 1;
    window.setTimeout(() => { image.src = source(); }, thumbnailRetryDelayMS);
  });
  image.src = source();
  frame.append(image);
  body.append(frame);
  if (spec.count > 1) {
    const badge = document.createElement('span');
    badge.className = 'photo-marker__count';
    badge.textContent = formatCount(spec.count);
    body.append(badge);
  }
  return L.divIcon({ html: body, className: 'photo-marker', iconSize: [56, 56] });
}

function attributionHTML(config: MapConfig): string | undefined {
  if (!config.attribution) return undefined;
  const text = escapeHTML(config.attribution);
  return config.attribution_url
    ? `<a href="${escapeHTML(config.attribution_url)}" target="_blank" rel="noopener noreferrer">${text}</a>`
    : text;
}

function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

function animationsAllowed(): boolean {
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
