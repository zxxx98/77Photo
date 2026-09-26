// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, Photo } from '../../app/api';
import { I18nProvider } from '../../app/I18nProvider';
import Viewer from './Viewer';

vi.mock('../map/LocationMiniMap', () => ({
  default: ({ latitude, longitude }: { latitude: number; longitude: number }) => <div className="mini-map-stub">{latitude},{longitude}</div>,
}));

const videoPhoto: Photo = {
  id: 'video-1',
  owner_id: 'user-1',
  folder_id: 'folder-1',
  filename: 'clip.mp4',
  mime_type: 'video/mp4',
  size: 200,
  captured_at: '2026-09-15T00:00:00Z',
  captured_at_source: 'mtime',
};

describe('Viewer filmstrip thumbnails', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('loads MP4 thumbnails and retries pending generation before showing the video placeholder', async () => {
    vi.useFakeTimers();
    await act(async () => {
      root.render(
        <I18nProvider>
          <Viewer
            api={{
              listFolders: vi.fn().mockResolvedValue({ items: [] }),
              getFolder: vi.fn().mockResolvedValue({ id: 'folder-1', name: 'Family' }),
            } as unknown as ApiClient}
            photos={[videoPhoto]}
            selected={0}
            onClose={vi.fn()}
            onDeleted={vi.fn()}
            onUpdated={vi.fn()}
          />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    let thumbnail = container.querySelector<HTMLImageElement>('.immersive-viewer__thumb img');
    expect(thumbnail?.getAttribute('src')).toBe('/api/v1/photos/video-1/thumbnail?size=256&retry=0');

    for (const attempt of [1, 2]) {
      await act(async () => {
        thumbnail?.dispatchEvent(new Event('error'));
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
      thumbnail = container.querySelector<HTMLImageElement>('.immersive-viewer__thumb img');
      expect(thumbnail?.getAttribute('src')).toBe(`/api/v1/photos/video-1/thumbnail?size=256&retry=${attempt}`);
    }

    await act(async () => {
      thumbnail?.dispatchEvent(new Event('error'));
      await Promise.resolve();
    });
    expect(container.querySelector<HTMLImageElement>('.immersive-viewer__thumb img')?.getAttribute('src')).toBe('/video-placeholder.svg');
  });
});

describe('Viewer location', () => {
  let container: HTMLDivElement;
  let root: Root;
  const located: Photo = {
    id: 'photo-1',
    owner_id: 'user-1',
    folder_id: 'folder-1',
    filename: 'bund.jpg',
    mime_type: 'image/jpeg',
    size: 2048,
    captured_at: '2026-05-01T10:00:00Z',
    captured_at_source: 'exif',
    gps_latitude: 31.23042,
    gps_longitude: 121.4737,
  };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.setItem('77photo.locale', 'en');
    window.history.replaceState({}, '', '#/gallery');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.localStorage.clear();
  });

  function api(config: { enabled: boolean }) {
    return {
      listFolders: vi.fn().mockResolvedValue({ items: [] }),
      getFolder: vi.fn().mockResolvedValue({ id: 'folder-1', name: 'Family' }),
      getMapConfig: vi.fn().mockResolvedValue(config),
    };
  }

  async function openDetails(client: ReturnType<typeof api>, photo: Photo, onClose = vi.fn()) {
    await act(async () => {
      root.render(<I18nProvider><Viewer api={client as unknown as ApiClient} photos={[photo]} selected={0} onClose={onClose} onDeleted={vi.fn()} onUpdated={vi.fn()} /></I18nProvider>);
    });
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Photo details"]')?.click());
    await act(async () => {
      await vi.dynamicImportSettled();
      await Promise.resolve();
    });
  }

  it('shows the position, a mini map and links to both maps', async () => {
    const onClose = vi.fn();
    const client = api({ enabled: true });
    await openDetails(client, located, onClose);

    expect(container.querySelector('.immersive-viewer__metadata')?.textContent).toContain('Location31.23042° N, 121.47370° E');
    expect(container.querySelector('.mini-map-stub')?.textContent).toBe('31.23042,121.4737');
    const amap = [...container.querySelectorAll('a')].find((link) => link.textContent === 'Open in Amap');
    expect(amap?.getAttribute('href')).toBe('https://uri.amap.com/marker?position=121.473700,31.230420&coordinate=wgs84&callnative=1');
    expect(amap?.getAttribute('rel')).toBe('noopener noreferrer');

    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'View on map')?.click());
    expect(onClose).toHaveBeenCalled();
    expect(window.location.hash).toBe('#/map?lat=31.230420&lng=121.473700&z=16');
  });

  it('keeps the Amap link but hides map features while the map is disabled', async () => {
    await openDetails(api({ enabled: false }), located);

    expect(container.querySelector('.mini-map-stub')).toBeNull();
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'View on map')).toBe(false);
    expect([...container.querySelectorAll('a')].some((link) => link.textContent === 'Open in Amap')).toBe(true);
  });

  it('leaves photos without a position unchanged', async () => {
    const client = api({ enabled: true });
    await openDetails(client, { ...located, gps_latitude: null, gps_longitude: null });

    expect(container.textContent).not.toContain('Location');
    expect(container.textContent).not.toContain('Open in Amap');
    expect(client.getMapConfig).not.toHaveBeenCalled();
  });
});

