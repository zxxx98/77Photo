import type {BBox, MapConfig, MapTileLayer} from '../browse/api';
import {normalizeBBox, type LocatedPhoto} from './clusters';
export type MapView = {lat: number; lng: number; zoom: number};
export type MapFocus = MapView;
export type Size = {width: number; height: number};
const maxLatitude = 85.0511287798066;
export function project(lat: number, lng: number, zoom: number): {x: number; y: number} {
  const scale = 256 * 2 ** zoom;
  const sine = Math.sin(Math.max(-maxLatitude, Math.min(maxLatitude, lat)) * Math.PI / 180);
  return {x: (lng + 180) / 360 * scale, y: (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * scale};
}
export function unproject(x: number, y: number, zoom: number): {lat: number; lng: number} {
  const scale = 256 * 2 ** zoom;
  return {lng: x / scale * 360 - 180, lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * Math.max(0, Math.min(scale, y)) / scale))) * 180 / Math.PI};
}
export function viewBounds(view: MapView, size: Size): BBox {
  const center = project(view.lat, view.lng, view.zoom);
  const sw = unproject(center.x - size.width / 2, center.y + size.height / 2, view.zoom);
  const ne = unproject(center.x + size.width / 2, center.y - size.height / 2, view.zoom);
  const scale = 256 * 2 ** view.zoom;
  return normalizeBBox(sw.lng, center.y + size.height / 2 >= scale ? -90 : sw.lat, ne.lng, center.y - size.height / 2 <= 0 ? 90 : ne.lat);
}
export function fitPhotos(photos: LocatedPhoto[], size: Size, minZoom = 1, maxZoom = 12): MapView {
  if (!photos.length) {return {lat: 35, lng: 105, zoom: Math.max(minZoom, Math.min(maxZoom, 4))};}
  // Use the shortest longitude arc, so photos around ±180 stay together.
  const longitudes = photos.map(photo => (photo.lng + 360) % 360).sort((a, b) => a - b);
  let gap = -1; let start = longitudes[0];
  for (let index = 0; index < longitudes.length; index++) {
    const next = longitudes[(index + 1) % longitudes.length] + (index === longitudes.length - 1 ? 360 : 0);
    if (next - longitudes[index] > gap) {gap = next - longitudes[index]; start = next % 360;}
  }
  let west = Infinity; let east = -Infinity; let south = -Infinity; let north = Infinity;
  for (const photo of photos) {
    const point = project(photo.lat, ((photo.lng + 360) % 360 - start + 360) % 360 + start, 0);
    west = Math.min(west, point.x); east = Math.max(east, point.x);
    south = Math.max(south, point.y); north = Math.min(north, point.y);
  }
  const zoom = Math.max(minZoom, Math.min(maxZoom, Math.floor(Math.log2(Math.min(Math.max(1, size.width - 80) / Math.max(0.000001, east - west), Math.max(1, size.height - 80) / Math.max(0.000001, south - north))))));
  const center = unproject((west + east) / 2, (south + north) / 2, 0);
  center.lng = ((center.lng + 180) % 360 + 360) % 360 - 180;
  return {...center, zoom};
}
export function zoomLimits(config: MapConfig): {min: number; max: number} {
  const min = Math.max(0, Math.min(22, config.min_zoom ?? 1));
  return {min, max: Math.max(min, Math.min(22, config.max_zoom ?? 18))};
}
export function tileURL(layer: MapTileLayer, x: number, y: number, z: number): string {
  const count = 2 ** z; const column = ((x % count) + count) % count;
  const subdomains = layer.subdomains || 'abc';
  return layer.url.replace(/\{([szxy])\}/g, (_, field: string) => String({s: subdomains[(column + y) % subdomains.length], x: column, y, z}[field as 's' | 'x' | 'y' | 'z']));
}
