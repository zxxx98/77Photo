# Skeleton Loading and Folder Empty State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace page-level text spinners with content-shaped skeletons and replace the generic folder-empty message with an actionable photo-stack empty state.

**Architecture:** Add one focused loading-state module containing reusable accessible skeleton compositions, then select the correct composition from each existing request-state branch. Keep folder actions owned by the app shell: the folder workspace receives an upload callback and focuses its own existing create-folder input.

**Tech Stack:** React 18, TypeScript, Vitest, `react-dom/server`, Vite, CSS

---

## File Structure

- Create `web/src/features/loading/LoadingStates.tsx`: reusable skeleton block and page-shaped skeleton compositions.
- Create `web/src/features/loading/LoadingStates.test.tsx`: server-rendered markup and accessibility contract tests.
- Create `web/src/features/folders/FolderEmptyState.tsx`: selected photo-stack empty state and its two actions.
- Create `web/src/features/folders/FolderEmptyState.test.tsx`: empty-state structure, copy, and action contract tests.
- Modify `web/src/features/gallery/GalleryWorkspace.tsx`: use the gallery skeleton for initial loading.
- Modify `web/src/features/folders/FoldersWorkspace.tsx`: use list skeleton, empty-state component, upload callback, and input focus.
- Modify `web/src/features/sharing/PublicSharePage.tsx`: use public-page skeletons while retaining explicit unavailable/empty states.
- Modify `web/src/app/App.tsx`: use the shell skeleton and route folder uploads through the existing picker flow.
- Modify `web/src/app/i18n.ts`: add localized empty-state action and accessible loading copy.
- Modify `web/src/app/i18nCoverage.test.ts`: include the new modules in translation coverage.
- Modify `web/src/styles/global.css`: skeleton, shimmer, reduced-motion, and photo-stack empty-state styles.

### Task 1: Reusable Loading Compositions

**Files:**
- Create: `web/src/features/loading/LoadingStates.tsx`
- Create: `web/src/features/loading/LoadingStates.test.tsx`
- Modify: `web/src/styles/global.css`

- [ ] **Step 1: Write failing skeleton markup tests**

Create tests that render all four compositions and require `aria-busy`, a visually hidden status, decorative skeleton blocks, gallery tiles, and folder rows:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../app/I18nProvider';
import { AppShellSkeleton, FolderListSkeleton, GallerySkeleton, PublicShareSkeleton } from './LoadingStates';

function render(node: React.ReactNode) {
  return renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
}

describe('loading skeletons', () => {
  it('announces loading while hiding decorative blocks', () => {
    const markup = render(<GallerySkeleton />);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('class="sr-only"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('gallery-skeleton-tile');
  });

  it('matches each destination shape', () => {
    expect(render(<FolderListSkeleton />).match(/folder-skeleton-row/g)?.length).toBe(4);
    expect(render(<PublicShareSkeleton />)).toContain('public-skeleton-grid');
    expect(render(<AppShellSkeleton />)).toContain('app-shell-skeleton');
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `cd web && npm test -- src/features/loading/LoadingStates.test.tsx`

Expected: FAIL because `LoadingStates.tsx` does not exist.

- [ ] **Step 3: Implement the loading-state module**

Implement a private `LoadingRegion` that renders `role="status"`, `aria-live="polite"`, `aria-busy="true"`, a translated `.sr-only` message, and an `aria-hidden="true"` visual wrapper. Export `GallerySkeleton`, `FolderListSkeleton`, `PublicShareSkeleton`, and `AppShellSkeleton`. Use fixed placeholder counts to keep layout stable: eight gallery tiles, four folder rows, and eight public tiles.

- [ ] **Step 4: Add skeleton styling**

Add shared `.skeleton-block` geometry and a pseudo-element shimmer; mirror the real gallery, folder-list, public-grid, and shell dimensions. Use existing CSS variables, and disable shimmer animation inside `@media (prefers-reduced-motion: reduce)`.

- [ ] **Step 5: Run the test and verify GREEN**

Run: `cd web && npm test -- src/features/loading/LoadingStates.test.tsx`

Expected: PASS with 2 tests.

- [ ] **Step 6: Commit**

```bash
git add web/src/features/loading/LoadingStates.tsx web/src/features/loading/LoadingStates.test.tsx web/src/styles/global.css
git commit -m "feat: add content-shaped loading skeletons"
```

### Task 2: Actionable Folder Empty State

**Files:**
- Create: `web/src/features/folders/FolderEmptyState.tsx`
- Create: `web/src/features/folders/FolderEmptyState.test.tsx`
- Modify: `web/src/features/folders/FoldersWorkspace.tsx`
- Modify: `web/src/app/i18n.ts`
- Modify: `web/src/styles/global.css`

- [ ] **Step 1: Write failing empty-state tests**

Render `FolderEmptyState` with `vi.fn()` callbacks and assert the selected visual structure and localized actions exist:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../app/I18nProvider';
import FolderEmptyState from './FolderEmptyState';

describe('folder empty state', () => {
  it('offers upload and folder creation with the photo-stack visual', () => {
    const markup = renderToStaticMarkup(<I18nProvider><FolderEmptyState onUpload={vi.fn()} onCreateFolder={vi.fn()} /></I18nProvider>);
    expect(markup).toContain('folder-empty-photo-stack');
    expect(markup).toContain('上传照片');
    expect(markup).toContain('新建文件夹');
    expect(markup.match(/<button/g)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `cd web && npm test -- src/features/folders/FolderEmptyState.test.tsx`

Expected: FAIL because `FolderEmptyState.tsx` does not exist.

- [ ] **Step 3: Implement the empty-state component and translations**

Add a CSS-only three-print decorative composition, translated heading and description, primary upload button, and secondary create-folder button. Add English and Chinese keys for the heading, description, upload action, and create action.

- [ ] **Step 4: Integrate folder loading and actions**

Change `FoldersWorkspace` to accept `onUpload: () => void`, attach a ref to `#folder-name`, render `FolderListSkeleton` during initial loading, and render `FolderEmptyState` after a successful empty response. Implement the create action as `folderNameRef.current?.focus()`.

- [ ] **Step 5: Style responsive empty state**

Use an unboxed two-column composition on desktop and a centered single-column composition below 720px. Keep action heights at 44px and allow wrapping at 320px.

- [ ] **Step 6: Run targeted tests and verify GREEN**

Run: `cd web && npm test -- src/features/folders/FolderEmptyState.test.tsx src/features/loading/LoadingStates.test.tsx`

Expected: PASS with all targeted tests.

- [ ] **Step 7: Commit**

```bash
git add web/src/features/folders/FolderEmptyState.tsx web/src/features/folders/FolderEmptyState.test.tsx web/src/features/folders/FoldersWorkspace.tsx web/src/app/i18n.ts web/src/styles/global.css
git commit -m "feat: redesign empty folder state"
```

### Task 3: Replace Page-Level Spinner Branches

**Files:**
- Modify: `web/src/features/gallery/GalleryWorkspace.tsx`
- Modify: `web/src/features/sharing/PublicSharePage.tsx`
- Modify: `web/src/app/App.tsx`
- Modify: `web/src/app/i18nCoverage.test.ts`
- Create: `web/src/features/loading/loadingIntegration.test.ts`

- [ ] **Step 1: Write failing integration source tests**

Load the three source files through `import.meta.glob(..., { query: '?raw' })` and assert that they import/render the appropriate skeletons, that the initial branches no longer render `LoaderCircle`, and that the gallery pagination sentinel still does.

```ts
expect(gallerySource).toContain('{loading && <GallerySkeleton />}');
expect(folderSource).toContain('{loading && <FolderListSkeleton />}');
expect(publicSource).toContain('<PublicShareSkeleton');
expect(appSource).toContain('<AppShellSkeleton />');
expect(gallerySource).toContain('loadingMore && <LoaderCircle');
```

- [ ] **Step 2: Run the integration test and verify RED**

Run: `cd web && npm test -- src/features/loading/loadingIntegration.test.ts`

Expected: FAIL because the existing page-level branches still render text spinners.

- [ ] **Step 3: Integrate gallery and public skeletons**

Replace only the gallery's initial spinner with `GallerySkeleton`. Keep `loadingMore` unchanged. Replace the public page's initial lookup and photo-list loading branches with `PublicShareSkeleton`, while preserving unavailable and successful-empty states.

- [ ] **Step 4: Integrate shell skeleton and folder upload flow**

Replace `LoadingScreen` with `AppShellSkeleton`. Pass `chooseUpload` through `Workspace` to `FoldersWorkspace` so its upload action uses the existing hidden picker and upload selection flow.

- [ ] **Step 5: Expand translation coverage**

Include `LoadingStates.tsx` and `FolderEmptyState.tsx` in the raw-source translation coverage set. Ensure no new visible English or Chinese literals exist in production TSX.

- [ ] **Step 6: Run targeted tests and verify GREEN**

Run: `cd web && npm test -- src/features/loading/loadingIntegration.test.ts src/app/i18nCoverage.test.ts`

Expected: PASS with all targeted tests.

- [ ] **Step 7: Commit**

```bash
git add web/src/features/gallery/GalleryWorkspace.tsx web/src/features/sharing/PublicSharePage.tsx web/src/app/App.tsx web/src/app/i18nCoverage.test.ts web/src/features/loading/loadingIntegration.test.ts
git commit -m "feat: use skeletons for page loading"
```

### Task 4: Full Verification and Visual Audit

**Files:**
- Modify if required: `web/src/styles/global.css`

- [ ] **Step 1: Run the complete web test suite**

Run: `cd web && npm test`

Expected: all Vitest files pass with zero failures.

- [ ] **Step 2: Run typecheck and production build**

Run: `cd web && npm run typecheck && npm run build`

Expected: TypeScript exits 0 and Vite produces `web/dist` without errors.

- [ ] **Step 3: Audit residual loading copy**

Run: `rg -n "LoaderCircle|\.spin|loading\)|loading &&|loadingPhotos" web/src --glob '*.{ts,tsx}'`

Expected: only operation-level feedback and the populated-gallery pagination spinner remain; no page-replacement branch uses a text spinner.

- [ ] **Step 4: Check formatting and diff scope**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only intended implementation files plus pre-existing user-owned untracked files appear.

- [ ] **Step 5: Perform browser checks**

Start the Vite development server, exercise gallery, folders, initial app restore, and public shares at desktop and mobile widths, emulate reduced motion, and verify the upload and focus actions from the empty folder state.

- [ ] **Step 6: Commit any audit fixes**

```bash
git add web/src/styles/global.css
git commit -m "style: polish responsive loading states"
```
