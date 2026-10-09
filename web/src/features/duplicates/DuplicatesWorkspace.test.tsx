// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { ApiError, type ApiClient } from '../../app/api';
import { I18nProvider } from '../../app/I18nProvider';
import DuplicatesWorkspace from './DuplicatesWorkspace';
import type { DuplicateGroup, DuplicatesAPI } from './types';

const user = { id: 'u1', username: 'alice', role: 'admin' as const, is_active: true };
const group: DuplicateGroup = { id: 'g', version: 'v', kind: 'exact', owner_id: 'u1', recommended_id: 'p1', score: 1, reason: 'identical', items: ['p1', 'p2'].map((id, i) => ({
  id, filename: `${id}.jpg`, owner_id: 'u1', folder_id: `f${i}`, folder_path: `users/u1/f${i}`, mime_type: 'image/jpeg', size: 1000, width: 300, height: 200,
  captured_at: '2026-10-01T00:00:00Z', captured_at_source: 'exif', has_favorites: i === 0, has_shares: i === 1, has_face_annotations: false, is_live_photo: false,
  sharpness: 50, exposure: .95, review: { id, checksum: 'checksum', revision: 'revision', motion: 'static' },
})) };
const page = (items: DuplicateGroup[]) => ({ items, next_cursor: '', skipped: 0 });

describe('duplicate cleanup review', () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; localStorage.clear(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });
  async function render(overrides: Partial<DuplicatesAPI> = {}, role: 'admin' | 'user' = 'admin') {
    const duplicates = { config: vi.fn().mockResolvedValue({ ai_enabled: true }), groups: vi.fn().mockResolvedValue(page([group])), jobs: vi.fn().mockResolvedValue({ items: [] }), start: vi.fn(), control: vi.fn(), cleanup: vi.fn().mockResolvedValue({ deleted_ids: ['p2'], failed: [] }), ...overrides };
    await act(async () => { root.render(<I18nProvider><DuplicatesWorkspace api={{ duplicates } as ApiClient} currentUser={{ ...user, role }} /></I18nProvider>); }); return duplicates;
  }
  async function click(label: string) { const b = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === label); if (!b) throw new Error(`Missing ${label}`); await act(async () => b.click()); }
  it('requires explicit selection and confirmation and sends the reviewed version', async () => {
    const api = await render();
    expect(container.textContent).toContain('照片分享链接会失效');
    expect(container.querySelector<HTMLInputElement>('input[type="radio"]')?.checked).toBe(true);
    expect([...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(x => !x.checked)).toBe(true);
    await click('选择其他副本'); await click('检查清理选择'); expect(api.cleanup).not.toHaveBeenCalled();
    await click('确认移入回收站'); expect(api.cleanup).toHaveBeenCalledWith({ group_id: 'g', version: 'v', kind: 'exact', keep_id: 'p1', remove_ids: ['p2'], confirm: true });
  });
  it('changing the keeper clears its delete selection and pending confirmation', async () => {
    const api = await render(); await click('选择其他副本'); await click('检查清理选择');
    await act(async () => container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].click());
    expect(container.textContent).not.toContain('磁盘空间会在永久删除');
    const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'); expect(checkboxes[1].checked).toBe(false); expect(checkboxes[1].disabled).toBe(true); expect(api.cleanup).not.toHaveBeenCalled();
  });
  it('shows a refresh instruction when the group changed', async () => {
    const api = await render({ cleanup: vi.fn().mockRejectedValue(new ApiError(409, 'DUPLICATE_GROUP_CHANGED', 'changed')) });
    await click('选择其他副本'); await click('检查清理选择'); await click('确认移入回收站');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('刷新后重新检查'); expect(api.cleanup).toHaveBeenCalledTimes(1);
  });
  it('does not expose the tools or call APIs to ordinary users', async () => { const api = await render({}, 'user'); expect(container.textContent).toBe(''); expect(api.groups).not.toHaveBeenCalled(); expect(api.config).not.toHaveBeenCalled(); });
  it('supports explicit bulk selection for AI suggestions and labels similarity correctly', async () => {
    const aiGroup = { ...group, kind: 'ai' as const, reason: 'local_features' as const, score: .96 };
    await render({ groups: vi.fn(async kind => page(kind === 'ai' ? [aiGroup] : [group])) }); await click('AI 相似');
    expect(container.textContent).toContain('局部细节匹配'); expect(container.textContent).toContain('相似度不是重复概率'); expect(container.textContent).toContain('选择其他副本');
    expect([...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(x => !x.checked)).toBe(true);
  });
  it('uses the preferred folder as an editable keeper suggestion', async () => {
    await render(); const input = container.querySelector<HTMLInputElement>('.duplicate-preference input')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'users/u1/f1'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].checked).toBe(true);
  });
  function aiGroup(id: string, ids: string[]): DuplicateGroup {
    return { ...group, id, kind: 'ai', reason: 'local_features', recommended_id: ids[0], items: ids.map((id, i) => ({ ...group.items[i % 2], id, filename: `${id}.jpg` })) };
  }
  it('reviews and cleans multiple AI groups with one confirmation', async () => {
    const groups = [aiGroup('a', ['a1', 'a2']), aiGroup('b', ['b1', 'b2'])];
    const api = await render({ groups: vi.fn().mockResolvedValue(page(groups)) });
    await click('AI 相似'); await click('每组保留一张，选择其余照片'); await click('检查批量清理');
    const review = container.querySelector('[aria-label="检查批量清理"]')!;
    expect(review.textContent).toContain('a1.jpg'); expect(review.textContent).toContain('b2.jpg');
    expect(api.cleanup).not.toHaveBeenCalled(); await click('确认批量移入回收站');
    expect(api.cleanup).toHaveBeenCalledTimes(2);
    expect(api.cleanup).toHaveBeenNthCalledWith(1, { group_id: 'a', kind: 'ai', version: 'v', keep_id: 'a1', remove_ids: ['a2'], confirm: true });
    expect(api.cleanup).toHaveBeenNthCalledWith(2, { group_id: 'b', kind: 'ai', version: 'v', keep_id: 'b1', remove_ids: ['b2'], confirm: true });
  });
  it('skips overlapping groups instead of deleting a selected keeper', async () => {
    const api = await render({ groups: vi.fn().mockResolvedValue(page([aiGroup('a', ['a1', 'a2']), aiGroup('b', ['a2', 'b2'])])) });
    await click('每组保留一张，选择其余照片');
    expect(container.textContent).toContain('已跳过选择冲突');
    await click('检查批量清理'); await click('确认批量移入回收站');
    expect(api.cleanup).toHaveBeenCalledTimes(1);
  });
  it('blocks manually conflicting selections and invalidates review on edits', async () => {
    const api = await render({ groups: vi.fn().mockResolvedValue(page([aiGroup('a', ['a1', 'a2']), aiGroup('b', ['a2', 'b2'])])) });
    await click('每组保留一张，选择其余照片'); await click('检查批量清理');
    await act(async () => container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[3].click());
    expect(container.querySelector('[aria-label="检查批量清理"]')).toBeNull();
    expect(container.textContent).toContain('同时被选为保留和清理');
    expect([...container.querySelectorAll('button')].find(b => b.textContent === '检查批量清理')?.disabled).toBe(true);
    expect(api.cleanup).not.toHaveBeenCalled();
  });
  it('stops after a partial failure and reports completed deletions', async () => {
    const cleanup = vi.fn().mockResolvedValueOnce({ deleted_ids: ['a2'], failed: [] }).mockRejectedValueOnce(new ApiError(409, 'DUPLICATE_GROUP_CHANGED', 'changed'));
    await render({ cleanup, groups: vi.fn().mockResolvedValue(page([aiGroup('a', ['a1', 'a2']), aiGroup('b', ['b1', 'b2']), aiGroup('c', ['c1', 'c2'])])) });
    await click('每组保留一张，选择其余照片'); await click('检查批量清理'); await click('确认批量移入回收站');
    expect(cleanup).toHaveBeenCalledTimes(2); expect(container.textContent).toContain('已移入回收站: 1');
    expect(container.textContent).toContain('批量清理已停止'); expect(container.textContent).toContain('刷新后重新检查');
    expect([...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(x => !x.checked)).toBe(true);
  });
  it('only selects loaded groups and requires another selection after loading more', async () => {
    const groups = vi.fn().mockResolvedValueOnce({ ...page([aiGroup('a', ['a1', 'a2'])]), next_cursor: 'next' }).mockResolvedValue(page([aiGroup('b', ['b1', 'b2'])]));
    const api = await render({ groups }); await click('每组保留一张，选择其余照片'); await click('检查批量清理'); await click('加载更多');
    expect(container.querySelector('[aria-label="检查批量清理"]')).toBeNull();
    expect(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[3].checked).toBe(false);
    await click('检查批量清理'); await click('确认批量移入回收站'); expect(api.cleanup).toHaveBeenCalledTimes(1);
  });

});
