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
function api() { return { config: vi.fn().mockResolvedValue({ enabled: true, configured: true, automatic_matching: true, match_threshold: 0.55, match_margin: 0.08, concurrency: 4 }), jobs: vi.fn().mockResolvedValue({ items: [job] }), control: vi.fn().mockResolvedValue(job), people: vi.fn().mockResolvedValue({ items: [], next_cursor: '' }) } as unknown as FacesAPI; }
it('restores offline progress and requires an explicit continue', async () => {
  const f = api(); await act(async () => { root.render(<I18nProvider><FaceScanPanel api={f} /></I18nProvider>); });
  expect(container.textContent).toContain('2 / 4'); expect(container.textContent).toContain('Computer offline');
  await act(async () => { vi.advanceTimersByTime(4000); }); expect(f.control).not.toHaveBeenCalled();
  const buttons = [...container.querySelectorAll('button')];
  expect(buttons.find(b => b.textContent === 'Scan new photos')?.disabled).toBe(true);
  await act(async () => { buttons.find(b => b.textContent === 'Continue')?.click(); });
  expect(f.control).toHaveBeenCalledWith('j1', 'resume');
});
it('keeps whole-library actions in a settings card and confirms them before starting', async () => {
  const f = api();
  f.jobs = vi.fn().mockResolvedValue({ items: [] });
  f.start = vi.fn().mockResolvedValue(job);
  await act(async () => { root.render(<I18nProvider><FaceScanPanel api={f} placement="settings" /></I18nProvider>); });
  expect(container.querySelector('.settings-card')?.textContent).toContain('Rescan all photos');
  expect(container.textContent).toContain('Threshold: 0.55');
  await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent === 'Rescan all photos')?.click(); });
  expect(f.start).not.toHaveBeenCalled();
  await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent === 'Confirm operation')?.click(); });
  expect(f.start).toHaveBeenCalledWith('full', expect.any(String));
  await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent === 'Regroup saved faces')?.click(); });
  await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent === 'Confirm operation')?.click(); });
  expect(f.start).toHaveBeenCalledWith('regroup', expect.any(String));
});
it('keeps whole-library actions off the people page', async () => {
  const f = api();
  await act(async () => { root.render(<I18nProvider><PeopleWorkspace api={{ faces: f } as ApiClient} currentUser={{ id: 'u', username: 'admin', role: 'admin', is_active: true }} /></I18nProvider>); });
  expect(container.textContent).toContain('Scan new photos');
  expect(container.textContent).not.toContain('Regroup saved faces');
  expect(container.textContent).not.toContain('Rescan all photos');
});
it('shows the photo whose manual correction could not be carried over', async () => {
  const f = api();
  f.jobs = vi.fn().mockResolvedValue({ items: [{ ...job, status: 'completed_with_errors', counts: { ...job.counts, pending: 0, failed: 1 } }] });
  f.failedItems = vi.fn().mockResolvedValue({ items: [{ photo_id: 'p1', filename: 'family.jpg', error: 'MANUAL_FACE_UNMATCHED' }], next_cursor: '' });
  await act(async () => { root.render(<I18nProvider><FaceScanPanel api={f} /></I18nProvider>); });
  await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent === 'Show failed photos')?.click(); });
  expect(container.textContent).toContain('family.jpg: Manual face was not found; old result was kept.');
});
it('never requests people or task data for a non-administrator', async () => {
  const f = api(); await act(async () => { root.render(<I18nProvider><PeopleWorkspace api={{ faces: f } as ApiClient} currentUser={{ id: 'u', username: 'member', role: 'user', is_active: true }} /></I18nProvider>); });
  expect(f.people).not.toHaveBeenCalled(); expect(f.jobs).not.toHaveBeenCalled(); expect(container.textContent).toBe('');
});
it('shows saved-vector suggestions and merges only after confirmation', async () => {
  const source = { id: 'pe_source', owner_id: 'u', name: '', revision: 1, photo_count: 1, cover_face_id: 'fc_1' };
  const target = { id: 'pe_target', owner_id: 'u', name: 'Alex', revision: 2, photo_count: 3, cover_face_id: 'fc_2' };
  const f = api();
  f.people = vi.fn().mockResolvedValue({ items: [source, target], next_cursor: '' });
  f.listFaces = vi.fn().mockResolvedValue({ items: [], next_cursor: '' });
  f.similarPeople = vi.fn().mockResolvedValue({ items: [{ person: target, score: 0.76 }] });
  f.merge = vi.fn().mockResolvedValue({ ok: true });
  await act(async () => { root.render(<I18nProvider><PeopleWorkspace api={{ faces: f } as ApiClient} currentUser={{ id: 'u', username: 'admin', role: 'admin', is_active: true }} /></I18nProvider>); });
  await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent?.includes('pe_source'.slice(-6)))?.click(); });
  expect(f.similarPeople).toHaveBeenCalledWith(source.id);
  expect(container.textContent).toContain('Similarity: 0.76');
  expect(f.merge).not.toHaveBeenCalled();
  await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Similarity: 0.76'))?.click(); });
  expect(f.merge).not.toHaveBeenCalled();
  await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent === 'Confirm merge')?.click(); });
  expect(f.merge).toHaveBeenCalledWith(target, source);
});
