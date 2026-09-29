// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ApiClient, PhotoPage } from '../../app/api';
import { I18nProvider } from '../../app/I18nProvider';
import GalleryWorkspace from './GalleryWorkspace';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.sessionStorage.clear();
  window.location.hash = '#/gallery';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

it('shows favorites only when supported and sends the filter to the server', async () => {
  const listPhotos = vi.fn().mockResolvedValue({items: [], next_cursor: null, favorites_supported: true});
  const api = {listPhotos, listFolders: vi.fn().mockResolvedValue({items: []}), listShares: vi.fn().mockResolvedValue({items: []})} as unknown as ApiClient;
  await act(async () => {root.render(<I18nProvider><GalleryWorkspace api={api} /></I18nProvider>); await Promise.resolve();});
  const button = [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === '收藏');
  expect(button).toBeDefined();
  await act(async () => {button!.click(); await Promise.resolve();});
  expect(listPhotos).toHaveBeenLastCalledWith(expect.objectContaining({favorite: true}));
  expect(window.location.hash).toContain('favorite=true');
});

it('debounces filename search and ignores an older response', async () => {
  const first = deferred<PhotoPage>();
  const second = deferred<PhotoPage>();
  const listPhotos = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValueOnce({ items: [{ id: 'library-photo' }], next_cursor: null });
  const api = { listPhotos, listFolders: vi.fn().mockResolvedValue({ items: [] }), listShares: vi.fn().mockResolvedValue({ items: [] }) } as unknown as ApiClient;
  await act(async () => { root.render(<I18nProvider><GalleryWorkspace api={api} /></I18nProvider>); });
  expect(listPhotos).toHaveBeenCalledTimes(1);

  vi.useFakeTimers();
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '家庭 %_');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(listPhotos).toHaveBeenCalledTimes(1);
  await act(async () => { vi.advanceTimersByTime(300); });
  expect(listPhotos).toHaveBeenCalledTimes(2);
  expect(listPhotos.mock.calls[1][0]).toEqual(expect.objectContaining({ q: '家庭 %_', limit: 50 }));
  await act(async () => { second.resolve({ items: [], next_cursor: null }); await Promise.resolve(); });
  expect(listPhotos).toHaveBeenCalledTimes(3);
  expect(listPhotos.mock.calls[2][0]).toEqual(expect.objectContaining({ limit: 1 }));
  expect(container.textContent).toContain('没有符合条件的照片');
  await act(async () => { first.resolve({ items: [{ id: 'stale', filename: 'old.jpg' }] as PhotoPage['items'], next_cursor: null }); await Promise.resolve(); });
  expect(container.textContent).not.toContain('old.jpg');
  expect(window.location.hash).toContain('q=');
});

it('sends local date boundaries and clears all filters', async () => {
  const listPhotos = vi.fn().mockResolvedValue({ items: [], next_cursor: null });
  const api = { listPhotos, listFolders: vi.fn().mockResolvedValue({ items: [] }), listShares: vi.fn().mockResolvedValue({ items: [] }) } as unknown as ApiClient;
  await act(async () => { root.render(<I18nProvider><GalleryWorkspace api={api} /></I18nProvider>); await Promise.resolve(); });
  const dates = container.querySelectorAll<HTMLInputElement>('input[type="date"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(dates[0], '2026-09-15');
    dates[0].dispatchEvent(new Event('input', { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(dates[1], '2026-09-15');
    dates[1].dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
  expect(listPhotos).toHaveBeenLastCalledWith(expect.objectContaining({
    from: new Date(2026, 8, 15).toISOString(), to: new Date(2026, 8, 16).toISOString(),
  }));
  const clear = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === '清除筛选')!;
  await act(async () => { clear.click(); await Promise.resolve(); });
  expect(listPhotos).toHaveBeenLastCalledWith(expect.objectContaining({ from: undefined, to: undefined }));
});

it('uses the next local midnight across a daylight saving change', async () => {
  const environment = (globalThis as typeof globalThis & { process: { env: Record<string, string | undefined> } }).process.env;
  const originalZone = environment.TZ;
  environment.TZ = 'America/New_York';
  try {
    const listPhotos = vi.fn().mockResolvedValue({ items: [], next_cursor: null });
    const api = { listPhotos, listFolders: vi.fn().mockResolvedValue({ items: [] }), listShares: vi.fn().mockResolvedValue({ items: [] }) } as unknown as ApiClient;
    await act(async () => { root.render(<I18nProvider><GalleryWorkspace api={api} /></I18nProvider>); await Promise.resolve(); });
    const dates = container.querySelectorAll<HTMLInputElement>('input[type="date"]');
    await act(async () => {
      for (const date of dates) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(date, '2026-03-08');
        date.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await Promise.resolve();
    });
    expect(listPhotos).toHaveBeenLastCalledWith(expect.objectContaining({ from: '2026-03-08T05:00:00.000Z', to: '2026-03-09T04:00:00.000Z' }));
  } finally {
    environment.TZ = originalZone;
  }
});

it('shows the empty library state when a filtered library has no photos at all', async () => {
  window.location.hash = '#/gallery?q=missing';
  const listPhotos = vi.fn().mockResolvedValue({ items: [], next_cursor: null });
  const api = { listPhotos, listFolders: vi.fn().mockResolvedValue({ items: [] }), listShares: vi.fn().mockResolvedValue({ items: [] }) } as unknown as ApiClient;
  await act(async () => { root.render(<I18nProvider><GalleryWorkspace api={api} /></I18nProvider>); await Promise.resolve(); });
  expect(listPhotos).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain('你的第一卷照片');
  expect(container.textContent).not.toContain('没有符合条件的照片');
});

it('offers accessible shared folders and sends folder plus media filters', async () => {
  const listPhotos = vi.fn().mockResolvedValue({ items: [], next_cursor: null });
  const shared = { id: 'shared-folder', name: 'Family', owner_id: 'owner', parent_id: null, is_shared: true };
  const api = {
    listPhotos,
    listFolders: vi.fn().mockResolvedValue({ items: [] }),
    listShares: vi.fn().mockResolvedValue({ items: [{ resource_id: shared.id }] }),
    getFolder: vi.fn().mockResolvedValue(shared),
  } as unknown as ApiClient;
  await act(async () => { root.render(<I18nProvider><GalleryWorkspace api={api} /></I18nProvider>); await Promise.resolve(); });
  const select = container.querySelector<HTMLSelectElement>('select')!;
  expect(select.textContent).toContain('Family');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, shared.id);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === '视频')!.click();
    await Promise.resolve();
  });
  expect(listPhotos).toHaveBeenLastCalledWith(expect.objectContaining({ folderId: shared.id, mediaType: 'video' }));
});

it('shows request errors separately and retries the current filters', async () => {
  window.location.hash = '#/gallery?q=family';
  const listPhotos = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ items: [], next_cursor: null });
  const api = { listPhotos, listFolders: vi.fn().mockResolvedValue({ items: [] }), listShares: vi.fn().mockResolvedValue({ items: [] }) } as unknown as ApiClient;
  await act(async () => { root.render(<I18nProvider><GalleryWorkspace api={api} /></I18nProvider>); await Promise.resolve(); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('无法加载图库');
  expect(container.querySelector('.empty-timeline')).toBeNull();
  await act(async () => { [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === '重试')!.click(); await Promise.resolve(); });
  expect(listPhotos.mock.calls[1][0]).toEqual(expect.objectContaining({ q: 'family' }));
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('does not request an invalid date range when refreshing or editing the filename', async () => {
  window.location.hash = '#/gallery?from=2026-09-20&to=2026-09-10';
  const listPhotos = vi.fn().mockResolvedValue({ items: [], next_cursor: null });
  const api = { listPhotos, listFolders: vi.fn().mockResolvedValue({ items: [] }), listShares: vi.fn().mockResolvedValue({ items: [] }) } as unknown as ApiClient;
  await act(async () => { root.render(<I18nProvider><GalleryWorkspace api={api} /></I18nProvider>); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('开始日期不能晚于结束日期');
  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="刷新照片库"]')!.click(); });
  vi.useFakeTimers();
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'family');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { vi.advanceTimersByTime(300); });
  expect(listPhotos).not.toHaveBeenCalled();
  await act(async () => { [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === '清除筛选')!.click(); });
  expect(listPhotos).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
