export type AppView = 'gallery' | 'folders' | 'map' | 'settings' | 'upload';

const appViews: AppView[] = ['gallery', 'folders', 'map', 'settings', 'upload'];

export interface MapFocus {
  lat: number;
  lng: number;
  zoom: number;
}

export function readPublicShareToken(hash: string): string | null {
  const match = /^#\/share\/([^/]+)$/.exec(hash);
  return match?.[1] ?? null;
}

export function readView(hash: string): AppView {
  const value = hash.replace(/^#\/?/, '').split('?')[0] as AppView;
  return appViews.includes(value) ? value : 'gallery';
}

/** Reads the position a "view on map" link asks the map to show. */
export function readMapFocus(hash: string): MapFocus | null {
  const match = /^#\/map\?(.*)$/.exec(hash);
  if (!match) return null;
  const params = new URLSearchParams(match[1]);
  const lat = coordinate(params.get('lat'));
  const lng = coordinate(params.get('lng'));
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const zoom = coordinate(params.get('z'));
  return { lat, lng, zoom: zoom === null ? 16 : Math.min(18, Math.max(1, Math.round(zoom))) };
}

export function mapFocusHash(focus: MapFocus): string {
  return `#/map?lat=${focus.lat.toFixed(6)}&lng=${focus.lng.toFixed(6)}&z=${focus.zoom}`;
}

function coordinate(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
