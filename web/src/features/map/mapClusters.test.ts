import { describe, expect, it } from 'vitest';
import {
  PhotoClusters,
  boundsOf,
  countInBBox,
  filterByYear,
  inBBox,
  normalizeBBox,
  placeBBox,
  toLocatedPhotos,
  yearRange,
  yearsOf,
  type LocatedPhoto,
} from './mapClusters';

const photos: LocatedPhoto[] = toLocatedPhotos([
  ['p_newest', 31.2304, 121.4737, '2026-05-01T00:00:00Z'],
  ['p_shanghai', 31.2305, 121.4738, '2025-04-01T00:00:00Z'],
  ['p_beijing', 39.9042, 116.4074, '2025-03-01T00:00:00Z'],
  ['p_fiji_east', -17.7, 178.1, '2023-02-01T00:00:00Z'],
  ['p_fiji_west', -16.5, -179.9, '2019-01-01T00:00:00Z'],
]);

describe('map geometry', () => {
  it('turns Leaflet bounds into API boxes', () => {
    expect(normalizeBBox(100, 20, 130, 45)).toEqual([100, 20, 130, 45]);
    expect(normalizeBBox(-400, -95, 400, 95)).toEqual([-180, -90, 180, 90]);
    expect(normalizeBBox(170, -20, 190, -10)).toEqual([170, -20, -170, -10]);
    expect(normalizeBBox(-200, 0, -150, 10)).toEqual([160, 0, -150, 10]);
    expect(normalizeBBox(100, 0, 180, 10)).toEqual([100, 0, 180, 10]);
  });

  it('matches the server box predicate across the antimeridian', () => {
    const pacific = normalizeBBox(170, -20, 190, -10);
    expect(photos.filter((photo) => inBBox(photo, pacific)).map((photo) => photo.id)).toEqual(['p_fiji_east', 'p_fiji_west']);
    expect(countInBBox(photos, [121, 31, 122, 32])).toBe(2);
    expect(countInBBox(photos, [-180, -90, 180, 90])).toBe(5);
  });

  it('bounds photos and widens a place by the coordinate rounding', () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf(photos.slice(0, 3))).toEqual([116.4074, 31.2304, 121.4738, 39.9042]);
    const place = placeBBox(photos.slice(0, 1))!;
    expect(place[0]).toBeCloseTo(121.473699, 9);
    expect(place[3]).toBeCloseTo(31.230401, 9);
  });

  it('filters and lists years by UTC capture date', () => {
    expect(yearsOf(photos)).toEqual([2026, 2025, 2023, 2019]);
    expect(filterByYear(photos, 2025).map((photo) => photo.id)).toEqual(['p_shanghai', 'p_beijing']);
    expect(filterByYear(photos, null)).toBe(photos);
    expect(yearRange(2025)).toEqual({ from: '2025-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' });
  });
});

describe('PhotoClusters', () => {
  it('covers a cluster with its newest photo and keeps single photos separate', () => {
    const clusters = new PhotoClusters(photos, 18);
    const markers = clusters.markers([100, 20, 130, 45], 4, 115);
    const shanghai = markers.find((marker) => marker.count === 2)!;
    expect(shanghai.coverId).toBe('p_newest');
    expect(shanghai.clusterId).toBeTypeOf('number');
    const beijing = markers.find((marker) => marker.coverId === 'p_beijing')!;
    expect(beijing.count).toBe(1);
    expect(beijing.clusterId).toBeUndefined();
    expect(clusters.leaves(shanghai.clusterId!).map((photo) => photo.id).sort()).toEqual(['p_newest', 'p_shanghai']);
  });

  it('never separates photos taken at the same place within the map zoom range', () => {
    const clusters = new PhotoClusters(photos, 18);
    const atMaxZoom = clusters.markers([121.47, 31.23, 121.48, 31.24], 18, 121.47);
    expect(atMaxZoom).toHaveLength(1);
    expect(clusters.expansionZoom(atMaxZoom[0].clusterId!)).toBeGreaterThan(18);
  });

  it('limits thumbnails to the largest groups and shifts markers towards the view', () => {
    const clusters = new PhotoClusters(photos, 18);
    const markers = clusters.markers([-180, -85, 180, 85], 3, 180, 1);
    expect(markers.filter((marker) => marker.thumbnail)).toEqual([expect.objectContaining({ count: 2 })]);
    expect(markers.find((marker) => marker.coverId === 'p_fiji_west')?.lng).toBeCloseTo(180.1, 6);
    expect(new Set(markers.map((marker) => marker.key)).size).toBe(markers.length);
  });
});
