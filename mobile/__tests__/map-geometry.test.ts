import {PhotoClusters, normalizeBBox, placeBBox, toLocatedPhotos, yearRange} from '../src/map/clusters';
import {fitPhotos, project, tileURL, unproject, viewBounds, zoomLimits} from '../src/map/geometry';
const photos = toLocatedPhotos([
  ['a', 31.23, 121.47, '2026-01-01T00:00:00Z'], ['b', 31.23, 121.47, '2025-01-01T00:00:00Z'],
  ['c', -17, 179.9, '2024-01-01T00:00:00Z'], ['d', -17, -179.9, '2024-01-02T00:00:00Z'],
]);

test('Mercator projection roundtrips locations and keeps poles finite', () => {
  const point = project(31.23, 121.47, 16);
  const position = unproject(point.x, point.y, 16);
  expect(position.lat).toBeCloseTo(31.23, 7); expect(position.lng).toBeCloseTo(121.47, 7);
  expect(Number.isFinite(project(90, 0, 18).y)).toBe(true);
  expect(Number.isFinite(project(-90, 0, 18).y)).toBe(true);
});

test('fits the shortest longitude arc across the date line and emits wrapping API boxes', () => {
  const view = fitPhotos(photos.slice(2), {width: 360, height: 300});
  expect(Math.abs(view.lng)).toBeCloseTo(180, 1); expect(view.zoom).toBeGreaterThan(5);
  const bbox = viewBounds(view, {width: 360, height: 300});
  expect(bbox[0]).toBeGreaterThan(bbox[2]);
  expect(normalizeBBox(-400, -90, 400, 90)).toEqual([-180, -90, 180, 90]);
});

test('wraps tile columns, substitutes all provider fields and respects zoom limits', () => {
  expect(tileURL({url: 'https://t{s}.test/{z}/{x}/{y}', subdomains: '0123'}, -1, 2, 3)).toBe('https://t1.test/3/7/2');
  expect(zoomLimits({enabled: true, min_zoom: 2, max_zoom: 17})).toEqual({min: 2, max: 17});
  expect(yearRange(2026)).toEqual({from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z'});
});

test('co-located photos stay clustered, use their newest cover and widen rounded coordinates', () => {
  const clusters = new PhotoClusters(photos, 18);
  const spec = clusters.markers([121, 31, 122, 32], 18, 121)[0];
  expect(spec.count).toBe(2); expect(spec.coverId).toBe('a'); expect(clusters.expansionZoom(spec.clusterId!)).toBeGreaterThan(18);
  expect(clusters.leaves(spec.clusterId!).map(item => item.id).sort()).toEqual(['a', 'b']);
  expect(placeBBox(photos.slice(0, 2))).toEqual([121.469999, 31.229999, 121.470001, 31.230001]);
});

test('fits a large point set without overflowing JavaScript argument limits', () => {
  const points = Array.from({length: 150000}, (_, index) => ({id: String(index), lat: index % 80, lng: index % 180, capturedAt: ''}));
  expect(Number.isFinite(fitPhotos(points, {width: 400, height: 300}).zoom)).toBe(true);
});
