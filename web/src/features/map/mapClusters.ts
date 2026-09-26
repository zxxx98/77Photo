import Supercluster from 'supercluster';
import type { BBox, MapPoint } from '../../app/api';

export interface LocatedPhoto {
  id: string;
  lat: number;
  lng: number;
  capturedAt: string;
}

/** One marker on the map: a single photo or a cluster, represented by its newest photo. */
export interface MarkerSpec {
  /** Changes whenever anything drawn changes, so markers can be reused by key. */
  key: string;
  lat: number;
  lng: number;
  count: number;
  coverId: string;
  clusterId?: number;
  thumbnail: boolean;
}

export const clusterRadius = 60;
/** Thumbnails beyond this many markers become numbered dots to bound image requests. */
export const thumbnailMarkerLimit = 100;

export function toLocatedPhotos(items: MapPoint[]): LocatedPhoto[] {
  return items.map(([id, lat, lng, capturedAt]) => ({ id, lat, lng, capturedAt }));
}

/** Years use the UTC capture date, like the timeline's day groups. */
export function photoYear(photo: LocatedPhoto): number {
  return Number(photo.capturedAt.slice(0, 4));
}

export function yearsOf(photos: LocatedPhoto[]): number[] {
  return [...new Set(photos.map(photoYear))].filter(Number.isFinite).sort((a, b) => b - a);
}

export function filterByYear(photos: LocatedPhoto[], year: number | null): LocatedPhoto[] {
  return year === null ? photos : photos.filter((photo) => photoYear(photo) === year);
}

export function yearRange(year: number): { from: string; to: string } {
  const pad = (value: number) => String(value).padStart(4, '0');
  return { from: `${pad(year)}-01-01T00:00:00Z`, to: `${pad(year + 1)}-01-01T00:00:00Z` };
}

function wrapLongitude(lng: number): number {
  const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 && lng > 0 ? 180 : wrapped;
}

/**
 * Converts Leaflet bounds, which can extend past ±180 when the world repeats,
 * into the API form. A view wider than the world becomes the whole world.
 */
export function normalizeBBox(west: number, south: number, east: number, north: number): BBox {
  const clampedSouth = Math.max(-90, Math.min(90, south));
  const clampedNorth = Math.max(-90, Math.min(90, north));
  if (east - west >= 360) return [-180, clampedSouth, 180, clampedNorth];
  return [wrapLongitude(west), clampedSouth, wrapLongitude(east), clampedNorth];
}

/** Matches the server's bbox predicate, including boxes that cross the antimeridian. */
export function inBBox(photo: LocatedPhoto, [west, south, east, north]: BBox): boolean {
  if (photo.lat < south || photo.lat > north) return false;
  return west <= east ? photo.lng >= west && photo.lng <= east : photo.lng >= west || photo.lng <= east;
}

export function countInBBox(photos: LocatedPhoto[], bbox: BBox): number {
  let count = 0;
  for (const photo of photos) if (inBBox(photo, bbox)) count += 1;
  return count;
}

export function boundsOf(photos: LocatedPhoto[]): BBox | null {
  if (photos.length === 0) return null;
  let [west, south, east, north] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const photo of photos) {
    west = Math.min(west, photo.lng);
    east = Math.max(east, photo.lng);
    south = Math.min(south, photo.lat);
    north = Math.max(north, photo.lat);
  }
  return [west, south, east, north];
}

/**
 * The box used to list the photos of one place. The API filters on the full
 * stored coordinates while points arrive rounded to six decimals, so the box
 * is widened by one unit of that rounding.
 */
export function placeBBox(photos: LocatedPhoto[]): BBox | null {
  const bounds = boundsOf(photos);
  if (!bounds) return null;
  const [west, south, east, north] = bounds;
  const pad = 1e-6;
  return [Math.max(-180, west - pad), Math.max(-90, south - pad), Math.min(180, east + pad), Math.min(90, north + pad)];
}

type PointProperties = { index: number };
type ClusterProperties = { cover: number };

/** Clusters located photos; each cluster keeps the index of its newest photo as its cover. */
export class PhotoClusters {
  private readonly index: Supercluster<PointProperties, ClusterProperties>;

  constructor(private readonly photos: LocatedPhoto[], maxZoom: number) {
    this.index = new Supercluster<PointProperties, ClusterProperties>({
      radius: clusterRadius,
      maxZoom,
      // Photos arrive newest first, so the smallest index is the newest photo.
      map: (properties) => ({ cover: properties.index }),
      reduce: (accumulated, properties) => {
        if (properties.cover < accumulated.cover) accumulated.cover = properties.cover;
      },
    });
    this.index.load(photos.map((photo, index) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [photo.lng, photo.lat] },
      properties: { index },
    })));
  }

  /**
   * Markers for a Leaflet view. Longitudes are shifted by whole turns towards
   * the view centre so markers stay visible when the view crosses ±180.
   */
  markers(bounds: BBox, zoom: number, centerLng: number, limit = thumbnailMarkerLimit): MarkerSpec[] {
    const specs = this.index.getClusters(bounds, Math.round(zoom)).map((feature): MarkerSpec => {
      const [pointLng, lat] = feature.geometry.coordinates;
      const lng = pointLng + 360 * Math.round((centerLng - pointLng) / 360);
      const properties = feature.properties;
      if ('cluster' in properties && properties.cluster) {
        const cover = this.photos[properties.cover];
        return { key: '', lat, lng, count: properties.point_count, coverId: cover.id, clusterId: properties.cluster_id, thumbnail: false };
      }
      const photo = this.photos[(properties as PointProperties).index];
      return { key: '', lat, lng, count: 1, coverId: photo.id, thumbnail: false };
    });
    [...specs].sort((a, b) => b.count - a.count).slice(0, limit).forEach((spec) => { spec.thumbnail = true; });
    for (const spec of specs) {
      spec.key = [spec.clusterId ?? 'p', spec.coverId, spec.count, spec.thumbnail ? 't' : 'd', spec.lat, spec.lng].join('|');
    }
    return specs;
  }

  expansionZoom(clusterId: number): number {
    return this.index.getClusterExpansionZoom(clusterId);
  }

  leaves(clusterId: number): LocatedPhoto[] {
    return this.index.getLeaves(clusterId, Infinity).map((feature) => this.photos[feature.properties.index]);
  }
}
