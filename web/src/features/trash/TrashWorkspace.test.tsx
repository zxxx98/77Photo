// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { type ApiClient, type TrashItem } from '../../app/api';
import { I18nProvider } from '../../app/I18nProvider';
import TrashWorkspace from './TrashWorkspace';

const user = { id: 'u1', username: 'alice', role: 'admin' as const, is_active: true };
const photo: TrashItem = { id: 'p1', owner_id: 'u1', filename: 'family.jpg', mime_type: 'image/jpeg', size: 123, folder_id: 'f1', folder_name: 'Family', deleted_at: '2026-09-28T10:00:00Z', expires_at: '2026-10-28T10:00:00Z', state: 'trashed', recovery_required: false };
const page = (items: TrashItem[]) => ({ items, next_cursor: null, retention_days: 30 });

describe('TrashWorkspace', () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });
  async function render(api: Partial<ApiClient>) { await act(async () => { root.render(<I18nProvider><TrashWorkspace api={api as ApiClient} currentUser={user} /></I18nProvider>); }); }
  function button(label: string, within: ParentNode = container) {
    const found = [...within.querySelectorAll('button')].find(item => item.textContent?.trim() === label);
    if (!found) throw new Error(`Missing ${label}`); return found;
  }
  async function click(label: string, within?: ParentNode) { await act(async () => button(label, within).click()); }

  it('requires a separate destructive confirmation and retains failed items', async () => {
    const other = { ...photo, id: 'p2', filename: 'video.mp4', mime_type: 'video/mp4' };
    const purgeTrash = vi.fn().mockResolvedValue({ completed_ids: ['p1'], failed: [{ id: 'p2', code: 'MAINTENANCE_IN_PROGRESS' }] });
    await render({ listTrash: vi.fn().mockResolvedValueOnce(page([photo, other])).mockResolvedValue(page([other])), purgeTrash });
    expect(container.querySelector('img')?.getAttribute('src')).toContain('/api/v1/trash/photos/p1/preview');
    await click('选择本页可恢复项目'); await click('永久删除');
    expect(purgeTrash).not.toHaveBeenCalled();
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('无法恢复');
    await click('永久删除', dialog);
    expect(purgeTrash).toHaveBeenCalledWith(['p1', 'p2']);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain('另一个维护任务正在运行');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="选择 video.mp4"]')?.checked).toBe(true);
    expect(container.querySelector('input[aria-label="选择 family.jpg"]')).toBeNull();
  });

  it('allows retrying a restore conflict with explicit rename and original destination', async () => {
    const restoreTrash = vi.fn().mockResolvedValueOnce({ completed_ids: [], failed: [{ id: 'p1', code: 'NAME_CONFLICT' }] }).mockResolvedValue({ completed_ids: ['p1'], failed: [] });
    const listTrash = vi.fn().mockResolvedValueOnce(page([photo])).mockResolvedValueOnce(page([photo])).mockResolvedValue(page([]));
    await render({ listTrash, restoreTrash });
    await click('选择本页可恢复项目'); await click('恢复');
    let dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('不会重新启用');
    await click('恢复', dialog);
    expect(restoreTrash).toHaveBeenLastCalledWith(['p1'], { conflict: 'reject' });
    expect(container.textContent).toContain('目标已有同名文件');
    await click('恢复'); dialog = container.querySelector('[role="dialog"]')!;
    await act(async () => dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await click('恢复', dialog);
    expect(restoreTrash).toHaveBeenLastCalledWith(['p1'], { conflict: 'rename' });
    expect(container.textContent).toContain('回收站是空的');
  });

  it('empties only the explicitly selected scope using the same cutoff across batches', async () => {
    const emptyTrash = vi.fn().mockResolvedValueOnce({ completed_ids: ['p1'], failed: [], has_more: true }).mockResolvedValue({ completed_ids: ['p2'], failed: [] });
    await render({ listTrash: vi.fn().mockResolvedValueOnce(page([photo])).mockResolvedValue(page([])), emptyTrash });
    await click('清空回收站');
    expect(emptyTrash).not.toHaveBeenCalled();
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('我的回收站');
    expect(dialog.textContent).toContain('包括未加载的项目');
    await click('清空回收站', dialog);
    expect(emptyTrash).toHaveBeenCalledTimes(2);
    expect(emptyTrash.mock.calls[0][0]).toBe('mine');
    expect(emptyTrash.mock.calls[0][1]).toBe(emptyTrash.mock.calls[1][1]);
    expect(container.textContent).toContain('已完成 2 项');
  });

  it('splits selections larger than the API batch limit', async () => {
    const items = Array.from({ length: 501 }, (_, index) => ({ ...photo, id: `p${index}` }));
    const purgeTrash = vi.fn(async (ids: string[]) => ({ completed_ids: ids, failed: [] }));
    await render({ listTrash: vi.fn().mockResolvedValueOnce(page(items)).mockResolvedValue(page([])), purgeTrash });
    await click('选择本页可恢复项目'); await click('永久删除');
    await click('永久删除', container.querySelector('[role="dialog"]')!);
    expect(purgeTrash.mock.calls.map(call => call[0].length)).toEqual([500, 1]);
    expect(container.textContent).toContain('501');
  }, 20000);

  it('keeps unfinished operations out of selection and offers recovery', async () => {
    const retryTrash = vi.fn().mockResolvedValue(undefined);
    await render({ listTrash: vi.fn().mockResolvedValueOnce(page([{ ...photo, state: 'moving', recovery_required: true }])).mockResolvedValue(page([photo])), retryTrash });
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true);
    expect(container.querySelector('img')).toBeNull();
    await click('重试操作');
    expect(retryTrash).toHaveBeenCalledWith('p1');
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(false);
  });
});
