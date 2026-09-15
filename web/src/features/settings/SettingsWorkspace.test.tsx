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
