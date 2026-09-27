// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiClient, type RescanJob } from '../../app/api';
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
    window.history.replaceState(null, '', '#/');
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function renderWith(api: ApiClient) {
    const withDefaults = { ...api, getMaintenance: api.getMaintenance ?? vi.fn().mockResolvedValue({ active: null }) } as ApiClient;
    await act(async () => {
      root.render(<I18nProvider><SettingsWorkspace api={withDefaults} currentUser={admin} /></I18nProvider>);
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
      rescanButton()?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getRescan).toHaveBeenCalledWith('scan_1');
    expect(container.textContent).toContain('已扫描 12');
    expect(rescanButton()?.disabled).toBe(true);
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('扫描完成');
    expect(container.textContent).toContain('新增 3');
    expect(rescanButton()?.disabled).toBe(false);
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('100');
  });

  it('shows processing progress and the thumbnail phase before completion', async () => {
    const getRescan = vi.fn()
      .mockResolvedValueOnce({ ...running, phase: 'indexing', total: 12, processed: 6 })
      .mockResolvedValueOnce({ ...running, phase: 'thumbnails', total: 12, processed: 12 })
      .mockResolvedValueOnce({ ...completed, total: 12, processed: 12 });
    await renderWith({ listUsers: vi.fn().mockResolvedValue({ items: [] }),
      startRescan: vi.fn().mockResolvedValue(queued), getRescan } as unknown as ApiClient);
    await act(async () => { rescanButton()?.click(); });
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
    expect(cleanupBrokenPhotos).toHaveBeenCalledWith(['p1', 'p2']);
    expect(scanBrokenPhotos).toHaveBeenCalledTimes(1);
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
      rescanButton()?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('扫描失败');
    expect(rescanButton()?.disabled).toBe(false);
    const calls = getRescan.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(getRescan).toHaveBeenCalledTimes(calls);
  });

  it('re-attaches to a running maintenance job and locks every maintenance action', async () => {
    const getRescan = vi.fn().mockResolvedValue(running);
    await renderWith({
      listUsers: vi.fn().mockResolvedValue({ items: [admin] }),
      getMaintenance: vi.fn().mockResolvedValue({ active: { kind: 'rescan', job_id: 'scan_1' } }),
      getRescan,
    } as unknown as ApiClient);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(getRescan).toHaveBeenCalledWith('scan_1');
    expect(container.textContent).toContain('已扫描 12');
    const labels = ['重新扫描', '重置并重新扫描', '重新生成缩略图', '扫描坏照片', '开始导入'];
    for (const label of labels) {
      const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.textContent?.includes(label));
      expect(button?.disabled, label).toBe(true);
    }
  });

  it('shows the running task when the server rejects a start with 409', async () => {
    const getMaintenance = vi.fn()
      .mockResolvedValueOnce({ active: null })
      .mockResolvedValueOnce({ active: { kind: 'cleanup' } })
      .mockResolvedValue({ active: null });
    await renderWith({
      listUsers: vi.fn().mockResolvedValue({ items: [] }),
      getMaintenance,
      startRescan: vi.fn().mockRejectedValue(new ApiError(409, 'MAINTENANCE_IN_PROGRESS', 'busy')),
    } as unknown as ApiClient);

    await act(async () => {
      rescanButton()?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('坏照片清理正在进行');
    expect(rescanButton()?.disabled).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain('坏照片清理正在进行');
    expect(rescanButton()?.disabled).toBe(false);
  });

  it('hides deleted accounts and never imports into an unavailable user', async () => {
    const deleted = { ...admin, is_active: false, deleted_at: '2026-09-20T00:00:00Z' };
    const disabled = { id: 'u3', username: 'disabled', role: 'user' as const, is_active: false };
    const member = { id: 'u2', username: 'family', role: 'user' as const, is_active: true };
    const job = { id: 'import_1', status: 'completed', counts: { scanned: 0, moved: 0, skipped: 0, failed: 0 } };
    const startImport = vi.fn().mockResolvedValue(job);
    await renderWith({
      listUsers: vi.fn().mockResolvedValue({ items: [deleted, disabled, member] }),
      startImport,
      getImport: vi.fn().mockResolvedValue(job),
    } as unknown as ApiClient);

    const rows = Array.from(container.querySelectorAll('.user-row')).map((row) => row.textContent);
    expect(rows.some((row) => row?.includes('admin'))).toBe(false);
    expect(container.querySelector('[role="combobox"][aria-label="目标用户"]')?.textContent).toContain('family');

    const form = container.querySelector('input[aria-label="导入目录"]')!.closest('form')!;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(startImport).toHaveBeenLastCalledWith({ source_path: '.', user_id: 'u2', organize_by_date: false });
  });

  it('explains why an account could not be created and clears the error on retry', async () => {
    const member = { id: 'u2', username: 'family', role: 'user' as const, is_active: true };
    const createUser = vi.fn()
      .mockRejectedValueOnce(new ApiError(422, 'PASSWORD_INVALID', 'invalid'))
      .mockResolvedValueOnce(member);
    await renderWith({ listUsers: vi.fn().mockResolvedValue({ items: [admin] }), createUser } as unknown as ApiClient);

    const username = container.querySelector<HTMLInputElement>('input[aria-label="用户名"]')!;
    const password = container.querySelector<HTMLInputElement>('input[aria-label="临时密码"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(username, 'family');
      username.dispatchEvent(new Event('input', { bubbles: true }));
      setValue.call(password, 'short');
      password.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const form = username.closest('form')!;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(container.textContent).toContain('密码需为 12–256 个字符');

    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(container.textContent).not.toContain('密码需为 12–256 个字符');
    expect(Array.from(container.querySelectorAll('.user-row')).some((row) => row.textContent?.includes('family'))).toBe(true);
  });

  function typeInto(input: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function rescanButton() {
    return buttonWithText('重新扫描文件');
  }

  function buttonWithText(text: string) {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.trim() === text || button.textContent?.includes(text));
  }

  it('lets any user change their own password', async () => {
    const changePassword = vi.fn()
      .mockRejectedValueOnce(new ApiError(422, 'CURRENT_PASSWORD_INCORRECT', 'wrong'))
      .mockResolvedValueOnce(undefined);
    const member = { id: 'u2', username: 'family', role: 'user' as const, is_active: true };
    await act(async () => {
      root.render(<I18nProvider><SettingsWorkspace api={{ changePassword, getMaintenance: vi.fn() } as unknown as ApiClient} currentUser={member} /></I18nProvider>);
      await Promise.resolve();
    });
    const current = container.querySelector<HTMLInputElement>('input[aria-label="当前密码"]')!;
    const next = container.querySelector<HTMLInputElement>('input[aria-label="新密码"]')!;
    const confirm = container.querySelector<HTMLInputElement>('input[aria-label="确认新密码"]')!;
    const form = current.closest('form')!;
    const submit = async () => { await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); };

    await act(async () => { typeInto(current, 'old passphrase'); typeInto(next, 'a brand new passphrase'); typeInto(confirm, 'something else entirely'); });
    await submit();
    expect(container.textContent).toContain('两次输入的新密码不一致');
    expect(changePassword).not.toHaveBeenCalled();

    await act(async () => { typeInto(confirm, 'a brand new passphrase'); });
    await submit();
    expect(changePassword).toHaveBeenLastCalledWith('old passphrase', 'a brand new passphrase');
    expect(container.textContent).toContain('当前密码不正确');

    await submit();
    expect(container.textContent).toContain('密码已更新');
    expect(current.value).toBe('');
  });

  it('creates administrators, switches roles and resets member passwords', async () => {
    const member = { id: 'u2', username: 'family', role: 'user' as const, is_active: true };
    const createUser = vi.fn().mockResolvedValue({ id: 'u3', username: 'grandpa', role: 'admin', is_active: true });
    const updateUser = vi.fn()
      .mockResolvedValueOnce({ ...member, role: 'admin' })
      .mockResolvedValueOnce({ ...member, role: 'admin' });
    await renderWith({ listUsers: vi.fn().mockResolvedValue({ items: [admin, member] }), createUser, updateUser } as unknown as ApiClient);

    const username = container.querySelector<HTMLInputElement>('input[aria-label="用户名"]')!;
    await act(async () => {
      typeInto(username, 'grandpa');
      typeInto(container.querySelector<HTMLInputElement>('input[aria-label="临时密码"]')!, 'grandpa passphrase');
    });
    await act(async () => { container.querySelector<HTMLButtonElement>('[role="group"][aria-label="角色"] button:last-child')!.click(); });
    await act(async () => { username.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(createUser).toHaveBeenCalledWith({ username: 'grandpa', password: 'grandpa passphrase', role: 'admin' });

    const familyRow = () => Array.from(container.querySelectorAll('.user-row')).find((row) => row.textContent?.includes('family'))!;
    const adminRow = Array.from(container.querySelectorAll('.user-row')).find((row) => row.textContent?.startsWith('admin'))!;
    expect(Array.from(adminRow.querySelectorAll('button')).find((button) => button.textContent === '设为成员')?.disabled).toBe(true);
    await act(async () => { Array.from(familyRow().querySelectorAll('button')).find((button) => button.textContent === '设为管理员')!.click(); });
    expect(updateUser).toHaveBeenLastCalledWith('u2', { role: 'admin' });

    await act(async () => { Array.from(familyRow().querySelectorAll('button')).find((button) => button.textContent === '重置密码')!.click(); });
    const resetInput = container.querySelector<HTMLInputElement>('input[aria-label="family 的新密码"]')!;
    await act(async () => { typeInto(resetInput, 'temporary passphrase'); });
    await act(async () => { resetInput.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(updateUser).toHaveBeenLastCalledWith('u2', { password: 'temporary passphrase' });
    expect(container.textContent).toContain('已重置 family 的密码');
    expect(container.querySelector('input[aria-label="family 的新密码"]')).toBeNull();
  });

  it('deletes a member and can transfer their photos to another member', async () => {
    const family = { id: 'u2', username: 'family', role: 'user' as const, is_active: true };
    const kid = { id: 'u3', username: 'kid', role: 'user' as const, is_active: true };
    const deleteUser = vi.fn().mockResolvedValue(undefined);
    await renderWith({ listUsers: vi.fn().mockResolvedValue({ items: [admin, family, kid] }), deleteUser } as unknown as ApiClient);

    const kidRow = Array.from(container.querySelectorAll('.user-row')).find((row) => row.textContent?.includes('kid'))!;
    await act(async () => { Array.from(kidRow.querySelectorAll('button')).find((button) => button.textContent === '删除')!.click(); });
    expect(container.textContent).toContain('删除 kid？');
    await act(async () => { buttonWithText('转给其他成员')!.click(); });
    const picker = container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="接收照片的成员"]')!;
    expect(picker.textContent).toContain('admin');
    await act(async () => { picker.click(); });
    await act(async () => { Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((option) => option.textContent?.includes('family'))!.click(); });
    await act(async () => { buttonWithText('确认删除')!.click(); await Promise.resolve(); });

    expect(deleteUser).toHaveBeenCalledWith('u3', { photo_action: 'transfer', transfer_to_user_id: 'u2' });
    expect(container.textContent).toContain('已删除 kid，其照片已转给 family');
    expect(Array.from(container.querySelectorAll('.user-row')).some((row) => row.textContent?.includes('kid'))).toBe(false);
  });

  it('shows tabs only to administrators and keeps the selected tab in the URL', async () => {
    window.history.replaceState(null, '', '#/settings?section=library');
    await renderWith({ listUsers: vi.fn().mockResolvedValue({ items: [admin] }) } as unknown as ApiClient);
    const tab = (name: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((item) => item.textContent?.includes(name))!;
    const panel = (id: string) => container.querySelector<HTMLElement>(`#settings-panel-${id}`)!;

    expect(Array.from(container.querySelectorAll('[role="tab"]')).map((item) => item.textContent)).toEqual(['我的账户', '家庭成员', '图库维护']);
    expect(tab('图库维护').getAttribute('aria-selected')).toBe('true');
    expect(panel('library').hidden).toBe(false);
    expect(panel('account').hidden).toBe(true);

    await act(async () => { tab('家庭成员').click(); });
    expect(window.location.hash).toBe('#/settings?section=members');
    expect(panel('members').hidden).toBe(false);
    expect(panel('library').hidden).toBe(true);

    await act(async () => { tab('家庭成员').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect(tab('图库维护').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab('图库维护'));
    await act(async () => { tab('图库维护').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); });
    expect(tab('我的账户').getAttribute('aria-selected')).toBe('true');
    expect(window.location.hash).toBe('#/settings');

    act(() => root.unmount());
    root = createRoot(container);
    const member = { id: 'u2', username: 'family', role: 'user' as const, is_active: true };
    await act(async () => {
      root.render(<I18nProvider><SettingsWorkspace api={{} as ApiClient} currentUser={member} /></I18nProvider>);
      await Promise.resolve();
    });
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector('#settings-panel-members')).toBeNull();
    expect(container.textContent).toContain('修改密码');
  });

  it('keeps the reset action in the danger zone with its notes collapsed', async () => {
    await renderWith({ listUsers: vi.fn().mockResolvedValue({ items: [admin] }) } as unknown as ApiClient);
    const danger = container.querySelector('.settings-card.is-danger')!;
    expect(danger.textContent).toContain('危险操作');
    expect(Array.from(danger.querySelectorAll('button')).some((button) => button.textContent?.includes('重置并重新扫描'))).toBe(true);
    const scanCard = rescanButton()!.closest('.settings-card')!;
    expect(Array.from(scanCard.querySelectorAll('button')).some((button) => button.textContent?.includes('重置'))).toBe(false);
    const details = danger.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('原始照片/视频、用户和文件夹不会被删除');
  });

  it('shows a running face scan as the current maintenance task', async () => {
    await renderWith({
      listUsers: vi.fn().mockResolvedValue({ items: [admin] }),
      getMaintenance: vi.fn().mockResolvedValue({ active: { kind: 'face_scan' } }),
    } as unknown as ApiClient);
    await act(async () => { await Promise.resolve(); });

    expect(container.textContent).toContain('人脸扫描正在进行');
    expect(container.querySelector('#settings-tab-library .settings-tab-dot')).not.toBeNull();
    expect(rescanButton()?.disabled).toBe(true);
  });
});

