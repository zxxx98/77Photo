// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, RescanJob } from '../../app/api';
import { I18nProvider } from '../../app/I18nProvider';
import SettingsWorkspace from './SettingsWorkspace';

const admin = { id: 'u1', username: 'admin', role: 'admin' as const, is_active: true };
const queued: RescanJob = {
  id: 'scan_1', status: 'queued', started_at: '2026-09-15T01:00:00Z',
  counts: { scanned: 0, added: 0, updated: 0, missing: 0, failed: 0 },
};
const running: RescanJob = {
  ...queued, status: 'running',
  counts: { scanned: 12, added: 3, updated: 8, missing: 1, failed: 0 },
};
const completed: RescanJob = {
  ...running, status: 'completed', finished_at: '2026-09-15T01:01:00Z',
};

describe('settings rescan progress', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function renderWith(api: ApiClient) {
    await act(async () => {
      root.render(<I18nProvider><SettingsWorkspace api={api} currentUser={admin} /></I18nProvider>);
      await Promise.resolve();
    });
  }

  it('polls live counts, disables duplicate scans, and restores the button after completion', async () => {
    const getRescan = vi.fn().mockResolvedValueOnce(running).mockResolvedValueOnce(completed);
    const api = {
      listUsers: vi.fn().mockResolvedValue({ items: [] }),
      startRescan: vi.fn().mockResolvedValue(queued),
      getRescan,
    } as unknown as ApiClient;
    await renderWith(api);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.scan-heading button')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getRescan).toHaveBeenCalledWith('scan_1');
    expect(container.textContent).toContain('已扫描 12');
    expect(container.querySelector<HTMLButtonElement>('.scan-heading button')?.disabled).toBe(true);
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('扫描完成');
    expect(container.textContent).toContain('新增 3');
    expect(container.querySelector<HTMLButtonElement>('.scan-heading button')?.disabled).toBe(false);
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('100');
  });

  it('shows processing progress and the thumbnail phase before completion', async () => {
    const getRescan = vi.fn()
      .mockResolvedValueOnce({ ...running, phase: 'indexing', total: 12, processed: 6 })
      .mockResolvedValueOnce({ ...running, phase: 'thumbnails', total: 12, processed: 12 })
      .mockResolvedValueOnce({ ...completed, total: 12, processed: 12 });
    await renderWith({ listUsers: vi.fn().mockResolvedValue({ items: [] }),
      startRescan: vi.fn().mockResolvedValue(queued), getRescan } as unknown as ApiClient);
    await act(async () => { container.querySelector<HTMLButtonElement>('.scan-heading button')?.click(); });
    expect(container.textContent).toContain('6 / 12');
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50');
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(container.textContent).toContain('正在生成缩略图');
    expect(container.textContent).toContain('12 / 12');
    expect(container.querySelector('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(false);
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(container.textContent).toContain('扫描完成');
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('100');
  });

  it('requires confirmation before resetting the library index', async () => {
    const resetLibraryIndex = vi.fn().mockResolvedValue(queued);
    const getRescan = vi.fn().mockResolvedValue(completed);
    const api = {
      listUsers: vi.fn().mockResolvedValue({ items: [] }),
      resetLibraryIndex,
      getRescan,
    } as unknown as ApiClient;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await renderWith(api);

    const resetButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('重置并重新扫描'));
    expect(resetButton).not.toBeUndefined();

    await act(async () => {
      resetButton?.click();
      await Promise.resolve();
    });
    expect(resetLibraryIndex).not.toHaveBeenCalled();

    await act(async () => {
      resetButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(resetLibraryIndex).toHaveBeenCalledTimes(1);
    expect(getRescan).toHaveBeenCalledWith('scan_1');
  });

  it('uses the project-styled user picker for photo imports', async () => {
    const member = { id: 'u2', username: 'family', role: 'user' as const, is_active: true };
    const api = {
      listUsers: vi.fn().mockResolvedValue({ items: [admin, member] }),
    } as unknown as ApiClient;
    await renderWith(api);

    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="目标用户"]');
    expect(trigger).not.toBeNull();
    expect(container.querySelector('select[aria-label="目标用户"]')).toBeNull();
    expect(trigger?.textContent).toContain('admin');

    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });

    const options = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    expect(options.map((option) => option.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('admin'), expect.stringContaining('family')]));

    const familyOption = options.find((option) => option.textContent?.includes('family'));
    await act(async () => {
      familyOption?.click();
      await Promise.resolve();
    });

    expect(trigger?.textContent).toContain('family');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
  });

  it('defaults to preserving folders and sends the selected date organization option', async () => {
    const job = { id: 'import_1', status: 'completed', counts: { scanned: 0, moved: 0, skipped: 0, failed: 0 } };
    const startImport = vi.fn().mockResolvedValue(job);
    await renderWith({ listUsers: vi.fn().mockResolvedValue({ items: [admin] }), startImport,
      getImport: vi.fn().mockResolvedValue(job) } as unknown as ApiClient);
    const option = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(option.checked).toBe(false);
    const form = container.querySelector('input[aria-label="导入目录"]')!.closest('form')!;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(startImport).toHaveBeenLastCalledWith({ source_path: '.', user_id: 'u1', organize_by_date: false });
    await act(async () => { option.click(); });
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(startImport).toHaveBeenLastCalledWith({ source_path: '.', user_id: 'u1', organize_by_date: true });
  });

  it('offers incremental and full thumbnail rebuild modes and defaults to incremental', async () => {
    const thumbnailJob = {
      id: 'tr_1',
      mode: 'incremental' as const,
      status: 'completed' as const,
      started_at: '2026-09-18T01:00:00Z',
      finished_at: '2026-09-18T01:00:01Z',
      counts: { total: 1, processed: 1, regenerated: 1, failed: 0 },
    };
    const startThumbnailRebuild = vi.fn().mockResolvedValue(thumbnailJob);
    const getThumbnailRebuild = vi.fn().mockResolvedValue(thumbnailJob);
    const api = {
      listUsers: vi.fn().mockResolvedValue({ items: [] }),
      startThumbnailRebuild,
      getThumbnailRebuild,
    } as unknown as ApiClient;
    await renderWith(api);

    const modeGroup = container.querySelector('[role="group"][aria-label="重建方式"]');
    expect(modeGroup).not.toBeNull();
    const incremental = Array.from(modeGroup?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find((button) => button.textContent?.includes('增量'));
    const full = Array.from(modeGroup?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find((button) => button.textContent?.includes('全量'));
    expect(incremental?.getAttribute('aria-pressed')).toBe('true');
    expect(full?.getAttribute('aria-pressed')).toBe('false');

    const rebuildButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('重新生成缩略图'));
    await act(async () => {
      rebuildButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(startThumbnailRebuild).toHaveBeenCalledWith('incremental');

    await act(async () => {
      full?.click();
      await Promise.resolve();
    });
    expect(full?.getAttribute('aria-pressed')).toBe('true');
    expect(incremental?.getAttribute('aria-pressed')).toBe('false');
  });

  it('previews broken photos before confirmed cleanup', async () => {
    const scanBrokenPhotos = vi.fn()
      .mockResolvedValueOnce({
        scanned: 10,
        broken: 2,
        items: [
          { id: 'p1', filename: 'missing.jpg', reason: 'missing' },
          { id: 'p2', filename: 'empty.jpg', reason: 'empty' },
        ],
      })
      .mockResolvedValueOnce({ scanned: 8, broken: 0, items: [] });
    const cleanupBrokenPhotos = vi.fn().mockResolvedValue({
      scanned: 10,
      found: 2,
      deleted: 2,
      failed: 0,
      failures: [],
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const api = {
      listUsers: vi.fn().mockResolvedValue({ items: [] }),
      scanBrokenPhotos,
      cleanupBrokenPhotos,
    } as unknown as ApiClient;
    await renderWith(api);

    const scanButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('扫描坏照片'));
    await act(async () => {
      scanButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(scanBrokenPhotos).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('missing.jpg');
    expect(container.textContent).toContain('原文件丢失');
    expect(container.textContent).toContain('empty.jpg');
    expect(container.textContent).toContain('0 字节文件');

    const cleanupButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('清理 2 张'));
    await act(async () => {
      cleanupButton?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(window.confirm).toHaveBeenCalled();
    expect(cleanupBrokenPhotos).toHaveBeenCalledTimes(1);
    expect(scanBrokenPhotos).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('已清理 2 张坏照片');
  });

  it('shows a failed terminal status and stops polling', async () => {
    const failed: RescanJob = { ...queued, status: 'failed', error: 'storage unavailable' };
    const getRescan = vi.fn().mockResolvedValue(failed);
    const api = {
      listUsers: vi.fn().mockResolvedValue({ items: [] }),
      startRescan: vi.fn().mockResolvedValue(queued),
      getRescan,
    } as unknown as ApiClient;
    await renderWith(api);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.scan-heading button')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('扫描失败');
    expect(container.querySelector<HTMLButtonElement>('.scan-heading button')?.disabled).toBe(false);
    const calls = getRescan.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(getRescan).toHaveBeenCalledTimes(calls);
  });
});
