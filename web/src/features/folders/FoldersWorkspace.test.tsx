// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, Folder, Photo, PhotoPage } from '../../app/api';
import { I18nProvider } from '../../app/I18nProvider';
import FoldersWorkspace from './FoldersWorkspace';

const rootFolder: Folder = { id: 'folder-1', name: 'Family', owner_id: 'user-1', parent_id: null, is_shared: false };
const photo: Photo = {
  id: 'photo-1', owner_id: 'user-1', folder_id: 'folder-1', filename: 'baby.jpg', mime_type: 'image/jpeg', size: 100,
  captured_at: '2026-09-17T01:00:00Z', captured_at_source: 'file_mtime',
};
const emptyPhotos = { items: [] as Photo[], next_cursor: null };

describe('folders workspace states', () => {
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

  async function renderWith(api: ApiClient, onUpload = vi.fn(), onFolderChange = vi.fn()) {
    await act(async () => {
      root.render(<I18nProvider><FoldersWorkspace api={api} onUpload={onUpload} onFolderChange={onFolderChange} /></I18nProvider>);
      await Promise.resolve();
      await Promise.resolve();
    });
    return { onUpload, onFolderChange };
  }

  it.each(['success', 'failure'])('ignores stale pagination %s after entering another folder', async (outcome) => {
    let resolveOld!: (page: PhotoPage) => void;
    let rejectOld!: (error: Error) => void;
    const oldPage = new Promise<PhotoPage>((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
    let resolveCurrent!: (page: PhotoPage) => void;
    const currentPage = new Promise<PhotoPage>((resolve) => { resolveCurrent = resolve; });
    const child = { ...rootFolder, id: 'child', name: 'Child' };
    const childPhoto = { ...photo, id: 'child-photo', folder_id: 'child', filename: 'child.jpg' };
    const listFolders = vi.fn().mockImplementation((id?: string) => Promise.resolve({ items: id === rootFolder.id ? [child] : [] }));
    const listPhotos = vi.fn().mockImplementation(({ folderId, cursor }: { folderId: string; cursor?: string }) => {
      if (cursor) return folderId === rootFolder.id ? oldPage : currentPage;
      return Promise.resolve({ items: [folderId === rootFolder.id ? photo : childPhoto], next_cursor: folderId === rootFolder.id ? 'old-cursor' : 'child-cursor' });
    });
    const api = { listFolders, listPhotos } as unknown as ApiClient;
    await act(async () => root.render(<I18nProvider><FoldersWorkspace api={api} initialFolder={rootFolder} onUpload={vi.fn()} /></I18nProvider>));
    await act(async () => container.querySelector<HTMLButtonElement>('.gallery-sentinel button')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('.folder-row-link')!.click());
    expect(container.querySelector<HTMLButtonElement>('.gallery-sentinel button')!.disabled).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>('.gallery-sentinel button')!.click());
    expect(listPhotos).toHaveBeenLastCalledWith({ folderId: 'child', cursor: 'child-cursor', limit: 50 });

    await act(async () => {
      if (outcome === 'success') resolveOld({ items: [{ ...photo, id: 'stale', filename: 'stale.jpg' }], next_cursor: 'stale-cursor' });
      else rejectOld(new Error('offline'));
    });
    expect(container.textContent).not.toContain('stale.jpg');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('.gallery-sentinel button')!.disabled).toBe(true);
    await act(async () => resolveCurrent({ items: [{ ...childPhoto, id: 'child-2', filename: 'child-2.jpg' }], next_cursor: null }));
    expect(container.textContent).toContain('child-2.jpg');
    expect(container.querySelector('.gallery-sentinel button')).toBeNull();
  });

  it('runs both root empty-state actions', async () => {
    const api = { listFolders: vi.fn().mockResolvedValue({ items: [] }) } as unknown as ApiClient;
    const { onUpload } = await renderWith(api);
    const buttons = container.querySelectorAll<HTMLButtonElement>('.folder-empty-actions button');

    act(() => buttons[0]?.click());
    expect(onUpload).toHaveBeenCalledWith(null);

    act(() => buttons[1]?.click());
    expect(document.activeElement).toBe(container.querySelector('#folder-name'));
  });

  it('shows photos from the current folder and reports folder context', async () => {
    const listFolders = vi.fn().mockResolvedValueOnce({ items: [rootFolder] }).mockResolvedValueOnce({ items: [] });
    const listPhotos = vi.fn().mockResolvedValue({ items: [photo], next_cursor: null });
    const { onFolderChange } = await renderWith({ listFolders, listPhotos } as unknown as ApiClient);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.folder-row-link')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listPhotos).toHaveBeenCalledWith({ folderId: 'folder-1', limit: 50 });
    expect(onFolderChange).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'folder-1', name: 'Family' }));
    expect(container.textContent).toContain('baby.jpg');
    expect(container.querySelector<HTMLImageElement>('.photo-grid img')?.getAttribute('src')).toBe('/api/v1/photos/photo-1/thumbnail?size=256');
  });

  it.each([['image/jpeg', '/image-placeholder.svg'], ['video/mp4', '/video-placeholder.svg']])('uses matching artwork for missing %s thumbnails', async (mime_type, source) => {
    const listFolders = vi.fn().mockResolvedValueOnce({ items: [rootFolder] }).mockResolvedValueOnce({ items: [] });
    const listPhotos = vi.fn().mockResolvedValue({ items: [{ ...photo, mime_type }], next_cursor: null });
    await renderWith({ listFolders, listPhotos } as unknown as ApiClient);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.folder-row-link')?.click();
    });
    const image = container.querySelector<HTMLImageElement>('.photo-grid img');
    act(() => { image?.dispatchEvent(new Event('error')); });
    expect(image?.getAttribute('src')).toBe(source);
    act(() => { image?.dispatchEvent(new Event('error')); });
    expect(container.querySelector('.photo-grid img')).toBeNull();
    expect(container.textContent).toContain('预览暂不可用');
  });

  it('uploads into the current folder when that folder is empty', async () => {
    const listFolders = vi.fn().mockResolvedValueOnce({ items: [rootFolder] }).mockResolvedValueOnce({ items: [] });
    const listPhotos = vi.fn().mockResolvedValue(emptyPhotos);
    const { onUpload } = await renderWith({ listFolders, listPhotos } as unknown as ApiClient);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.folder-row-link')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const uploadButton = container.querySelector<HTMLButtonElement>('.folder-empty-actions button');
    act(() => uploadButton?.click());
    expect(onUpload).toHaveBeenCalledWith(expect.objectContaining({ id: 'folder-1', name: 'Family' }));
  });

  it('clears a failed nested load after returning to a successful root', async () => {
    const listFolders = vi.fn()
      .mockResolvedValueOnce({ items: [rootFolder] })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [rootFolder] });
    const listPhotos = vi.fn().mockResolvedValue(emptyPhotos);
    await renderWith({ listFolders, listPhotos } as unknown as ApiClient);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.folder-row-link')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.breadcrumb-button')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('.folder-row-copy strong')?.textContent).toBe('Family');
  });

  it('clears a create error after a successful retry', async () => {
    const createFolder = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(rootFolder);
    await renderWith({ listFolders: vi.fn().mockResolvedValue({ items: [] }), createFolder } as unknown as ApiClient);
    const input = container.querySelector<HTMLInputElement>('#folder-name')!;
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

    await act(async () => {
      valueSetter?.call(input, 'Family');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      container.querySelector<HTMLFormElement>('.inline-create')?.requestSubmit();
      await Promise.resolve();
    });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    await act(async () => {
      container.querySelector<HTMLFormElement>('.inline-create')?.requestSubmit();
      await Promise.resolve();
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('.folder-row-copy strong')?.textContent).toBe('Family');
  });
});
