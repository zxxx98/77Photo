// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, Photo } from '../../app/api';
import { I18nProvider } from '../../app/I18nProvider';
import UploadWorkspace from './UploadWorkspace';
import type { UploadSelection } from './uploadSelection';

const uploadedPhoto: Photo = {
  id: 'photo-1', owner_id: 'user-1', folder_id: 'nested-1', filename: 'baby.jpg', mime_type: 'image/jpeg', size: 100,
  captured_at: '2026-09-17T01:00:00Z', captured_at_source: 'file_mtime',
};

describe('upload workspace folder context', () => {
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

  it('uploads to a nested folder passed from the folder browser and returns there after success', async () => {
    const file = new File(['image'], 'baby.jpg', { type: 'image/jpeg' });
    const selection: UploadSelection = {
      id: 1,
      files: [file],
      destination: { id: 'nested-1', name: 'Baby' },
      returnToFolder: true,
    };
    const uploadPhoto = vi.fn().mockResolvedValue(uploadedPhoto);
    const onUploadComplete = vi.fn();
    const api = {
      listFolders: vi.fn().mockResolvedValue({ items: [{ id: 'root-1', name: 'Family', owner_id: 'user-1', parent_id: null, is_shared: false }] }),
      uploadPhoto,
    } as unknown as ApiClient;

    await act(async () => {
      root.render(<I18nProvider><UploadWorkspace api={api} selection={selection} onUploadComplete={onUploadComplete} /></I18nProvider>);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector<HTMLSelectElement>('select')?.value).toBe('nested-1');
    expect(uploadPhoto).toHaveBeenCalledWith(file, 'nested-1', expect.any(Function), expect.any(AbortSignal));
    expect(onUploadComplete).toHaveBeenCalledWith({ id: 'nested-1', name: 'Baby' });
  });
});
