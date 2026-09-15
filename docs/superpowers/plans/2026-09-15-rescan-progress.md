# Rescan Progress Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add live rescan status, an honest indeterminate progress bar, and scan counters to the administrator settings page.

**Architecture:** Extend the existing API client with the already-supported rescan status endpoint. The settings page owns the current job snapshot and uses a serial `setTimeout` polling loop that stops on completion/failure or unmount; it displays live counters without adding a filesystem counting pass.

**Tech Stack:** React 18, TypeScript, Vitest/jsdom, existing i18n dictionaries, existing CSS progress-track styles, Go HTTP API (unchanged).

---

### Task 1: Add the rescan status API contract

**Files:**
- Modify: `web/src/app/api.ts:1-137,188-262`
- Test: `web/src/app/api.test.ts:1-130`

- [ ] **Step 1: Write the failing API client test**

Add this test inside `describe('API client', ...)`:

```ts
  it('loads a rescan job status by id', async () => {
    const job = {
      id: 'scan_1',
      status: 'running',
      started_at: '2026-09-15T01:00:00Z',
      counts: { scanned: 12, added: 3, updated: 8, missing: 1, failed: 0 },
    };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(job), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const client = createApiClient(fetcher as typeof fetch);

    await expect(client.getRescan('scan_1')).resolves.toEqual(job);
    expect(fetcher).toHaveBeenCalledWith(
      '/api/v1/admin/rescan/scan_1',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });
```

- [ ] **Step 2: Run the focused test and verify it fails for the missing API method**

Run: `npm test -- src/app/api.test.ts`

Expected: FAIL because `ApiClient` has no `getRescan` method.

- [ ] **Step 3: Implement the minimal API types and method**

Add these definitions before `ApiClient`:

```ts
export type RescanStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface RescanCounts {
  scanned: number;
  added: number;
  updated: number;
  missing: number;
  failed: number;
}

export interface RescanJob {
  id: string;
  status: RescanStatus;
  started_at: string;
  finished_at?: string;
  counts: RescanCounts;
  error?: string;
}
```

Change the interface methods to:

```ts
  startRescan(): Promise<RescanJob>;
  getRescan(id: string): Promise<RescanJob>;
```

Add these client methods beside `startRescan`:

```ts
    startRescan: () => request<RescanJob>('/api/v1/admin/rescan', { method: 'POST', body: JSON.stringify({}) }) as Promise<RescanJob>,
    getRescan: (id) => request<RescanJob>(`/api/v1/admin/rescan/${encodeURIComponent(id)}`) as Promise<RescanJob>,
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `npm test -- src/app/api.test.ts`

Expected: PASS with 9 tests.

- [ ] **Step 5: Commit the API contract**

```bash
git add web/src/app/api.ts web/src/app/api.test.ts
git commit -m "feat: expose rescan status to web client"
```

### Task 2: Add bilingual scan status copy

**Files:**
- Modify: `web/src/app/i18n.ts:197-218,406-427`

- [ ] **Step 1: Add the complete English settings strings**

Add the following keys after `settings.scanFailed` in the English dictionary:

```ts
  'settings.scanRunning': 'Scanning…',
  'settings.scanCompleted': 'Scan complete',
  'settings.scanRunFailed': 'Scan failed.',
  'settings.scanPollFailed': 'Unable to read scan progress. Retrying…',
  'settings.scanScanned': '{count} scanned',
  'settings.scanAdded': '{count} added',
  'settings.scanUpdated': '{count} updated',
  'settings.scanMissing': '{count} missing',
  'settings.scanErrors': '{count} failed',
```

- [ ] **Step 2: Add the matching Chinese settings strings**

Add the following keys in the Chinese dictionary:

```ts
  'settings.scanRunning': '正在扫描…',
  'settings.scanCompleted': '扫描完成',
  'settings.scanRunFailed': '扫描失败。',
  'settings.scanPollFailed': '无法读取扫描进度，正在重试…',
  'settings.scanScanned': '已扫描 {count}',
  'settings.scanAdded': '新增 {count}',
  'settings.scanUpdated': '已更新 {count}',
  'settings.scanMissing': '缺失 {count}',
  'settings.scanErrors': '失败 {count}',
```

- [ ] **Step 3: Run the i18n tests**

Run: `npm test -- src/app/i18n.test.ts src/app/i18nCoverage.test.ts`

Expected: PASS with all translation keys covered.

- [ ] **Step 4: Commit the translated copy**

```bash
git add web/src/app/i18n.ts
git commit -m "feat: translate rescan progress states"
```

### Task 3: Implement polling and progress display in settings

**Files:**
- Modify: `web/src/features/settings/SettingsWorkspace.tsx:1-20`
- Modify: `web/src/styles/global.css:124-132,230-231`
- Test: Create `web/src/features/settings/SettingsWorkspace.test.tsx`

- [ ] **Step 1: Write the failing settings workspace tests**

Create `web/src/features/settings/SettingsWorkspace.test.tsx` with this setup and tests:

```tsx
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
```

- [ ] **Step 2: Run the focused settings tests and verify they fail**

Run: `npm test -- src/features/settings/SettingsWorkspace.test.tsx`

Expected: FAIL because the API method, polling state, status markup, and progress styles do not exist yet.

- [ ] **Step 3: Implement the settings polling state and markup**

Update the imports and state in `SettingsWorkspace.tsx`:

```tsx
import { FormEvent, useEffect, useState } from 'react';
import { ShieldCheck, UserRound, RefreshCw } from 'lucide-react';
import { useI18n } from '../../app/I18nProvider';
import type { ApiClient, RescanJob, User } from '../../app/api';
```

Add the scan job state, status helpers, and polling effect inside the component:

```tsx
  const { t, formatCount } = useI18n();
  const [scanJob, setScanJob] = useState<RescanJob | null>(null);
  const scanActive = scanJob?.status === 'queued' || scanJob?.status === 'running';

  useEffect(() => {
    const id = scanJob?.id;
    if (!id) return;
    let disposed = false;
    let timer: number | undefined;

    async function poll() {
      try {
        const next = await api.getRescan(id);
        if (disposed) return;
        setScanJob(next);
        if (next.status === 'queued' || next.status === 'running') {
          timer = window.setTimeout(() => void poll(), 1000);
        }
      } catch {
        if (disposed) return;
        setScanMessage(t('settings.scanPollFailed'));
        timer = window.setTimeout(() => void poll(), 1000);
      }
    }

    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [api, scanJob?.id, t]);
```

Replace `rescan` with:

```tsx
  async function rescan() {
    setScanMessage(null);
    try {
      setScanJob(await api.startRescan());
    } catch {
      setScanJob(null);
      setScanMessage(t('settings.scanFailed'));
    }
  }
```

Render the scan section using these derived values before the return statement:

```tsx
  const scanStatusLabel = scanJob?.status === 'running'
    ? t('settings.scanRunning')
    : scanJob?.status === 'completed'
      ? t('settings.scanCompleted')
      : scanJob?.status === 'failed'
        ? t('settings.scanRunFailed')
        : t('settings.scanQueued');
  const counts = scanJob?.counts;
```

Use this JSX in place of the existing scan heading/message:

```tsx
<div className="settings-section-heading scan-heading">
  <h2>{t('settings.libraryIndex')}</h2>
  <button className="button button-secondary" disabled={scanActive} onClick={() => void rescan()}>
    <RefreshCw size={15} /> {t('settings.rescanFiles')}
  </button>
</div>
{scanMessage && <p className="inline-state" role="alert">{scanMessage}</p>}
{scanJob && counts && <div className="scan-progress" role="status" aria-live="polite">
  <div className="scan-progress-heading">
    <span>{scanStatusLabel}</span>
    <span>{formatCount(counts.scanned)}</span>
  </div>
  <div
    className={`progress-track scan-progress-track ${scanActive ? 'is-active' : ''}`}
    role="progressbar"
    aria-label={scanStatusLabel}
    aria-valuemin={0}
    aria-valuemax={100}
    {...(scanJob.status === 'completed' ? { 'aria-valuenow': 100 } : {})}
  >
    <span className={scanJob.status === 'completed' ? 'is-complete' : ''} />
  </div>
  <div className="scan-progress-counts">
    <span>{t('settings.scanScanned', { count: formatCount(counts.scanned) })}</span>
    <span>{t('settings.scanAdded', { count: formatCount(counts.added) })}</span>
    <span>{t('settings.scanUpdated', { count: formatCount(counts.updated) })}</span>
    <span>{t('settings.scanMissing', { count: formatCount(counts.missing) })}</span>
    <span>{t('settings.scanErrors', { count: formatCount(counts.failed) })}</span>
  </div>
</div>}
```

- [ ] **Step 4: Add restrained active-progress styles**

Add these rules near the existing progress styles in `global.css`:

```css
.scan-progress { display: grid; gap: 10px; margin: 22px 0 0; }
.scan-progress-heading { display: flex; align-items: center; justify-content: space-between; color: var(--slate-soft); font-size: 12px; }
.scan-progress-track { margin-top: 0; }
.scan-progress-track.is-active span { width: 34%; animation: scan-progress 1.4s ease-in-out infinite; }
.scan-progress-track span.is-complete { width: 100%; }
.scan-progress-counts { display: flex; flex-wrap: wrap; gap: 7px 16px; color: var(--slate-soft); font-size: 11px; }
@keyframes scan-progress { 0% { transform: translateX(-125%); } 50% { transform: translateX(115%); } 100% { transform: translateX(290%); } }
```

- [ ] **Step 5: Run the focused settings tests and verify they pass**

Run: `npm test -- src/features/settings/SettingsWorkspace.test.tsx`

Expected: PASS with 2 tests.

- [ ] **Step 6: Commit the settings progress UI**

```bash
git add web/src/features/settings/SettingsWorkspace.tsx web/src/features/settings/SettingsWorkspace.test.tsx web/src/styles/global.css
git commit -m "feat: show live rescan progress"
```

### Task 4: Run the complete verification suite

**Files:**
- Verify: `web/src/app/api.ts`, `web/src/app/api.test.ts`, `web/src/app/i18n.ts`, `web/src/features/settings/SettingsWorkspace.tsx`, `web/src/features/settings/SettingsWorkspace.test.tsx`, `web/src/styles/global.css`

- [ ] **Step 1: Run all frontend tests**

Run: `npm test`

Expected: all test files pass, including the new settings progress test.

- [ ] **Step 2: Run frontend type checking and production build**

Run: `npm run typecheck && npm run build`

Expected: both commands exit 0 and Vite emits the production bundle.

- [ ] **Step 3: Run Go tests and vet to confirm the unchanged backend remains healthy**

Run: `go test ./... && go vet ./...`

Expected: all Go packages pass and vet reports no issues.

- [ ] **Step 4: Check the final worktree**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only the intentional feature commits and the user's pre-existing uncommitted `compose.yaml` change are present.
