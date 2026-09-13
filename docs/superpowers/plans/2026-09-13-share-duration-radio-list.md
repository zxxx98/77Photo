# Share Duration Radio List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the share-link duration controls with a polished, accessible radio list whose options are not wrapped in buttons.

**Architecture:** Keep the existing `duration` state and API contract. Enrich the existing duration metadata with short explanatory copy, render the three options as sibling `label` elements containing native radios, and style the labels as a flat vertical list with dividers and a restrained selected state.

**Tech Stack:** React 18, TypeScript, Vitest, React DOM server rendering, plain CSS.

---

## File map

- Modify `web/src/features/sharing/shareDialog.ts` to add display details for each duration without changing its `ShareDuration` values.
- Modify `web/src/features/sharing/ShareDialog.tsx` to render the duration controls as radios with a shared name and accessible helper text.
- Modify `web/src/features/sharing/shareDialog.test.ts` to cover the duration metadata used by the UI.
- Create `web/src/features/sharing/shareDurationOptions.test.tsx` to regression-test the rendered control markup and ensure it contains radios, not checkboxes or button-wrapped duration options.
- Modify `web/src/styles/global.css` to replace the current three button-like duration cards with a one-column flat list, dividers, helper text, and selected-row styling.

## Task 1: Add explanatory duration metadata

**Files:**
- Modify: `web/src/features/sharing/shareDialog.test.ts:32-40`
- Modify: `web/src/features/sharing/shareDialog.ts:3-7`

- [ ] **Step 1: Write the failing test**

Replace the current checkbox-oriented duration assertion with this expectation:

```ts
it('provides explanatory copy for each share duration', () => {
  expect(shareDurations).toEqual([
    { value: '1_day', label: '1 day', detail: 'Short-term access' },
    { value: '7_days', label: '7 days', detail: 'Recommended' },
    { value: 'forever', label: 'Forever', detail: 'Does not expire' },
  ]);
  expect(selectShareDuration('forever', '1_day')).toBe('1_day');
});
```

- [ ] **Step 2: Run the focused test and verify it fails for the missing metadata**

Run:

```bash
cd /home/ubuntu/code/personal/77Photo/web && npm test -- src/features/sharing/shareDialog.test.ts
```

Expected: the duration metadata test fails because the current objects do not contain `detail`; the other existing share-dialog tests remain passing.

- [ ] **Step 3: Add the minimal metadata**

Update `shareDurations` to:

```ts
export const shareDurations: Array<{ value: ShareDuration; label: string; detail: string }> = [
  { value: '1_day', label: '1 day', detail: 'Short-term access' },
  { value: '7_days', label: '7 days', detail: 'Recommended' },
  { value: 'forever', label: 'Forever', detail: 'Does not expire' },
];
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run the same command. Expected: all tests in `shareDialog.test.ts` pass.

- [ ] **Step 5: Commit the metadata change**

```bash
git add web/src/features/sharing/shareDialog.ts web/src/features/sharing/shareDialog.test.ts
git commit -m "feat: add share duration descriptions"
```

## Task 2: Change the rendered controls to native radio inputs

**Files:**
- Create: `web/src/features/sharing/shareDurationOptions.test.tsx`
- Modify: `web/src/features/sharing/ShareDialog.tsx:47-54`

- [ ] **Step 1: Write the failing rendered-markup test**

Create `web/src/features/sharing/shareDurationOptions.test.tsx` with:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../../app/api';
import ShareDialog from './ShareDialog';

describe('share duration controls', () => {
  it('renders one mutually exclusive radio per duration without button wrappers', () => {
    const markup = renderToStaticMarkup(
      <ShareDialog
        api={{} as ApiClient}
        resource={{ type: 'photo', id: 'photo-1', name: 'Memory.jpg' }}
        onClose={() => {}}
      />,
    );
    const durationStart = markup.indexOf('share-duration-list');
    const passwordStart = markup.indexOf('share-password-field');
    const durationMarkup = markup.slice(durationStart, passwordStart);

    expect(markup.match(/type="radio"/g)).toHaveLength(3);
    expect(markup).not.toContain('type="checkbox"');
    expect(durationMarkup.match(/name="share-duration"/g)).toHaveLength(3);
    expect(durationMarkup).toContain('<label');
    expect(durationMarkup).not.toContain('<button');
  });
});
```

- [ ] **Step 2: Run the new test and verify it fails on the current checkbox markup**

Run:

```bash
cd /home/ubuntu/code/personal/77Photo/web && npm test -- src/features/sharing/shareDurationOptions.test.tsx
```

Expected: FAIL because the current duration section renders three checkboxes and has no radio inputs.

- [ ] **Step 3: Implement the minimal radio-list JSX**

Replace the duration section in `ShareDialog.tsx` with:

```tsx
<fieldset className="share-duration-fieldset" aria-describedby="share-duration-help">
  <legend>Link duration</legend>
  <p className="share-duration-help" id="share-duration-help">Choose when this link expires.</p>
  <div className="share-duration-list">
    {shareDurations.map((option) => <label className={`share-duration-option ${duration === option.value ? 'is-selected' : ''}`} key={option.value}>
      <input type="radio" name="share-duration" value={option.value} checked={duration === option.value} onChange={() => setDuration(selectShareDuration(duration, option.value))} />
      <span className="share-duration-copy"><span className="share-duration-label">{option.label}</span><span className="share-duration-detail">{option.detail}</span></span>
    </label>)}
  </div>
</fieldset>
```

- [ ] **Step 4: Run the new test and verify it passes**

Run the focused command again. Expected: the rendered-markup test passes with three radios, one shared radio group, and no button inside the duration section.

- [ ] **Step 5: Commit the semantic markup change**

```bash
git add web/src/features/sharing/ShareDialog.tsx web/src/features/sharing/shareDurationOptions.test.tsx
git commit -m "fix: use radios for share duration"
```

## Task 3: Apply the polished flat-list styling

**Files:**
- Modify: `web/src/styles/global.css:188-196`

- [ ] **Step 1: Replace the button-like duration CSS**

Replace the current `.share-duration-fieldset` through `.share-duration-option input` rules with:

```css
.share-duration-fieldset { margin: 0; border: 0; padding: 0; }
.share-duration-fieldset legend, .share-password-field, .share-url-field { display: block; margin-bottom: 10px; color: var(--slate-soft); font-size: 11px; font-weight: 600; }
.share-duration-help { margin: -3px 0 10px; color: var(--slate-soft); font-size: 11px; line-height: 1.5; }
.share-duration-list { display: grid; grid-template-columns: 1fr; }
.share-duration-option { min-height: 68px; display: grid; grid-template-columns: 18px minmax(0, 1fr); align-items: center; gap: 12px; border-bottom: 1px solid var(--border); padding: 12px 4px; color: var(--slate-soft); background: transparent; cursor: pointer; transition: color .2s ease, background-color .2s ease; }
.share-duration-option:first-child { border-top: 1px solid var(--border); }
.share-duration-option:hover, .share-duration-option.is-selected { color: var(--slate); background: rgba(212, 165, 165, .1); }
.share-duration-option input { width: 16px; height: 16px; margin: 0; accent-color: var(--slate); }
.share-duration-copy { display: grid; gap: 4px; min-width: 0; }
.share-duration-label { font-size: 13px; font-weight: 600; line-height: 1.2; }
.share-duration-detail { color: var(--slate-soft); font-size: 11px; font-weight: 400; line-height: 1.3; }
```

Leave `.share-submit, .share-copy-button` unchanged so only the duration choices lose their button treatment.

- [ ] **Step 2: Run the focused UI test and inspect the CSS contract**

Run:

```bash
cd /home/ubuntu/code/personal/77Photo/web && npm test -- src/features/sharing/shareDialog.test.ts src/features/sharing/shareDurationOptions.test.tsx
```

Expected: all focused share tests pass. Confirm the duration selector is one column, has no option border-radius or transform hover rule, and keeps the submit button full width.

- [ ] **Step 3: Commit the visual change**

```bash
git add web/src/styles/global.css
git commit -m "style: polish share duration radio list"
```

## Task 4: Full verification

**Files:** None.

- [ ] **Step 1: Run the complete frontend test suite**

```bash
cd /home/ubuntu/code/personal/77Photo/web && npm test
```

Expected: Vitest exits with code 0 and reports zero failed tests.

- [ ] **Step 2: Run TypeScript validation**

```bash
cd /home/ubuntu/code/personal/77Photo/web && npm run typecheck
```

Expected: `tsc --noEmit` exits with code 0 and reports no type errors.

- [ ] **Step 3: Run the production build**

```bash
cd /home/ubuntu/code/personal/77Photo/web && npm run build
```

Expected: TypeScript validation and Vite production bundling both exit with code 0.

- [ ] **Step 4: Review the final diff and working tree**

```bash
cd /home/ubuntu/code/personal/77Photo && git diff HEAD~3..HEAD --check && git status --short
```

Expected: `git diff --check` prints no whitespace errors, and `git status --short` is empty aside from any pre-existing user changes.
