// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, MapConfig, MapPoints, Photo, User } from '../../app/api';
import { I18nProvider } from '../../app/I18nProvider';
import { translate, type TranslationKey, type TranslationParams } from '../../app/i18n';
import type { PhotoMapOptions, Viewport } from './leafletMap';
import type { MarkerSpec } from './mapClusters';
import MapWorkspace from './MapWorkspace';

const fakeMap = vi.hoisted(() => ({
  options: null as PhotoMapOptions | null,
  viewport: { bounds: [121, 31, 122, 32], zoom: 10, centerLng: 121.5 } as Viewport,
  markers: [] as MarkerSpec[],
  created: 0,
  setView: vi.fn(),
  fitBounds: vi.fn(),
}));

vi.mock('./leafletMap', () => ({
  createPhotoMap: (_container: HTMLElement, _config: MapConfig, options: PhotoMapOptions) => {
    fakeMap.options = options;
    fakeMap.created += 1;
    return {
      viewport: () => fakeMap.viewport,
      maxZoom: () => 18,
      setMarkers: (markers: MarkerSpec[]) => { fakeMap.markers = markers; },
      fitBounds: fakeMap.fitBounds,
      setView: fakeMap.setView,
      destroy: vi.fn(),
    };
  },
}));

const zh = (key: TranslationKey, params?: TranslationParams) => translate('zh', key, params);
const admin: User = { id: 'u_admin', username: 'owner', role: 'admin', is_active: true };
const member: User = { id: 'u_member', username: 'member', role: 'user', is_active: true };
const enabled: MapConfig = { enabled: true, provider: 'tianditu', tile_layers: [], min_zoom: 1, max_zoom: 18 };

// Three photos taken at one spot in Shanghai, one in Pudong a few kilometres
// away and one in Beijing; newest first, as the server sends them.
const points: MapPoints = {
  items: [
    ['p_bund_1', 31.2304, 121.4737, '2026-05-01T10:00:00Z'],
    ['p_bund_2', 31.23041, 121.47371, '2025-06-01T10:00:00Z'],
    ['p_bund_3', 31.23042, 121.47372, '2025-05-01T10:00:00Z'],
    ['p_pudong', 31.2397, 121.4998, '2025-04-01T10:00:00Z'],
    ['p_beijing', 39.9042, 116.4074, '2024-03-01T10:00:00Z'],
  ],
  total_photos: 9,
};

function photo(id: string, captured: string): Photo {
  return { id, owner_id: 'u_admin', folder_id: 'f_1', filename: `${id}.jpg`, mime_type: 'image/jpeg', size: 100, captured_at: captured, captured_at_source: 'exif', gps_latitude: 31.23, gps_longitude: 121.47 };
}

function mockApi(overrides: Record<string, unknown> = {}) {
  return {
    getMapConfig: vi.fn().mockResolvedValue(enabled),
    getMapPoints: vi.fn().mockResolvedValue(points),
    listPhotos: vi.fn().mockResolvedValue({ items: [photo('p_bund_1', '2026-05-01T10:00:00Z'), photo('p_bund_2', '2025-06-01T10:00:00Z')], next_cursor: null }),
    getPhoto: vi.fn().mockResolvedValue(photo('p_beijing', '2024-03-01T10:00:00Z')),
    listFolders: vi.fn().mockResolvedValue({ items: [] }),
    getFolder: vi.fn().mockResolvedValue({ id: 'f_1', name: 'Family', owner_id: 'u_admin', parent_id: null, is_shared: false }),
    ...overrides,
  };
}

describe('MapWorkspace', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    window.localStorage.clear();
    window.history.replaceState({}, '', '#/map');
    Object.assign(fakeMap, { options: null, viewport: { bounds: [121, 31, 122, 32], zoom: 10, centerLng: 121.5 }, markers: [], created: 0 });
    fakeMap.setView.mockReset();
    fakeMap.fitBounds.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  async function flush() {
    await act(async () => {
      for (let step = 0; step < 6; step += 1) await Promise.resolve();
    });
  }

  async function render(api: ReturnType<typeof mockApi>, user: User = admin) {
    await act(async () => {
      root.render(<I18nProvider><MapWorkspace api={api as unknown as ApiClient} currentUser={user} /></I18nProvider>);
    });
    await flush();
  }

  async function moveTo(viewport: Viewport) {
    fakeMap.viewport = viewport;
    await act(async () => {
      fakeMap.options!.onViewportChange(viewport);
      vi.advanceTimersByTime(300);
    });
    await flush();
  }

  function button(label: string) {
    return [...container.querySelectorAll('button')].find((element) => element.textContent?.trim() === label);
  }

  it('explains how to turn the map on without creating it', async () => {
    const api = mockApi({ getMapConfig: vi.fn().mockResolvedValue({ enabled: false }) });
    await render(api);
    expect(container.textContent).toContain(zh('map.disabledTitle'));
    expect(container.textContent).toContain('PHOTO_MAP_TIANDITU_KEY');
    expect(fakeMap.created).toBe(0);

    act(() => root.unmount());
    root = createRoot(container);
    await render(api, member);
    expect(container.textContent).toContain(zh('map.disabledMember'));
    expect(container.textContent).not.toContain('PHOTO_MAP_TIANDITU_KEY');
  });

  it('asks the administrator to rescan when no photo has a location yet', async () => {
    await render(mockApi({ getMapPoints: vi.fn().mockResolvedValue({ items: [], total_photos: 12 }) }));
    expect(fakeMap.created).toBe(1);
    expect(fakeMap.options?.initialView).toEqual({ kind: 'point', lat: 35, lng: 105, zoom: 4 });
    expect(container.textContent).toContain(zh('map.noLocationsAdmin'));
    expect(container.querySelector('.map-panel')).toBeNull();

    await act(async () => button(zh('map.openSettings'))?.click());
    expect(window.location.hash).toBe('#/settings');
  });

  it('shows a retry when the points cannot load', async () => {
    const api = mockApi({ getMapPoints: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(points) });
    await render(api);
    expect(container.textContent).toContain(zh('map.loadFailed'));
    await act(async () => button(zh('common.retry'))?.click());
    await flush();
    expect(fakeMap.created).toBe(1);
  });

  it('fits all photos, clusters them under the newest photo and lists the visible area', async () => {
    const api = mockApi();
    await render(api);
    expect(fakeMap.options?.initialView).toEqual({ kind: 'bounds', bounds: [116.4074, 31.2304, 121.4998, 39.9042], maxZoom: 12 });
    await moveTo({ bounds: [121, 31, 122, 32], zoom: 10, centerLng: 121.5 });

    expect(fakeMap.markers).toHaveLength(1);
    expect(fakeMap.markers[0]).toMatchObject({ count: 4, coverId: 'p_bund_1', thumbnail: true });
    expect(api.listPhotos).toHaveBeenLastCalledWith(expect.objectContaining({ bbox: [121, 31, 122, 32], limit: 50, signal: expect.any(AbortSignal) }));
    expect(container.querySelector('#map-panel-title')?.textContent).toBe(zh('map.inThisArea', { count: '4' }));
    expect(container.textContent).toContain(zh('map.coverage', { located: '5', total: '9' }));
    expect(container.querySelectorAll('.map-panel .photo-tile')).toHaveLength(2);

    await act(async () => (container.querySelector('.map-panel .photo-tile') as HTMLElement).click());
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(zh('viewer.detailsFor', { name: 'p_bund_1.jpg' }));
  });

  it('zooms into clusters that can split and lists places that cannot', async () => {
    const api = mockApi();
    await render(api);
    await moveTo({ bounds: [121, 31, 122, 32], zoom: 5, centerLng: 121.5 });
    await act(async () => fakeMap.options!.onMarkerClick(fakeMap.markers[0]));
    expect(fakeMap.setView).toHaveBeenCalledWith(expect.closeTo(31.23, 1), expect.closeTo(121.48, 1), expect.any(Number));
    expect(fakeMap.setView.mock.calls[0][2]).toBeGreaterThan(5);

    await moveTo({ bounds: [121.4736, 31.2303, 121.4738, 31.2305], zoom: 18, centerLng: 121.4737 });
    const bund = fakeMap.markers.find((marker) => marker.count === 3)!;
    await act(async () => fakeMap.options!.onMarkerClick(bund));
    await flush();
    expect(container.querySelector('#map-panel-title')?.textContent).toBe(zh('map.atThisPlace', { count: '3' }));
    const [west, south, east, north] = api.listPhotos.mock.lastCall![0].bbox;
    expect(east - west).toBeLessThan(0.0001);
    expect(north - south).toBeLessThan(0.0001);

    await act(async () => button(zh('map.backToArea'))?.click());
    await flush();
    expect(container.querySelector('#map-panel-title')?.textContent).toBe(zh('map.inThisArea', { count: '3' }));
  });

  it('opens a single photo marker in the viewer', async () => {
    const api = mockApi();
    await render(api);
    await moveTo({ bounds: [116, 39, 117, 40], zoom: 10, centerLng: 116.5 });
    await act(async () => fakeMap.options!.onMarkerClick(fakeMap.markers[0]));
    await flush();
    expect(api.getPhoto).toHaveBeenCalledWith('p_beijing');
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('filters by year and only moves the map when the view has none of those photos', async () => {
    const api = mockApi();
    await render(api);
    await moveTo({ bounds: [121, 31, 122, 32], zoom: 10, centerLng: 121.5 });

    await act(async () => button('2025')?.click());
    await flush();
    expect(fakeMap.fitBounds).not.toHaveBeenCalled();
    expect(fakeMap.markers[0]).toMatchObject({ count: 3, coverId: 'p_bund_2' });
    expect(api.listPhotos).toHaveBeenLastCalledWith(expect.objectContaining({ from: '2025-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }));

    await act(async () => button('2024')?.click());
    expect(fakeMap.fitBounds).toHaveBeenCalledWith([116.4074, 39.9042, 116.4074, 39.9042], 12);
  });

  it('shows the photos of a failed area again after a retry', async () => {
    const api = mockApi({ listPhotos: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ items: [photo('p_bund_1', '2026-05-01T10:00:00Z')], next_cursor: null }) });
    await render(api);
    await moveTo({ bounds: [121, 31, 122, 32], zoom: 10, centerLng: 121.5 });
    expect(container.textContent).toContain(zh('map.areaFailed'));

    await act(async () => button(zh('common.retry'))?.click());
    await flush();
    expect(container.querySelectorAll('.map-panel .photo-tile')).toHaveLength(1);
  });

  it('centres on a position from the URL and follows later links', async () => {
    window.history.replaceState({}, '', '#/map?lat=39.9&lng=116.4&z=15');
    await render(mockApi());
    expect(fakeMap.options?.initialView).toEqual({ kind: 'point', lat: 39.9, lng: 116.4, zoom: 15 });

    await act(async () => {
      window.history.pushState({}, '', '#/map?lat=31.23&lng=121.47&z=16');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(fakeMap.setView).toHaveBeenCalledWith(31.23, 121.47, 16);
  });
});
