# First-run Administrator Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically show a secure administrator-creation page when a new 77Photo installation has no users, then sign the new administrator in.

**Architecture:** Add a minimal unauthenticated setup-status read endpoint, extend the frontend API/session state machine with a one-time `setup` state, and render a setup form inside a shared authentication-page frame. The existing transaction-protected setup write endpoint remains authoritative and setup races fall back to normal login.

**Tech Stack:** Go 1.23, `database/sql`, `net/http`, React 18, TypeScript, Vitest/jsdom, Vite, CSS

---

## File Structure

- Modify `internal/auth/session.go`: expose whether the users table is empty.
- Modify `internal/auth/service_test.go`: verify state before and after first administrator creation.
- Modify `internal/auth/http.go`: serve `GET /api/v1/setup/status`.
- Modify `internal/auth/http_test.go`: verify public response, cache headers, and setup transition.
- Modify `internal/httpapi/server.go`: register the status route.
- Modify `docs/api/openapi.yaml`: document the status endpoint and response schema.
- Modify `web/src/app/api.ts`: add setup status and administrator initialization requests.
- Modify `web/src/app/api.test.ts`: verify request paths, methods, and payloads.
- Modify `web/src/app/auth.ts`: add `setup` state and setup/session transitions.
- Modify `web/src/app/auth.test.ts`: verify restore, setup success, failure, and race recovery.
- Create `web/src/features/auth/AuthPageFrame.tsx`: shared branded login/setup composition.
- Modify `web/src/features/auth/LoginPage.tsx`: render inside the shared frame.
- Create `web/src/features/auth/SetupPage.tsx`: first-run administrator form.
- Create `web/src/features/auth/SetupPage.test.tsx`: interactive validation and submission tests.
- Modify `web/src/app/App.tsx`: route the `setup` session state.
- Modify `web/src/app/App.loading.test.tsx`: verify first-run and existing-installation routing.
- Modify `web/src/app/i18n.ts`: add bilingual setup copy.
- Modify `web/src/app/i18nCoverage.test.ts`: cover the new authentication modules.
- Modify `web/src/styles/global.css`: add focused setup helper and error styles while reusing login layout.
- Update `internal/webassets/static`: publish the verified frontend bundle.

### Task 1: Setup Status API

**Files:**
- Modify: `internal/auth/session.go`
- Modify: `internal/auth/service_test.go`
- Modify: `internal/auth/http.go`
- Modify: `internal/auth/http_test.go`
- Modify: `internal/httpapi/server.go`
- Modify: `docs/api/openapi.yaml`

- [ ] **Step 1: Write failing service and HTTP tests**

Add a service test that creates a fresh database, expects `SetupRequired(ctx)` to return true, calls `SetupAdmin`, then expects false. Add an HTTP test that requests `GET /api/v1/setup/status`, expects status 200, `Cache-Control: no-store`, and `{"required":true}`; after setup, repeat and expect false. Also assert POST to the status route returns 405.

```go
required, err := service.SetupRequired(context.Background())
if err != nil || !required { t.Fatalf("SetupRequired() = %v, %v; want true, nil", required, err) }
_, _, err = service.SetupAdmin(context.Background(), "owner", "correct horse battery staple")
if err != nil { t.Fatal(err) }
required, err = service.SetupRequired(context.Background())
if err != nil || required { t.Fatalf("SetupRequired() = %v, %v; want false, nil", required, err) }
```

- [ ] **Step 2: Verify RED**

Run: `go test ./internal/auth ./internal/httpapi`

Expected: FAIL because `SetupRequired` and `/api/v1/setup/status` do not exist.

- [ ] **Step 3: Implement service and handler**

Add:

```go
func (s *Service) SetupRequired(ctx context.Context) (bool, error) {
    var count int
    if err := s.db.QueryRowContext(ctx, "SELECT count(*) FROM users").Scan(&count); err != nil {
        return false, fmt.Errorf("check admin setup: %w", err)
    }
    return count == 0, nil
}
```

Serve only GET at `/api/v1/setup/status`, call `SetupRequired`, and respond with `writeJSON(w, http.StatusOK, map[string]bool{"required": required})`. Reuse `writeAuthError` for an internal query error and existing `methodNotAllowed` for other methods. Register the exact route in the API mux.

- [ ] **Step 4: Document the endpoint**

Add OpenAPI operation `getSetupStatus`, no security requirement, 200 `SetupStatusResponse`, and 500 `ErrorResponse`. Define `SetupStatusResponse` as an object requiring one boolean `required` property.

- [ ] **Step 5: Verify GREEN**

Run: `go test ./internal/auth ./internal/httpapi`

Expected: all package tests pass.

- [ ] **Step 6: Commit**

```bash
git add internal/auth/session.go internal/auth/service_test.go internal/auth/http.go internal/auth/http_test.go internal/httpapi/server.go docs/api/openapi.yaml
git commit -m "feat: expose first-run setup status"
```

### Task 2: Frontend Setup State Machine

**Files:**
- Modify: `web/src/app/api.ts`
- Modify: `web/src/app/api.test.ts`
- Modify: `web/src/app/auth.ts`
- Modify: `web/src/app/auth.test.ts`

- [ ] **Step 1: Write failing client and store tests**

Require `setupStatus()` to issue `GET /api/v1/setup/status`; require `setupAdmin('owner', 'long password')` to POST the JSON credentials. Add store tests for these transitions:

```ts
await store.restore();
expect(store.snapshot.status).toBe('setup');

await store.setupAdmin('owner', 'correct horse battery staple');
expect(store.snapshot).toMatchObject({ status: 'authenticated', user: { username: 'owner' } });
expect(store.csrfToken).toBe('csrf');
```

For restore, mock `me` rejection and `setupStatus` as `{ required: true }`; for an existing installation use `{ required: false }`. For setup failure, mock `setupAdmin` rejection and ensure a subsequent restore selects `setup` or `unauthenticated` from the refreshed status.

- [ ] **Step 2: Verify RED**

Run: `cd web && npm test -- src/app/api.test.ts src/app/auth.test.ts`

Expected: FAIL because the setup methods and `setup` session status do not exist.

- [ ] **Step 3: Implement API client methods**

Extend `ApiClient` with:

```ts
setupStatus(): Promise<{ required: boolean }>;
setupAdmin(username: string, password: string): Promise<AuthResponse>;
```

Use the existing request helper, `GET /api/v1/setup/status`, and `POST /api/v1/setup/admin` with JSON `{ username, password }`.

- [ ] **Step 4: Implement session transitions**

Extend `SessionStatus` with `'setup'`. On failed `me()`, call `setupStatus()` and select `setup` when required, otherwise `unauthenticated`; if status detection fails, select `unauthenticated`. Implement `setupAdmin` with the same successful CSRF/user handling as `login`. On failure, call `restore()` before rethrowing so a `409` race moves to login and a transient failure returns to setup when it is still required.

- [ ] **Step 5: Verify GREEN**

Run: `cd web && npm test -- src/app/api.test.ts src/app/auth.test.ts`

Expected: all API and session tests pass.

- [ ] **Step 6: Commit**

```bash
git add web/src/app/api.ts web/src/app/api.test.ts web/src/app/auth.ts web/src/app/auth.test.ts
git commit -m "feat: add frontend setup state"
```

### Task 3: First-run Setup Page

**Files:**
- Create: `web/src/features/auth/AuthPageFrame.tsx`
- Modify: `web/src/features/auth/LoginPage.tsx`
- Create: `web/src/features/auth/SetupPage.tsx`
- Create: `web/src/features/auth/SetupPage.test.tsx`
- Modify: `web/src/app/App.tsx`
- Modify: `web/src/app/App.loading.test.tsx`
- Modify: `web/src/app/i18n.ts`
- Modify: `web/src/app/i18nCoverage.test.ts`
- Modify: `web/src/styles/global.css`

- [ ] **Step 1: Write failing setup-page tests**

In jsdom, render `SetupPage` with a real `SessionStore` backed by mocks. Verify visible username/password/confirm labels and 12-character guidance. Submit a short password and then a mismatched confirmation and assert `api.setupAdmin` is not called. Submit matching valid credentials and expect the mock to receive the trimmed username and password.

```ts
expect(screenText).toContain('创建管理员');
expect(container.querySelectorAll('input')).toHaveLength(3);
expect(container.textContent).toContain('至少 12 个字符');
expect(api.setupAdmin).not.toHaveBeenCalled();
expect(api.setupAdmin).toHaveBeenCalledWith('owner', 'correct horse battery staple');
```

Add App lifecycle tests that resolve `me` as unauthorized and setup status as required/complete, then assert `SetupPage` or `LoginPage` respectively.

- [ ] **Step 2: Verify RED**

Run: `cd web && npm test -- src/features/auth/SetupPage.test.tsx src/app/App.loading.test.tsx`

Expected: FAIL because `SetupPage` and the setup route do not exist.

- [ ] **Step 3: Extract the shared authentication frame**

Move the common atmosphere, brand, language toggle, right-panel heading, child content, and footer into `AuthPageFrame`. Preserve every existing login class and its responsive behavior. Refactor `LoginPage` to pass its current heading, form, and note through this frame without changing login behavior.

- [ ] **Step 4: Implement SetupPage**

Track username, password, confirmation, busy, and localized message. Validate trimmed username, password length, and equality before calling `store.setupAdmin`. Use `autoComplete="username"` and `autoComplete="new-password"`, focus username, disable submit while busy, clear credential state after success, and map API failures to safe localized copy.

- [ ] **Step 5: Route setup state and add translations**

In `App`, render `<SetupPage store={store} />` when `snapshot.status === 'setup'`, before the unauthenticated branch. Add concise English and Chinese strings for the page heading, field labels, password guidance, one-time note, validation messages, progress, and submit action. Include `SetupPage.tsx` and `AuthPageFrame.tsx` in translation coverage.

- [ ] **Step 6: Add focused styling**

Reuse `.login-form`, `.login-panel`, and `.login-heading`. Add only setup-specific helper/error spacing and a calm sage security marker; maintain the existing mobile breakpoints and 44px controls.

- [ ] **Step 7: Verify GREEN**

Run: `cd web && npm test -- src/features/auth/SetupPage.test.tsx src/app/App.loading.test.tsx src/app/i18nCoverage.test.ts && npm run typecheck`

Expected: all targeted tests and typecheck pass.

- [ ] **Step 8: Commit**

```bash
git add web/src/features/auth/AuthPageFrame.tsx web/src/features/auth/LoginPage.tsx web/src/features/auth/SetupPage.tsx web/src/features/auth/SetupPage.test.tsx web/src/app/App.tsx web/src/app/App.loading.test.tsx web/src/app/i18n.ts web/src/app/i18nCoverage.test.ts web/src/styles/global.css
git commit -m "feat: add first-run administrator page"
```

### Task 4: Release Verification and Integration

**Files:**
- Update: `internal/webassets/static/**`

- [ ] **Step 1: Run full verification**

Run: `go test ./... && go vet ./... && (cd web && npm test && npm run typecheck && npm run build)`

Expected: all Go and Web tests pass, vet is clean, TypeScript passes, and Vite produces the production bundle.

- [ ] **Step 2: Publish the embedded bundle**

Copy the verified contents of `web/dist/` into `internal/webassets/static/`, remove only superseded hashed assets, and confirm `index.html` references the newly generated JS and CSS.

- [ ] **Step 3: Verify a clean first run**

Start the built server with an isolated new data directory and `PHOTO_COOKIE_SECURE=false`. Verify `/api/v1/setup/status` returns true, the browser shows the setup page, creating a custom administrator returns an authenticated session, the status becomes false, and reloading enters the gallery.

- [ ] **Step 4: Verify an existing installation**

Start against an initialized database, verify setup status is false, and confirm an unauthenticated browser shows login rather than setup.

- [ ] **Step 5: Commit generated assets**

```bash
git add internal/webassets/static
git commit -m "build: publish first-run setup interface"
```

- [ ] **Step 6: Merge, verify, and push**

Fast-forward the reviewed feature branch into `main`, rerun `go test ./...` and `cd web && npm test && npm run build`, then push `main` to `origin` as explicitly requested.
