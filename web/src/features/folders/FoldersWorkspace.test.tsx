// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, Folder } from '../../app/api';
import { I18nProvider } from '../../app/I18nProvider';
import FoldersWorkspace from './FoldersWorkspace';

const rootFolder: Folder = { id: 'folder-1', name: 'Family', owner_id: 'user-1', parent_id: null, is_shared: false };

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

  async function renderWith(api: ApiClient, onUpload = vi.fn()) {
    await act(async () => {
      root.render(<I18nProvider><FoldersWorkspace api={api} onUpload={onUpload} /></I18nProvider>);
      await Promise.resolve();
    });
    return onUpload;
  }

  it('runs both empty-state actions', async () => {
    const api = { listFolders: vi.fn().mockResolvedValue({ items: [] }) } as unknown as ApiClient;
    const onUpload = await renderWith(api);
    const buttons = container.querySelectorAll<HTMLButtonElement>('.folder-empty-actions button');

    act(() => buttons[0]?.click());
    expect(onUpload).toHaveBeenCalledOnce();

    act(() => buttons[1]?.click());
    expect(document.activeElement).toBe(container.querySelector('#folder-name'));
  });

  it('clears a failed nested load after returning to a successful root', async () => {
    const listFolders = vi.fn()
      .mockResolvedValueOnce({ items: [rootFolder] })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [rootFolder] });
    await renderWith({ listFolders } as unknown as ApiClient);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.folder-row-link')?.click();
      await Promise.resolve();
    });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.breadcrumb-button')?.click();
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
