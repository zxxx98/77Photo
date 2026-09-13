# 77Photo Bilingual UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add complete Chinese/English support to the React/PWA interface, with Chinese as the initial default and a persistent user-controlled language switch.

**Architecture:** Add a dependency-free, flat-key translation dictionary and a React context at the application root. A small language toggle is rendered in the login page, authenticated sidebar, and public-share frame; all UI copy—including accessibility labels and known error states—comes from the translator, while user data and API URLs remain unchanged.

**Tech Stack:** React 18, TypeScript, Vite, Vitest, `Intl.NumberFormat`, `Intl.DateTimeFormat`, existing CSS and lucide-react icons.

---

## File map

Create:

- `web/src/app/i18n.ts`: locale type, storage-safe state helpers, translation dictionaries, interpolation, count/date formatting.
- `web/src/app/i18n.test.ts`: tests for defaulting, persistence, translation interpolation, and locale formatting.
- `web/src/app/I18nProvider.tsx`: React context and provider used by every route.
- `web/src/features/i18n/LanguageToggle.tsx`: accessible language switch control.
- `web/src/features/i18n/languageToggle.ts`: pure label/next-locale helpers.
- `web/src/features/i18n/languageToggle.test.ts`: helper behavior tests.
- `web/src/app/i18nCoverage.test.ts`: source-level guard against leaving user-facing English literals behind.

Modify:

- `web/src/main.tsx`: wrap `App` with `I18nProvider`.
- `web/src/app/App.tsx`: translate shell copy and navigation, and place the toggle in the account area.
- `web/src/features/auth/LoginPage.tsx`: translate login content, errors, and add the toggle.
- `web/src/features/gallery/GalleryWorkspace.tsx`: translate timeline, counts, empty/loading/error states, and dates.
- `web/src/features/folders/FoldersWorkspace.tsx`: translate folder controls, counts, and states.
- `web/src/features/upload/UploadWorkspace.tsx`: translate upload controls, progress status, cancellation, and errors.
- `web/src/features/viewer/Viewer.tsx`: translate inspector controls, metadata labels, actions, and operation feedback.
- `web/src/features/sharing/shareDialog.ts`, `ShareDialog.tsx`: make resource/duration/status copy locale-aware and translate labels/errors.
- `web/src/features/sharing/PublicSharePage.tsx`: translate public-share states, password gate, labels, and add the toggle to the public frame.
- `web/src/features/settings/SettingsWorkspace.tsx`: translate account/admin controls, confirmation text, scan states, and errors.
- `web/src/styles/global.css`: style the toggle in desktop, mobile, login, and public-share layouts without reducing the existing 44px touch target.

Tests remain focused on pure helpers because the current Vitest setup has no DOM testing library or jsdom environment; the production build/typecheck will validate all JSX call sites.

## Task 1: Add the translation core

**Files:**
- Create: `web/src/app/i18n.ts`
- Create: `web/src/app/i18n.test.ts`

- [ ] **Step 1: Write failing tests for locale state and formatting**

Add tests with a small in-memory storage object. The required public behavior is:

```ts
it('defaults to simplified Chinese when storage is empty', () => {
  expect(readStoredLocale(memoryStorage())).toBe('zh');
});

it('rejects unsupported stored locales', () => {
  const storage = memoryStorage({ '77photo.locale': 'fr' });
  expect(readStoredLocale(storage)).toBe('zh');
});

it('persists English and interpolates dynamic text', () => {
  const storage = memoryStorage();
  expect(setStoredLocale(storage, 'en')).toBe('en');
  expect(readStoredLocale(storage)).toBe('en');
  expect(translate('en', 'gallery.loaded', { count: 3 })).toBe('3 loaded');
  expect(translate('zh', 'gallery.loaded', { count: 3 })).toBe('已加载 3 张');
});

it('formats dates and counts with the selected locale', () => {
  const date = '2026-09-13T12:34:00.000Z';
  expect(formatCount('zh', 1234)).toBe('1,234');
  expect(formatCount('en', 1234)).toBe('1,234');
  expect(formatDate('en', date)).toContain('2026');
  expect(formatDate('zh', date)).toContain('2026');
});
```

The storage fixture implements only `getItem` and `setItem`, so tests do not depend on a browser global.

- [ ] **Step 2: Run the focused tests and confirm the expected failure**

Run `cd web && npm test -- --run src/app/i18n.test.ts`.

Expected: FAIL because `web/src/app/i18n.ts` and its exported helpers do not exist yet. Fix test syntax errors if any appear, but do not add production behavior before the feature failure is observed.

- [ ] **Step 3: Implement the minimal locale and translation API**

Export the following stable API:

```ts
export type Locale = 'zh' | 'en';
export const DEFAULT_LOCALE: Locale = 'zh';
export const LOCALE_STORAGE_KEY = '77photo.locale';
export type TranslationKey = keyof typeof translations.en;
export type TranslationParams = Record<string, string | number>;
export interface LocaleStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; }
export function readStoredLocale(storage: LocaleStorage): Locale;
export function setStoredLocale(storage: LocaleStorage, locale: Locale): Locale;
export function translate(locale: Locale, key: TranslationKey, params?: TranslationParams): string;
export function formatCount(locale: Locale, value: number): string;
export function formatDate(locale: Locale, value: string | number | Date): string;
```

Implement `readStoredLocale` with a try/catch and strict `zh`/`en` validation, `setStoredLocale` with a try/catch, and `translate` with `{name}`-style replacement. Add dictionary keys for every UI category in the design: auth, shell, gallery, folders, upload, viewer, sharing, public share, settings, and common actions/errors. Keep the dictionaries structurally identical by deriving `TranslationKey` from the English dictionary and adding a compile-time `satisfies Record<TranslationKey, string>` check for Chinese.

Use `Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US')` and `Intl.DateTimeFormat` with year/month/day/hour/minute. Missing interpolation parameters should leave the placeholder unchanged and never throw.

- [ ] **Step 4: Run the focused tests and verify green**

Run `cd web && npm test -- --run src/app/i18n.test.ts`.

Expected: all locale-default, persistence, interpolation, count, and date tests pass.

- [ ] **Step 5: Commit the translation core**

```bash
git add web/src/app/i18n.ts web/src/app/i18n.test.ts
git commit -m "feat: add bilingual translation core"
```

## Task 2: Add the provider and accessible toggle

**Files:**
- Create: `web/src/app/I18nProvider.tsx`
- Create: `web/src/features/i18n/languageToggle.ts`
- Create: `web/src/features/i18n/languageToggle.test.ts`
- Create: `web/src/features/i18n/LanguageToggle.tsx`
- Modify: `web/src/main.tsx`
- Modify: `web/src/styles/global.css`

- [ ] **Step 1: Write failing tests for toggle semantics**

Test the pure helper contract:

```ts
it('offers the other language as the action', () => {
  expect(nextLocale('zh')).toBe('en');
  expect(nextLocale('en')).toBe('zh');
});

it('describes the language switch accessibly', () => {
  expect(languageToggleLabel('zh')).toBe('切换到 English');
  expect(languageToggleLabel('en')).toBe('Switch to 中文');
});
```

- [ ] **Step 2: Run the toggle tests and confirm the expected failure**

Run `cd web && npm test -- --run src/features/i18n/languageToggle.test.ts`.

Expected: FAIL because the helper module does not exist.

- [ ] **Step 3: Implement provider, helpers, and toggle**

`I18nProvider` must expose `{ locale, setLocale, t, formatCount, formatDate }` through `useI18n()`. It should initialize from `readStoredLocale(browserStorage())`, use `DEFAULT_LOCALE` if `window` or local storage is unavailable, and persist a changed locale with `setStoredLocale` without reloading.

The toggle should be a real button with `type="button"`, `aria-label={languageToggleLabel(locale)}`, `aria-pressed={locale === 'en'}`, and visible labels `中文` and `English`; clicking calls `setLocale(nextLocale(locale))`. Add CSS for `.language-toggle`, keeping at least 44px height/width and allowing it to wrap cleanly in narrow layouts.

Wrap the existing `StrictMode` tree in `main.tsx`:

```tsx
<I18nProvider>
  <App />
</I18nProvider>
```

- [ ] **Step 4: Run tests and typecheck**

Run `cd web && npm test -- --run src/app/i18n.test.ts src/features/i18n/languageToggle.test.ts && npm run typecheck`.

Expected: focused tests pass and TypeScript reports no errors.

- [ ] **Step 5: Commit the locale context and toggle**

```bash
git add web/src/app/I18nProvider.tsx web/src/features/i18n web/src/main.tsx web/src/styles/global.css
git commit -m "feat: add persistent language switch"
```

## Task 3: Translate authentication and authenticated shell

**Files:**
- Modify: `web/src/app/App.tsx`
- Modify: `web/src/features/auth/LoginPage.tsx`
- Create: `web/src/app/i18nCoverage.test.ts`

- [ ] **Step 1: Add a source-level regression test for shell/auth coverage**

Extend a new `web/src/app/i18nCoverage.test.ts` with an explicit list of source files and assert that UI-only phrases are no longer present as JSX text. Keep dynamic values such as `photo.filename` out of the check. For example:

```ts
it('does not leave the previous shell and login literals behind', () => {
  const sources = import.meta.glob('../app/App.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
  const source = Object.values(sources)[0] ?? '';
  expect(source).not.toContain('Private library');
  expect(source).not.toContain('Search your library');
  expect(source).not.toContain('Sign out');
});
```

- [ ] **Step 2: Run the coverage test and verify it fails**

Run `cd web && npm test -- --run src/app/i18nCoverage.test.ts`.

Expected: FAIL on the first still-hardcoded English phrase.

- [ ] **Step 3: Migrate App and LoginPage to `useI18n()`**

Replace all user-facing literals, `aria-label`, `title`, placeholders, loading text, and login catch messages with `t(...)` calls. Keep `77Photo`, usernames, and resource names unchanged. Render `LanguageToggle` in the login panel and authenticated account area. Use `t('auth.loginRateLimited')` versus `t('auth.invalidCredentials')` for the existing 429 distinction.

- [ ] **Step 4: Verify coverage, existing tests, and typecheck**

Run `cd web && npm test -- --run src/app/i18nCoverage.test.ts src/app/auth.test.ts src/app/routes.test.ts && npm run typecheck`.

Expected: no previous shell/login literals, existing tests pass, and no type errors.

- [ ] **Step 5: Commit shell and auth translation**

```bash
git add web/src/app/App.tsx web/src/features/auth/LoginPage.tsx web/src/app/i18nCoverage.test.ts
git commit -m "feat: translate shell and login UI"
```

## Task 4: Translate gallery, folders, uploads, viewer, and settings

**Files:**
- Modify: `web/src/features/gallery/GalleryWorkspace.tsx`
- Modify: `web/src/features/folders/FoldersWorkspace.tsx`
- Modify: `web/src/features/upload/UploadWorkspace.tsx`
- Modify: `web/src/features/viewer/Viewer.tsx`
- Modify: `web/src/features/settings/SettingsWorkspace.tsx`
- Modify: `web/src/app/i18nCoverage.test.ts`

- [ ] **Step 1: Expand the failing coverage test to these workspaces**

Add the eight old phrases that must disappear from source, including `Timeline`, `Folders`, `Upload`, `Destination`, `Settings`, `Retry`, `Delete failed`, and `Rescan files`. Assert each source file no longer contains the literal. Run the focused test and confirm it fails before edits.

- [ ] **Step 2: Translate gallery and folder UI**

Use `useI18n()` in `GalleryWorkspace` and `FoldersWorkspace`. Translate headings, filters, empty/loading/error states, retry, photo singular/plural, folder counts, breadcrumbs, create-folder controls, and all icon labels/titles. Format the captured date through `formatDate(locale, date)` and counts through `formatCount` plus separate singular/plural keys. Do not translate filenames/folder names returned by the API.

- [ ] **Step 3: Translate upload and viewer UI without exposing raw errors**

Use localized keys for destination/file selection, queue statuses (`waiting`, `uploading`, `uploaded`, `cancelled`, `failed`), retry and cancellation labels. Replace direct display of `error.message` with a stable localized fallback; preserve the existing distinction for cancellation. In `Viewer`, translate all inspector labels, navigation/action labels, confirmation text, operation success/error feedback, and the unknown-folder fallback. Keep byte values and user filenames intact; use the selected locale for the captured timestamp.

- [ ] **Step 4: Translate settings and confirmation flows**

Translate account roles, family accounts, active/disabled statuses, add-member fields/button, admin-only errors, enable/disable/delete actions, the confirmation question, library index, rescan states, and generic update/create/delete errors. Do not expose raw server error messages from catches.

- [ ] **Step 5: Run workspace coverage, tests, and typecheck**

Run `cd web && npm test -- --run src/app/i18nCoverage.test.ts src/features/upload/uploadSelection.test.ts && npm run typecheck`.

Expected: the literal coverage test and existing upload tests pass, with no TypeScript errors.

- [ ] **Step 6: Commit workspace translation**

```bash
git add web/src/features/gallery/GalleryWorkspace.tsx web/src/features/folders/FoldersWorkspace.tsx web/src/features/upload/UploadWorkspace.tsx web/src/features/viewer/Viewer.tsx web/src/features/settings/SettingsWorkspace.tsx web/src/app/i18nCoverage.test.ts
git commit -m "feat: translate photo library workspaces"
```

## Task 5: Translate sharing and public-share surfaces

**Files:**
- Modify: `web/src/features/sharing/shareDialog.ts`
- Modify: `web/src/features/sharing/ShareDialog.tsx`
- Modify: `web/src/features/sharing/PublicSharePage.tsx`
- Modify: `web/src/features/sharing/shareDialog.test.ts`
- Modify: `web/src/app/i18nCoverage.test.ts`

- [ ] **Step 1: Write failing tests for locale-aware sharing helpers**

Change helper tests to call locale-aware APIs, for example:

```ts
it('returns resource-specific copy in both locales', () => {
  expect(shareCopy('photo', 'IMG_2048.jpg', 'zh').title).toBe('分享照片');
  expect(shareCopy('photo', 'IMG_2048.jpg', 'en').title).toBe('Share photo');
  expect(successMessage('folder', 'forever', 'zh')).toContain('文件夹已永久分享');
  expect(successMessage('folder', 'forever', 'en')).toContain('Folder shared forever');
});
```

Run `cd web && npm test -- --run src/features/sharing/shareDialog.test.ts` and confirm it fails because the helper signatures/copy are English-only.

- [ ] **Step 2: Make sharing helpers locale-aware**

Add a `Locale` parameter to `shareCopy` and `successMessage` (or accept a translator function) and return localized title/create/success strings. Localize duration labels in the dictionary rather than storing one fixed English label in `shareDurations`; retain the exact `1_day`, `7_days`, and `forever` values used by the API.

- [ ] **Step 3: Translate ShareDialog**

Use `useI18n()` for the public-link explanation, duration legend/options, optional password, create/copy states, link field, close label, and known errors. Keep the generated URL and resource name unchanged. Use `aria-live`/existing roles unchanged where already present.

- [ ] **Step 4: Translate PublicSharePage and add its toggle**

Use `useI18n()` in the public frame and page. Translate unavailable, loading, password-required, incorrect-password, view-only, shared-resource, empty, and footer copy. Render `LanguageToggle` beside the public brand so a recipient can switch before or after unlocking; changing language must not clear `share`, `photos`, `password`, or `unlocked` state.

- [ ] **Step 5: Run sharing tests and typecheck**

Run `cd web && npm test -- --run src/features/sharing/shareDialog.test.ts src/app/api.test.ts src/app/routes.test.ts && npm run typecheck`.

Expected: all sharing/API/route tests pass and the app typechecks.

- [ ] **Step 6: Commit sharing translation**

```bash
git add web/src/features/sharing web/src/app/i18nCoverage.test.ts
git commit -m "feat: translate sharing interfaces"
```

## Task 6: Full verification and handoff

**Files:**
- Modify: any prior files needed for test/build fixes only.

- [ ] **Step 1: Run the complete Web test suite**

Run `cd web && npm test -- --run`.

Expected: every Vitest file passes with zero failures.

- [ ] **Step 2: Run typecheck and production build**

Run `cd web && npm run typecheck && npm run build`.

Expected: TypeScript succeeds and Vite produces `web/dist` without warnings that indicate missing translation keys or broken imports.

- [ ] **Step 3: Run Go verification and confirm no backend regression**

Run `go test ./... && go vet ./...` from the repository root.

Expected: all Go packages and vet checks pass; the language feature changes only the frontend source and does not alter API behavior.

- [ ] **Step 4: Audit remaining visible English literals**

Run:

```bash
rg -n --glob '*.tsx' --glob '*.ts' "(aria-label|placeholder|title)=|>[A-Za-z][^<{]*<|['\"][A-Z][^'\"]{2,}['\"]" web/src
```

Review every result. Accept only brand names, API/resource values, file extensions, MIME values, and test descriptions; replace every user-facing UI phrase with a translation key. Confirm every `t('...')` key exists in both dictionaries.

- [ ] **Step 5: Check the final diff and commit verification fixes**

Run `git status --short` and `git diff --check`. If the audit found required fixes, run the affected focused tests again, then commit them with:

```bash
git add web/src
git commit -m "fix: complete bilingual UI coverage"
```
