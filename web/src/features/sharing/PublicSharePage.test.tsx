// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, PublicShare } from '../../app/api';
import { I18nProvider } from '../../app/I18nProvider';
import PublicSharePage from './PublicSharePage';

describe('public share loading states', () => {
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
  });

  it('replaces skeletons with a read-only empty state after loading', async () => {
    let resolveShare!: (share: PublicShare) => void;
    let resolvePhotos!: (page: { items: [] }) => void;
    const api = {
      getPublicShare: vi.fn().mockReturnValue(new Promise<PublicShare>((resolve) => { resolveShare = resolve; })),
      listPublicSharePhotos: vi.fn().mockReturnValue(new Promise<{ items: [] }>((resolve) => { resolvePhotos = resolve; })),
    } as unknown as ApiClient;

    await act(async () => { root.render(<I18nProvider><PublicSharePage api={api} token="share-1" /></I18nProvider>); });
    expect(container.querySelector('.public-share-skeleton-full')).not.toBeNull();

    await act(async () => {
      resolveShare({ resource_type: 'folder', name: 'Family', password_required: false });
      await Promise.resolve();
    });
    expect(container.querySelector('.public-share-skeleton:not(.public-share-skeleton-full)')).not.toBeNull();

    await act(async () => {
      resolvePhotos({ items: [] });
      await Promise.resolve();
    });
    expect(container.querySelector('.public-share-skeleton')).toBeNull();
    expect(container.querySelector('.public-share-empty')).not.toBeNull();
    expect(container.querySelector('.public-share-empty button')).toBeNull();
  });

  it('opens a shared image in a read-only viewer when clicked', async () => {
    const api = {
      getPublicShare: vi.fn().mockResolvedValue({ resource_type: 'photo', name: 'Summer', password_required: false } satisfies PublicShare),
      listPublicSharePhotos: vi.fn().mockResolvedValue({ items: [{ id: 'photo-1', folder_id: 'folder-1', filename: 'summer.jpg', mime_type: 'image/jpeg', size: 100, captured_at: '2026-09-15T00:00:00Z' }] }),
      publicSharePreviewURL: vi.fn().mockReturnValue('/shared/photo-1/preview'),
    } as unknown as ApiClient;

    await act(async () => {
      root.render(<I18nProvider><PublicSharePage api={api} token="share-1" /></I18nProvider>);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('.public-share-viewer')).toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.public-photo-frame')?.click();
    });

    const viewer = container.querySelector<HTMLElement>('.public-share-viewer');
    expect(viewer).not.toBeNull();
    expect(viewer?.getAttribute('role')).toBe('dialog');
    expect(viewer?.querySelector('img')?.getAttribute('src')).toBe('/shared/photo-1/preview');
  });
});
