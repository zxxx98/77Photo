# 77Photo Quiet Frame Brand Mark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the text-only `77` badge with the approved Quiet Frame SVG mark everywhere the 77Photo brand appears.

**Architecture:** Add one small, code-native React component that owns the mark geometry and accessibility attributes. Existing pages continue to own their wordmark and localized tagline; they import the component for the decorative mark. The existing `brand-mark` class remains the sizing contract, while its text-specific styles are replaced with SVG sizing.

**Tech Stack:** React 18, TypeScript, Vitest, CSS, Vite, Go `embed.FS` static assets.

---

### Task 1: Add a failing render test for the Quiet Frame mark

**Files:**
- Create: `web/src/features/branding/BrandMark.test.tsx`
- Create: `web/src/features/branding/BrandMark.tsx`

- [ ] **Step 1: Write the failing test**

Create `web/src/features/branding/BrandMark.test.tsx` with a server-render assertion for the component contract:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import BrandMark from './BrandMark';

describe('BrandMark', () => {
  it('renders the Quiet Frame SVG without the old text fallback', () => {
    const markup = renderToStaticMarkup(<BrandMark />);

    expect(markup).toContain('<svg');
    expect(markup).toContain('viewBox="0 0 72 72"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('fill="#3d4a5c"');
    expect(markup).toContain('stroke="#faf9f7"');
    expect(markup).toContain('fill="#a8c5b8"');
    expect(markup).not.toContain('>77<');
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run from `web/`:

```bash
npm test -- --run src/features/branding/BrandMark.test.tsx
```

Expected: Vitest fails because `./BrandMark` does not exist yet.

- [ ] **Step 3: Commit the test**

```bash
git add web/src/features/branding/BrandMark.test.tsx
git commit -m "test: specify quiet frame brand mark"
```

### Task 2: Implement the reusable SVG component

**Files:**
- Modify: `web/src/features/branding/BrandMark.tsx`

- [ ] **Step 1: Implement the minimal component**

Create `web/src/features/branding/BrandMark.tsx` with the approved preview geometry and no independent interaction:

```tsx
export default function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 72 72" aria-hidden="true" focusable="false">
      <rect width="72" height="72" rx="21" fill="#3d4a5c" />
      <path d="M18 28h18L24 53" fill="none" stroke="#faf9f7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="5" />
      <path d="M37 28h18L43 53" fill="none" stroke="#faf9f7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="5" />
      <circle cx="56" cy="55" r="3.5" fill="#a8c5b8" />
    </svg>
  );
}
```

- [ ] **Step 2: Run the focused test and verify it passes**

Run:

```bash
npm test -- --run src/features/branding/BrandMark.test.tsx
```

Expected: 1 test passes.

- [ ] **Step 3: Commit the component**

```bash
git add web/src/features/branding/BrandMark.tsx web/src/features/branding/BrandMark.test.tsx
git commit -m "feat: add quiet frame brand mark"
```

### Task 3: Replace all product-facing text badges and update sizing CSS

**Files:**
- Modify: `web/src/app/App.tsx`
- Modify: `web/src/features/auth/LoginPage.tsx`
- Modify: `web/src/features/sharing/PublicSharePage.tsx`
- Modify: `web/src/styles/global.css`

- [ ] **Step 1: Replace the authenticated shell and loading mark**

In `web/src/app/App.tsx`, import the component:

```tsx
import BrandMark from '../features/branding/BrandMark';
```

Replace both text badges with the component:

```tsx
<BrandMark />
```

The replacements are the badge inside `.brand-lockup` and the badge inside
`LoadingScreen`; keep the surrounding wordmark and localized tagline unchanged.

- [ ] **Step 2: Replace both login-page marks**

In `web/src/features/auth/LoginPage.tsx`, import:

```tsx
import BrandMark from '../branding/BrandMark';
```

Replace the badge in `.atmosphere-top` and the badge in `.mobile-brand` with
`<BrandMark />`, retaining `77Photo` and all existing language controls.

- [ ] **Step 3: Replace the public-share mark**

In `web/src/features/sharing/PublicSharePage.tsx`, import:

```tsx
import BrandMark from '../branding/BrandMark';
```

Replace the text badge in `.public-share-brand` with `<BrandMark />` and leave
the visible `77Photo` wordmark and language toggle as they are.

- [ ] **Step 4: Make the existing class size the inline SVG correctly**

In `web/src/styles/global.css`, replace the current text-badge rule:

```css
.brand-mark { display: block; width: 34px; height: 34px; flex: 0 0 34px; }
```

Do not add a shadow, hover animation, or new layout container. The existing
flex layouts and responsive rules should size and align the mark consistently.

- [ ] **Step 5: Verify no old product-facing text badge remains**

Run:

```bash
rg -n '<span className="brand-mark"|brand-mark[^-]' web/src
```

Expected: only the new SVG component and its CSS sizing rule match; no JSX
contains a literal `77` inside a `brand-mark` element.

- [ ] **Step 6: Commit the integration**

```bash
git add web/src/app/App.tsx web/src/features/auth/LoginPage.tsx web/src/features/sharing/PublicSharePage.tsx web/src/styles/global.css
git commit -m "feat: use quiet frame brand mark across app"
```

### Task 4: Build, refresh embedded assets, and verify

**Files:**
- Update generated files under `internal/webassets/static/` from `web/dist/`.

- [ ] **Step 1: Run the complete frontend checks**

Run from `web/`:

```bash
npm test -- --run
npm run typecheck
npm run build
```

Expected: all Vitest files pass, TypeScript exits 0, and Vite writes `web/dist`.

- [ ] **Step 2: Refresh the Go embedded shell**

Copy the newly generated `web/dist/index.html` and its hashed JS/CSS assets into
`internal/webassets/static/`, remove only the superseded hashed JS/CSS files,
then stage the generated files:

```bash
git add internal/webassets/static/index.html internal/webassets/static/assets
```

The embedded `index.html` must reference the same JS/CSS hashes produced by the
successful `npm run build`.

- [ ] **Step 3: Run backend and repository verification**

Run from the repository root:

```bash
go test ./...
go vet ./...
git diff --check
```

Expected: Go tests and vet exit 0 and `git diff --check` reports no output.

- [ ] **Step 4: Commit the generated assets**

```bash
git add internal/webassets/static
git commit -m "build: publish quiet frame brand mark"
```

- [ ] **Step 5: Confirm the final working tree**

```bash
git status --short --branch
```

Expected: the implementation worktree has no modified or untracked production
files, apart from the intentionally retained local design previews if they are
not being committed.
