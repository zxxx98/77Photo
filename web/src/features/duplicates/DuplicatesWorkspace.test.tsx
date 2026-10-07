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
  it('requires manual selection for AI suggestions and labels similarity correctly', async () => {
    const aiGroup = { ...group, kind: 'ai' as const, reason: 'local_features' as const, score: .96 };
    await render({ groups: vi.fn(async kind => page(kind === 'ai' ? [aiGroup] : [group])) }); await click('AI 相似');
    expect(container.textContent).toContain('局部细节匹配'); expect(container.textContent).toContain('相似度不是重复概率'); expect(container.textContent).not.toContain('选择其他副本');
    expect([...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(x => !x.checked)).toBe(true);
  });
  it('uses the preferred folder as an editable keeper suggestion', async () => {
    await render(); const input = container.querySelector<HTMLInputElement>('.duplicate-preference input')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'users/u1/f1'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].checked).toBe(true);
  });
});
