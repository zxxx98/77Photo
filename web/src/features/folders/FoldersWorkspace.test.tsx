// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, Folder, Photo } from '../../app/api';
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
