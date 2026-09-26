import { describe, expect, it } from 'vitest';
import { mapFocusHash, readMapFocus, readPublicShareToken, readView } from './routes';

describe('hash routes', () => {
  it('accepts only a complete public share route', () => {
    expect(readPublicShareToken('#/share/sl_abc')).toBe('sl_abc');
    expect(readPublicShareToken('#/gallery')).toBeNull();
    expect(readPublicShareToken('#/share/')).toBeNull();
    expect(readPublicShareToken('#/share/sl_abc/photos')).toBeNull();
  });

  it('falls back from the removed sharing route to the gallery', () => {
    expect(readView('#/sharing')).toBe('gallery');
  });

  it('reads the map view with or without a focus position', () => {
    expect(readView('#/map')).toBe('map');
    expect(readView('#/map?lat=31.2&lng=121.4&z=16')).toBe('map');
    expect(readMapFocus('#/map?lat=31.230416&lng=121.473701&z=15')).toEqual({ lat: 31.230416, lng: 121.473701, zoom: 15 });
    expect(readMapFocus('#/map?lat=-33.8&lng=151.2')).toEqual({ lat: -33.8, lng: 151.2, zoom: 16 });
    expect(readMapFocus('#/map?lat=10&lng=20&z=40')).toEqual({ lat: 10, lng: 20, zoom: 18 });
  });

  it('ignores missing or impossible map focus positions', () => {
    for (const hash of ['#/map', '#/gallery?lat=1&lng=2', '#/map?lat=91&lng=0', '#/map?lat=0&lng=-181', '#/map?lat=&lng=2', '#/map?lat=abc&lng=2', '#/map?lng=2']) {
      expect(readMapFocus(hash)).toBeNull();
    }
  });

  it('builds a map link that reads back to the same position', () => {
    const hash = mapFocusHash({ lat: 31.2304164, lng: -121.4737, zoom: 16 });
    expect(hash).toBe('#/map?lat=31.230416&lng=-121.473700&z=16');
    expect(readMapFocus(hash)).toEqual({ lat: 31.230416, lng: -121.4737, zoom: 16 });
  });

  it('keeps upload retry while removing the redundant start action', () => {
    const sources = import.meta.glob('../features/upload/UploadWorkspace.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    const source = Object.values(sources)[0] ?? '';
    expect(source).not.toContain('Start upload');
    expect(source).toContain("t('common.retry')");
  });
});
