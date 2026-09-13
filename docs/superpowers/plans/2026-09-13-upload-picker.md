# Upload Picker Entry Point Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the authenticated header Upload action open the native file picker and carry the selected files into the upload queue.

**Architecture:** Keep a hidden multi-file input mounted in `AppShell` so the header click can call `input.click()` synchronously. Store each picker selection with an ID, pass it to `UploadWorkspace`, append it once as queued items, and acknowledge it so remounts do not duplicate files. Keep the existing workspace input and Start upload flow unchanged.

**Tech Stack:** React 18, TypeScript, Vitest, Vite, Go static asset embedding.

---

### Task 1: Specify picker and queue helper behavior with failing tests

**Files:**
- Create: `web/src/app/uploadPicker.ts`
- Create: `web/src/app/uploadPicker.test.ts`
- Create: `web/src/features/upload/uploadSelection.ts`
- Create: `web/src/features/upload/uploadSelection.test.ts`

- [x] **Step 1: Write the failing tests**

  Test that the header action navigates before synchronously clicking the picker, and that selected files become queued items with zero progress.

- [x] **Step 2: Run the focused tests and verify they fail because the helpers do not exist**

  Run `npm test -- --run src/app/uploadPicker.test.ts src/features/upload/uploadSelection.test.ts` from `web/`. Expected: Vitest reports module/function failures for the new helpers.

### Task 2: Implement helper behavior and wire the header action

**Files:**
- Modify: `web/src/app/App.tsx`
- Modify: `web/src/features/upload/UploadWorkspace.tsx`
- Modify: `web/src/app/uploadPicker.ts`
- Modify: `web/src/features/upload/uploadSelection.ts`

- [x] **Step 1: Implement the smallest helpers that make Task 1 green**

  `openUploadPicker(navigate, input)` invokes `navigate()` and then `input?.click()`. `queuedItemsFromFiles(files)` maps each file to `{ file, status: 'queued', progress: 0 }`.

- [x] **Step 2: Wire AppShell to the helpers**

  Add a ref-backed hidden file input with the same image/video accept list as the upload workspace. The header handler calls `onViewChange('upload')` and `openUploadPicker`; the input change handler stores `{ id, files }` and resets the input value so the same file can be selected again. Pass the selection and a stable acknowledgement callback through `Workspace` to `UploadWorkspace`.

- [x] **Step 3: Consume picker selections once in UploadWorkspace**

  Add an optional selection prop and acknowledgement callback. On a new selection ID, append `queuedItemsFromFiles(selection.files)` and acknowledge that ID. Use the helper for the existing drop-zone input as well.

### Task 3: Verify, build, and deploy

**Files:**
- Update generated assets under `internal/webassets/static/` from `web/dist/`.

- [x] **Step 1: Run focused and complete frontend checks**

  Run `npm test -- --run`, `npm run typecheck`, and `npm run build` from `web/`; all tests and checks must pass.

- [x] **Step 2: Build and restart the public test service**

  Copy `web/dist/.` into `internal/webassets/static/`, build `/tmp/77photo-test-v4`, stop the process in `/tmp/77photo-test.pid`, and start the new binary on `:28888` with the existing `/tmp/77photo-test-data` paths.

- [x] **Step 3: Verify the deployed shell and API**

  Confirm `GET http://158.178.243.20:28888/healthz` returns 200 and the served index references the new bundle. Confirm the existing CSRF restore/upload smoke test still returns 201, then remove its temporary photo.

### Task 4: Commit the implementation

- [x] **Step 1: Review the diff and commit**

  Run `git diff --check`, inspect the changed files, then commit with `fix: open native picker from upload action`.
