// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, Photo } from '../../app/api';
import { I18nProvider } from '../../app/I18nProvider';
import GalleryWorkspace from './GalleryWorkspace';

const livePhoto: Photo = {
  id: 'photo-1',
  owner_id: 'user-1',
  folder_id: 'folder-1',
  filename: 'photo.heic',
  mime_type: 'image/heic',
  size: 100,
  captured_at: '2026-09-15T00:00:00Z',
  captured_at_source: 'mtime',
  is_live_photo: true,
};

function api(): ApiClient {
  return {
    listPhotos: vi.fn().mockResolvedValue({ items: [livePhoto], next_cursor: null }),
    listFolders: vi.fn().mockResolvedValue({ items: [] }),
    getFolder: vi.fn().mockResolvedValue({ id: 'folder-1', name: 'Family', owner_id: 'user-1', parent_id: null, is_shared: false }),
  } as unknown as ApiClient;
}

describe('GalleryWorkspace LIVE playback', () => {
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

  it('retries pending thumbnails before falling back to the original image', async () => {
    vi.useFakeTimers();
    await act(async () => {
      root.render(<I18nProvider><GalleryWorkspace api={api()} /></I18nProvider>);
      await Promise.resolve();
    });

    let image = container.querySelector<HTMLImageElement>('.photo-tile img');
    expect(image?.getAttribute('src')).toContain('/thumbnail?size=256&retry=0');

    for (const attempt of [1, 2]) {
      await act(async () => {
        image?.dispatchEvent(new Event('error'));
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
      image = container.querySelector<HTMLImageElement>('.photo-tile img');
      expect(image?.getAttribute('src')).toContain(`retry=${attempt}`);
    }

    await act(async () => {
      image?.dispatchEvent(new Event('error'));
      await Promise.resolve();
    });
    image = container.querySelector<HTMLImageElement>('.photo-tile img');
    expect(image?.getAttribute('src')).toBe('/api/v1/photos/photo-1/original');

    await act(async () => {
      image?.dispatchEvent(new Event('error'));
      await Promise.resolve();
    });
    expect(container.querySelector('.photo-tile img')).toBeNull();
    expect(container.textContent).toContain('预览暂不可用');
  });

  it('shows the LIVE marker and plays the authenticated motion endpoint with a preview poster', async () => {
    await act(async () => {
      root.render(<I18nProvider><GalleryWorkspace api={api()} /></I18nProvider>);
      await Promise.resolve();
    });

    expect(container.textContent).toContain('LIVE');
    await act(async () => {
      container.querySelector<HTMLElement>('.photo-tile')?.click();
      await Promise.resolve();
    });

    const video = container.querySelector<HTMLVideoElement>('.immersive-viewer__media video');
    expect(video?.getAttribute('src')).toBe('/api/v1/live-photos/photo-1');
    expect(video?.getAttribute('poster')).toBe('/api/v1/photos/photo-1/preview');
  });
});
