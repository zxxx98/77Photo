// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ApiClient, ManagedShareLink } from '../../app/api';
import { I18nProvider } from '../../app/I18nProvider';
import ManagedSharesSection from './ManagedSharesSection';

const link: ManagedShareLink = { id: 'sl_1', resource_type: 'folder', resource_id: 'f_1', resource_name: 'Family album', created_at: '2026-09-01T00:00:00Z', expires_at: null, revoked_at: null, password_protected: true, status: 'active' };
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); window.history.replaceState(null, '', '#/'); });
function button(label: string): HTMLButtonElement { const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label); if (!found) throw new Error(`button ${label} missing`); return found; }

it('filters links and retries a failed revoke without losing confirmation', async () => {
  const listManagedShareLinks = vi.fn().mockResolvedValue({ items: [link] });
  const revokeManagedShareLink = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  const api = { listManagedShareLinks, revokeManagedShareLink } as unknown as ApiClient;
  await act(async () => { root.render(<I18nProvider><ManagedSharesSection api={api} onOpenFolder={() => {}} /></I18nProvider>); await Promise.resolve(); });
  expect(container.textContent).toContain('Family album');
  expect(container.textContent).toContain('已设密码');
  await act(async () => { button('撤销').click(); });
  const confirm = container.querySelector('.managed-share-confirm')!;
  await act(async () => { (confirm.querySelectorAll('button')[1] as HTMLButtonElement).click(); await Promise.resolve(); });
  expect(container.textContent).toContain('无法撤销此链接');
  expect(container.querySelector('.managed-share-confirm')).not.toBeNull();
  await act(async () => { (confirm.querySelectorAll('button')[1] as HTMLButtonElement).click(); await Promise.resolve(); await Promise.resolve(); });
  expect(revokeManagedShareLink).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain('分享链接已撤销');
  const select = container.querySelector('select')!;
  await act(async () => { select.value = 'expired'; select.dispatchEvent(new Event('change', { bubbles: true })); await Promise.resolve(); });
  expect(listManagedShareLinks).toHaveBeenLastCalledWith({ status: 'expired' });
});

it('shows an unavailable resource with a revoke action', async () => {
  const orphan = { ...link, status: 'unavailable' as const, resource_name: 'Deleted album' };
  const api = { listManagedShareLinks: vi.fn().mockResolvedValue({ items: [orphan] }) } as unknown as ApiClient;
  await act(async () => { root.render(<I18nProvider><ManagedSharesSection api={api} onOpenFolder={() => {}} /></I18nProvider>); await Promise.resolve(); });
  expect(container.textContent).toContain('Deleted album');
  expect(container.textContent).toContain('资源不可用');
  expect([...container.querySelectorAll('button')].some((item) => item.textContent === '打开原资源')).toBe(false);
  expect(button('撤销')).toBeDefined();
});

it('loads only shares for the resource passed from its share dialog', async () => {
  window.history.replaceState(null, '', '#/settings?resource_type=folder&resource_id=f_1');
  const listManagedShareLinks = vi.fn().mockResolvedValue({ items: [link] });
  const api = { listManagedShareLinks } as unknown as ApiClient;
  await act(async () => { root.render(<I18nProvider><ManagedSharesSection api={api} onOpenFolder={() => {}} /></I18nProvider>); await Promise.resolve(); });
  expect(listManagedShareLinks).toHaveBeenCalledWith({ resource_type: 'folder', resource_id: 'f_1' });
  await act(async () => { button('查看全部资源').click(); await Promise.resolve(); });
  expect(listManagedShareLinks).toHaveBeenLastCalledWith({});
});

it('retries a failed refresh from the first page even when more links were available', async () => {
  const updated = { ...link, resource_name: 'Updated album' };
  const listManagedShareLinks = vi.fn()
    .mockResolvedValueOnce({ items: [link], next_cursor: 'page_2' })
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ items: [updated], next_cursor: 'page_2' });
  const api = { listManagedShareLinks } as unknown as ApiClient;
  await act(async () => { root.render(<I18nProvider><ManagedSharesSection api={api} onOpenFolder={() => {}} /></I18nProvider>); });
  await act(async () => { button('刷新').click(); });
  await act(async () => { button('重试').click(); });
  expect(listManagedShareLinks).toHaveBeenLastCalledWith({});
  expect(container.querySelectorAll('.managed-share')).toHaveLength(1);
  expect(container.textContent).toContain('Updated album');
  expect(container.textContent).not.toContain('Family album');
});

it('retries a failed next page without dropping the links already loaded', async () => {
  const next = { ...link, id: 'sl_2', resource_name: 'Second album' };
  const listManagedShareLinks = vi.fn()
    .mockResolvedValueOnce({ items: [link], next_cursor: 'page_2' })
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ items: [next] });
  const api = { listManagedShareLinks } as unknown as ApiClient;
  await act(async () => { root.render(<I18nProvider><ManagedSharesSection api={api} onOpenFolder={() => {}} /></I18nProvider>); });
  await act(async () => { button('加载更多').click(); });
  expect(container.textContent).toContain('Family album');
  await act(async () => { button('重试').click(); });
  expect(listManagedShareLinks).toHaveBeenLastCalledWith({ cursor: 'page_2' });
  expect(container.querySelectorAll('.managed-share')).toHaveLength(2);
  expect(container.textContent).toContain('Second album');
});

it('keeps the current filter when a revoke finishes after the filter changes', async () => {
  let finishRevoke!: () => void;
  const revokeManagedShareLink = vi.fn(() => new Promise<void>((resolve) => { finishRevoke = resolve; }));
  const expired = { ...link, id: 'sl_expired', status: 'expired' as const, resource_name: 'Expired album' };
  const listManagedShareLinks = vi.fn().mockImplementation(async (filter) => ({ items: filter.status === 'expired' ? [expired] : [link] }));
  const api = { listManagedShareLinks, revokeManagedShareLink } as unknown as ApiClient;
  await act(async () => { root.render(<I18nProvider><ManagedSharesSection api={api} onOpenFolder={() => {}} /></I18nProvider>); });
  await act(async () => { button('撤销').click(); });
  await act(async () => { (container.querySelector('.managed-share-confirm button:last-child') as HTMLButtonElement).click(); });
  const select = container.querySelector('select')!;
  await act(async () => { select.value = 'expired'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => { finishRevoke(); });
  expect(listManagedShareLinks).toHaveBeenLastCalledWith({ status: 'expired' });
  expect(container.textContent).toContain('Expired album');
  expect(container.textContent).not.toContain('Family album');
});

it('keeps the list when navigating to the same resource filter', async () => {
  window.history.replaceState(null, '', '#/settings?resource_type=folder&resource_id=f_1');
  const listManagedShareLinks = vi.fn().mockResolvedValue({ items: [link] });
  const api = { listManagedShareLinks } as unknown as ApiClient;
  await act(async () => { root.render(<I18nProvider><ManagedSharesSection api={api} onOpenFolder={() => {}} /></I18nProvider>); });
  await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')); });
  expect(container.textContent).toContain('Family album');
});
