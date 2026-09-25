// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, Photo } from '../../app/api';
import { I18nProvider } from '../../app/I18nProvider';
import Viewer from './Viewer';

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
