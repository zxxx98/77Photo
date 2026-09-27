// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../app/I18nProvider';
import FaceScanPanel from './FaceScanPanel';
import PeopleWorkspace from './PeopleWorkspace';
import type { FacesAPI, FaceJob } from './types';
import type { ApiClient } from '../../app/api';

let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem('77photo.locale', 'en'); vi.useFakeTimers();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });
const job: FaceJob = { id: 'j1', mode: 'incremental', status: 'paused_offline', error: '', created_at: '', updated_at: '', counts: { total: 4, pending: 2, succeeded: 2, failed: 0, skipped: 0, cancelled: 0 } };
function api() { return { config: vi.fn().mockResolvedValue({ enabled: true, configured: true, automatic_matching: true }), jobs: vi.fn().mockResolvedValue({ items: [job] }), control: vi.fn().mockResolvedValue(job), people: vi.fn().mockResolvedValue({ items: [], next_cursor: '' }) } as unknown as FacesAPI; }
it('restores offline progress and requires an explicit continue', async () => {
  const f = api(); await act(async () => { root.render(<I18nProvider><FaceScanPanel api={f} /></I18nProvider>); });
  expect(container.textContent).toContain('2 / 4'); expect(container.textContent).toContain('Computer offline');
  await act(async () => { vi.advanceTimersByTime(4000); }); expect(f.control).not.toHaveBeenCalled();
  const buttons = [...container.querySelectorAll('button')];
  expect(buttons.find(b => b.textContent === 'Scan new photos')?.disabled).toBe(true);
  await act(async () => { buttons.find(b => b.textContent === 'Continue')?.click(); });
  expect(f.control).toHaveBeenCalledWith('j1', 'resume');
});
it('never requests people or task data for a non-administrator', async () => {
  const f = api(); await act(async () => { root.render(<I18nProvider><PeopleWorkspace api={{ faces: f } as ApiClient} currentUser={{ id: 'u', username: 'member', role: 'user', is_active: true }} /></I18nProvider>); });
  expect(f.people).not.toHaveBeenCalled(); expect(f.jobs).not.toHaveBeenCalled(); expect(container.textContent).toBe('');
});
