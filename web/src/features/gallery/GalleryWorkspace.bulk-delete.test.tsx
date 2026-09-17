// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, Photo } from '../../app/api';
import { I18nProvider } from '../../app/I18nProvider';
import GalleryWorkspace from './GalleryWorkspace';

const photos: Photo[] = [
  {
    id: 'photo-1',
    owner_id: 'user-1',
    folder_id: 'folder-1',
    filename: 'one.jpg',
    mime_type: 'image/jpeg',
    size: 100,
    captured_at: '2026-09-17T10:00:00Z',
    captured_at_source: 'mtime',
  },
  {
    id: 'photo-2',
    owner_id: 'user-1',
    folder_id: 'folder-1',
    filename: 'two.jpg',
    mime_type: 'image/jpeg',
    size: 120,
    captured_at: '2026-09-17T11:00:00Z',
    captured_at_source: 'mtime',
  },
];

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === text);
  if (!button) throw new Error(`button not found: ${text}`);
  return button;
}

describe('GalleryWorkspace bulk deletion', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('selects a whole day, confirms once, and sends one bulk delete request', async () => {
    const deletePhotos = vi.fn().mockResolvedValue({ deleted_ids: ['photo-1', 'photo-2'], failed: [] });
    const api = {
      listPhotos: vi.fn().mockResolvedValue({ items: photos, next_cursor: null }),
      deletePhotos,
    } as unknown as ApiClient;

    await act(async () => {
      root.render(<I18nProvider><GalleryWorkspace api={api} /></I18nProvider>);
      await Promise.resolve();
    });

    await act(async () => {
      findButton(container, '选择').click();
    });
    await act(async () => {
      findButton(container, '选择当天').click();
    });

    expect(container.textContent).toContain('已选择 2 张');

    await act(async () => {
      findButton(container, '删除 2 张').click();
    });
    expect(container.textContent).toContain('将永久删除 2 张照片，此操作无法撤销。');

    await act(async () => {
      findButton(container, '确认删除').click();
      await Promise.resolve();
    });

    expect(deletePhotos).toHaveBeenCalledTimes(1);
    expect(deletePhotos).toHaveBeenCalledWith(['photo-1', 'photo-2']);
    expect(container.querySelectorAll('.photo-tile')).toHaveLength(0);
  });
});
