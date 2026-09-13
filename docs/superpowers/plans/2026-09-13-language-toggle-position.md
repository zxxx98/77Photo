# Language Toggle Position Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the language switch from the authenticated sidebar account area to the top-right and present it as an unboxed text control across the login, authenticated, and public-share surfaces.

**Architecture:** Keep `LanguageToggle` as the single stateful/accessibility-aware component. Change only its authenticated shell placement in `AppShell`, group the topbar actions for reliable right alignment, and update the shared CSS so the existing login and public-share placements inherit the same text-only treatment. Add a source-structure regression test because this repository's current frontend tests use static rendering and source assertions rather than a DOM test runner.

**Tech Stack:** React 18, TypeScript, Vite, Vitest, shared CSS in `web/src/styles/global.css`.

---

### Task 1: Add placement regression coverage

**Files:**
- Modify: `web/src/app/i18nCoverage.test.ts`

- [ ] **Step 1: Write the failing test**

Add a source-structure test after the existing translation coverage tests. It should locate the `.topbar` and `.account-area` regions in `App.tsx`, require `LanguageToggle` inside the topbar, and forbid it inside the account area. Also verify that the login and public-share page sources continue to render the shared component:

```ts
  it('places the authenticated language toggle in the topbar', () => {
    const topbarStart = appSource.indexOf('<header className="topbar">');
    const topbarEnd = appSource.indexOf('</header>', topbarStart);
    const accountStart = appSource.indexOf('<div className="account-area">');
    const signOutStart = appSource.indexOf('<button className="icon-button" aria-label={t(\'common.signOut\')}', accountStart);

    expect(topbarStart).toBeGreaterThanOrEqual(0);
    expect(topbarEnd).toBeGreaterThan(topbarStart);
    expect(appSource.slice(topbarStart, topbarEnd)).toContain('<LanguageToggle />');
    expect(appSource.slice(accountStart, signOutStart)).not.toContain('<LanguageToggle />');

    const pageSources = import.meta.glob([
      '../features/auth/LoginPage.tsx',
      '../features/sharing/PublicSharePage.tsx',
    ], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

    for (const source of Object.values(pageSources)) expect(source).toContain('<LanguageToggle />');
  });
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run from `web/`:

```bash
npx vitest run src/app/i18nCoverage.test.ts
```

Expected: the new test fails because the current `AppShell` renders `LanguageToggle` in `.account-area` and not inside `.topbar`.

- [ ] **Step 3: Commit the failing regression test**

```bash
git add web/src/app/i18nCoverage.test.ts
git commit -m "test: cover language toggle placement"
```

### Task 2: Move the authenticated control into the topbar

**Files:**
- Modify: `web/src/app/App.tsx:88-108`

- [ ] **Step 1: Remove the sidebar instance**

Delete the `<LanguageToggle />` line between the account copy and the sign-out button in `.account-area`. Leave the avatar, username/role copy, and logout behavior unchanged.

- [ ] **Step 2: Add a topbar actions group**

In the existing `<header className="topbar">`, keep the menu button and search field in place, then wrap the language toggle and upload button in one action group:

```tsx
        <header className="topbar">
          <button className="icon-button menu-button" aria-label={t('common.openNavigation')} onClick={() => setSidebarOpen(true)}><Menu size={20} /></button>
          <label className="search-field">
            <Search size={18} aria-hidden="true" />
            <span className="sr-only">{t('common.search')}</span>
            <input placeholder={t('common.search')} disabled aria-label={t('common.search')} />
          </label>
          <div className="topbar-actions">
            <LanguageToggle />
            <button className="button button-primary upload-button" onClick={chooseUpload}><Upload size={17} /> <span>{t('common.upload')}</span></button>
          </div>
          <input ref={pickerRef} className="sr-only" type="file" accept="image/jpeg,image/png,video/mp4,video/webm" multiple tabIndex={-1} aria-hidden="true" onChange={handlePickerChange} />
        </header>
```

Do not change `chooseUpload`, `handlePickerChange`, or the hidden file input behavior.

- [ ] **Step 3: Run the focused test and verify it passes**

```bash
npx vitest run src/app/i18nCoverage.test.ts
```

Expected: PASS, including the new topbar/account-area placement assertion and all existing translation coverage assertions.

- [ ] **Step 4: Commit the structural change**

```bash
git add web/src/app/App.tsx
git commit -m "feat: move language toggle to app topbar"
```

### Task 3: Replace the boxed styling with the approved text treatment

**Files:**
- Modify: `web/src/styles/global.css:36-38,93-97,335-339`

- [ ] **Step 1: Replace the shared language-toggle rules**

Replace the current bordered pill rules with an unboxed inline control and preserve the active-language class:

```css
.language-toggle { min-height: 44px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 0; border-radius: 0; padding: 0; color: var(--slate-soft); background: transparent; font-size: 11px; white-space: nowrap; transition: color .2s ease; }
.language-toggle:hover { color: var(--slate); background: transparent; }
.language-toggle span.is-active { color: var(--slate); font-weight: 700; }
```

Do not remove the global `button:focus-visible` rule; it supplies the keyboard-visible focus treatment for the text control.

- [ ] **Step 2: Align the topbar action group**

Add the group rule near `.topbar`, and remove the old auto margin from `.upload-button` because the group now owns right alignment:

```css
.topbar-actions { display: inline-flex; align-items: center; gap: 16px; margin-left: auto; }
```

The resulting topbar rules must keep the search field flexible, align the language text and upload action at the right edge, and avoid changing other `.button` variants.

- [ ] **Step 3: Tune the narrow layout**

Inside the existing `@media (max-width: 560px)` block, add the compact action spacing and leave the upload icon-only behavior intact:

```css
  .topbar-actions { gap: 10px; }
  .upload-button { width: 44px; padding: 0; }
  .upload-button span { display: none; }
```

The language labels remain visible at narrow widths; the search field may shrink because it already has `min-width: 0`.

- [ ] **Step 4: Run the focused tests and typecheck**

```bash
npx vitest run src/app/i18nCoverage.test.ts src/features/i18n/languageToggle.test.ts
npm run typecheck
```

Expected: all selected tests PASS and TypeScript exits successfully.

- [ ] **Step 5: Commit the visual change**

```bash
git add web/src/styles/global.css
git commit -m "style: make language toggle an unboxed text control"
```

### Task 4: Verify all affected surfaces and the production build

**Files:**
- No additional source files; verify `web/src/app/App.tsx`, `web/src/styles/global.css`, `web/src/features/auth/LoginPage.tsx`, and `web/src/features/sharing/PublicSharePage.tsx`.

- [ ] **Step 1: Run the complete frontend test suite**

```bash
npm test
```

Expected: all Vitest suites PASS.

- [ ] **Step 2: Run the production build**

```bash
npm run build
```

Expected: `tsc --noEmit` and the Vite production build both complete successfully.

- [ ] **Step 3: Perform the manual responsive acceptance check**

Use the existing app preview at desktop width and a narrow viewport to check:

1. Login page: language text is in the upper-right, without a border or background wrapper.
2. Authenticated gallery, folders, upload, and settings: language text is in the topbar, immediately before the upload action; the sidebar account area contains no language control.
3. Public share page: language text remains in the upper-right next to the brand row.
4. Chinese and English states: current language is bold, other language is muted, click changes locale without a page reload, and keyboard focus is visible.
5. Narrow viewport: `中文 / English` remains readable, the upload action stays reachable as an icon, and the topbar has no horizontal overflow.

- [ ] **Step 4: Check the final diff and commit verification if needed**

```bash
git diff --check HEAD~3..HEAD
git status --short
```

Expected: no whitespace errors; only the known unrelated `.design-previews/` directory may remain untracked. Do not add or modify that directory.
