# React Native Android Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an Android 12+ React Native client for 77Photo with device-token login, mobile gallery browsing, persistent concurrent uploads that continue in the background, notification progress, and mobile settings.

**Architecture:** Extend the Go server with opaque rotating mobile credentials and make the existing ACL handlers accept either Cookie+CSRF or Bearer authentication. Build a React Native 0.87 application for UI and ordinary reads, while Kotlin owns Room-backed upload jobs, Keystore credentials, Photo Picker access, the data-sync foreground service, WorkManager recovery, and notifications.

**Tech Stack:** Go 1.23, SQLite, OpenAPI 3.1, React Native 0.87.1, React 19, TypeScript, React Navigation 7, TanStack Query 5, Zustand 5, FlashList 2, Kotlin, Room, WorkManager, OkHttp, Android Keystore, Jest, React Native Testing Library, JUnit/Robolectric, Maestro.

---

## Plan map and dependency order

Design source: [`../specs/2026-09-15-react-native-android-app-design.md`](../specs/2026-09-15-react-native-android-app-design.md). When this plan and the design disagree, stop and update both documents before implementation.

| Stage | Tasks | Working result |
|---|---|---|
| A. Server foundation | 1–5 | Mobile login/refresh/revoke works and all existing APIs accept Bearer without weakening Web CSRF |
| B. Mobile read path | 6–10 | Android app connects, logs in, browses folders/gallery, and opens media |
| C. Native upload path | 11–14 | Photo Picker jobs survive background/process loss, respect 1–4 concurrency, and report notifications |
| D. Settings and release | 15–17 | LAN policy, scan UI, accessibility, E2E, CI, and signed release path are complete |

Do not start Task 11 before Tasks 1–10 pass. The native uploader uses the server's Bearer contract and the mobile app's persisted server IDs; implementing it earlier would create duplicate temporary interfaces.

## File and responsibility map

### Server files

| Path | Responsibility |
|---|---|
| `migrations/004_mobile_devices.sql` | Device, access-token, and refresh-token persistence |
| `internal/auth/mobile.go` | Token creation, lookup, rotation, reuse detection, device revocation |
| `internal/auth/mobile_test.go` | Mobile credential service tests |
| `internal/auth/mobile_http.go` | `/api/v1/mobile/*` HTTP contract |
| `internal/auth/mobile_http_test.go` | Mobile HTTP tests |
| `internal/auth/request.go` | Cookie/Bearer request authentication and write authorization |
| `internal/auth/request_test.go` | Bearer parsing and CSRF separation tests |
| `internal/users/service.go` | Revoke mobile devices on disable/delete/password change |
| `internal/httpapi/server.go` | Mount mobile routes |
| `docs/api/openapi.yaml` | Public mobile contract and Bearer security scheme |

### React Native files

| Path | Responsibility |
|---|---|
| `mobile/src/app/` | Providers, boot state, native stack and bottom tabs |
| `mobile/src/services/api/` | Typed API client, `ApiError`, single-flight refresh |
| `mobile/src/services/connection/` | URL normalization, CIDR policy, redirect checks |
| `mobile/src/services/credentials/` | TypeScript contract for Keystore-backed credentials |
| `mobile/src/features/auth/` | Server/login screens |
| `mobile/src/features/gallery/` | Cursor queries, date sections and authenticated images |
| `mobile/src/features/folders/` | Folder browser and reusable folder picker |
| `mobile/src/features/viewer/` | Image/video viewer, details and download/share actions |
| `mobile/src/features/upload/` | Queue screen and TypeScript native-upload adapter |
| `mobile/src/features/settings/` | Server, CIDR, concurrency, cache, language and rescan UI |
| `mobile/src/native/NativeCredentials.ts` | TurboModule spec for secure credentials |
| `mobile/src/native/NativePhotoPicker.ts` | TurboModule spec for persisted media selection |
| `mobile/src/native/NativeUploadQueue.ts` | TurboModule spec for queue commands and snapshots |

### Android files

| Path | Responsibility |
|---|---|
| `mobile/android/app/src/main/java/com/photo77/credentials/` | Keystore encryption and credentials TurboModule |
| `mobile/android/app/src/main/java/com/photo77/picker/` | Android Photo Picker and persistable grants |
| `mobile/android/app/src/main/java/com/photo77/upload/db/` | Room entities, DAO and migrations |
| `mobile/android/app/src/main/java/com/photo77/upload/` | Scheduler, foreground service, Worker and OkHttp body |
| `mobile/android/app/src/main/java/com/photo77/notifications/` | Notification channel, builder and action receiver |
| `mobile/android/app/src/main/java/com/photo77/bridge/` | Upload queue TurboModule |
| `mobile/android/app/src/main/AndroidManifest.xml` | Network, foreground service and notification declarations |
| `mobile/android/app/src/main/res/xml/network_security_config.xml` | Cleartext enabled at platform layer; runtime CIDR gate remains authoritative |

## Stage A — Server mobile authentication

### Task 1: Add the mobile-device schema

**Files:**
- Create: `migrations/004_mobile_devices.sql`
- Modify: `internal/database/database_test.go`

- [ ] **Step 1: Write the failing migration assertions**

Extend `TestOpenInitializesSchemaAndSQLitePragmas`:

```go
for _, table := range []string{
    "users", "folders", "photos", "shares", "sessions",
    "share_links", "share_link_access", "mobile_devices", "mobile_tokens",
    "schema_migrations",
} {
    var count int
    if err := db.QueryRowContext(ctx,
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?", table,
    ).Scan(&count); err != nil {
        t.Fatal(err)
    }
    if count != 1 {
        t.Fatalf("table %s count = %d, want 1", table, count)
    }
}

var migrationCount int
if err := db.QueryRowContext(ctx, "SELECT count(*) FROM schema_migrations").Scan(&migrationCount); err != nil {
    t.Fatal(err)
}
if migrationCount != 4 {
    t.Fatalf("schema migration count = %d, want 4", migrationCount)
}
```

- [ ] **Step 2: Verify the schema test fails**

Run: `go test ./internal/database -run TestOpenInitializesSchemaAndSQLitePragmas -count=1`

Expected: FAIL because `mobile_devices` and `mobile_tokens` do not exist and the migration count is 3.

- [ ] **Step 3: Add the migration**

Create `migrations/004_mobile_devices.sql`:

```sql
CREATE TABLE mobile_devices (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE CASCADE,
    name TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
    app_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    revoked_at TEXT
);

CREATE TABLE mobile_tokens (
    id TEXT PRIMARY KEY NOT NULL,
    device_id TEXT NOT NULL REFERENCES mobile_devices(id) ON UPDATE RESTRICT ON DELETE CASCADE,
    family_id TEXT NOT NULL,
    token_type TEXT NOT NULL CHECK (token_type IN ('access', 'refresh')),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    rotated_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX mobile_devices_user_idx ON mobile_devices(user_id, revoked_at);
CREATE INDEX mobile_tokens_device_idx ON mobile_tokens(device_id, token_type, revoked_at);
CREATE INDEX mobile_tokens_family_idx ON mobile_tokens(family_id, revoked_at);
CREATE INDEX mobile_tokens_expiry_idx ON mobile_tokens(expires_at);
```

- [ ] **Step 4: Verify migration behavior**

Run: `go test ./internal/database -count=1`

Expected: PASS, including initialization, restart idempotency, rollback, and foreign-key tests.

- [ ] **Step 5: Commit**

```bash
git add migrations/004_mobile_devices.sql internal/database/database_test.go
git commit -m "feat: add mobile device session schema"
```

### Task 2: Implement opaque mobile token lifecycle

**Files:**
- Create: `internal/auth/mobile.go`
- Create: `internal/auth/mobile_test.go`

- [ ] **Step 1: Write service tests for issue, refresh, reuse and revoke**

Create table-driven tests with these public expectations:

```go
func TestMobileTokensRotateAndRejectReuse(t *testing.T) {
    service, account := newMobileAuthService(t)
    first, err := service.CreateMobileSession(context.Background(), account.ID, MobileDeviceInput{
        Name: "Pixel 9", Platform: "android", AppVersion: "1.0.0",
    })
    if err != nil { t.Fatal(err) }

    current, err := service.CurrentBearer(context.Background(), first.AccessToken)
    if err != nil || current.Account.ID != account.ID {
        t.Fatalf("CurrentBearer() = %+v, %v", current, err)
    }

    rotated, err := service.RefreshMobileSession(context.Background(), first.RefreshToken)
    if err != nil { t.Fatal(err) }
    if rotated.RefreshToken == first.RefreshToken || rotated.AccessToken == first.AccessToken {
        t.Fatal("refresh did not rotate both credentials")
    }

    if _, err := service.RefreshMobileSession(context.Background(), first.RefreshToken); !errors.Is(err, ErrRefreshReuse) {
        t.Fatalf("reused refresh error = %v, want ErrRefreshReuse", err)
    }
    if _, err := service.CurrentBearer(context.Background(), rotated.AccessToken); !errors.Is(err, ErrUnauthorized) {
        t.Fatalf("family access after reuse = %v, want unauthorized", err)
    }
}
```

Also test 15-minute access expiry, 90-day refresh expiry, token hashes never equal raw tokens, listing only the current user's devices, and revoking one device without revoking another.

- [ ] **Step 2: Verify tests fail**

Run: `go test ./internal/auth -run 'TestMobile' -count=1`

Expected: FAIL with undefined `MobileDeviceInput`, `CreateMobileSession`, `CurrentBearer`, and `RefreshMobileSession`.

- [ ] **Step 3: Implement the service API**

Use these exact exported types and durations in `mobile.go`:

```go
const (
    mobileAccessTTL  = 15 * time.Minute
    mobileRefreshTTL = 90 * 24 * time.Hour
)

var ErrRefreshReuse = errors.New("refresh token reuse detected")

type MobileDeviceInput struct {
    Name, Platform, AppVersion string
}

type MobileDevice struct {
    ID, UserID, Name, Platform, AppVersion string
    CreatedAt, LastSeenAt time.Time
    RevokedAt *time.Time
}

type MobileSession struct {
    Device MobileDevice
    AccessToken, RefreshToken string
    AccessTokenExpiresAt, RefreshTokenExpiresAt time.Time
}

type BearerPrincipal struct {
    Account Account
    DeviceID string
    TokenID string
}
```

Implement token issuance inside one SQL transaction: generate device ID, family ID, access token and refresh token with existing `newID`, `randomToken`, `hashToken`, and `formatTime`; store only hashes. Rotation must mark the presented refresh row `rotated_at`, revoke previous active access rows in the family, and insert the new pair atomically. A lookup of a rotated refresh token must set `revoked_at` on the entire family and return `ErrRefreshReuse`.

- [ ] **Step 4: Verify service tests pass**

Run: `go test ./internal/auth -run 'TestMobile' -count=1`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/auth/mobile.go internal/auth/mobile_test.go
git commit -m "feat: add rotating mobile credentials"
```

### Task 3: Add mobile auth HTTP endpoints

**Files:**
- Create: `internal/auth/mobile_http.go`
- Create: `internal/auth/mobile_http_test.go`
- Modify: `internal/httpapi/server.go`
- Modify: `internal/httpapi/services_test.go`

- [ ] **Step 1: Write endpoint tests**

Cover login, refresh rotation, logout, device list/delete, method rejection, unknown JSON fields, uniform invalid credentials, and no `Set-Cookie`/CSRF headers. The main happy-path assertion is:

```go
login := doJSON(t, client, server.URL+"/api/v1/mobile/auth/login", http.MethodPost,
    `{"username":"admin","password":"correct horse battery staple","device_name":"Pixel 9","platform":"android","app_version":"1.0.0"}`, "")
if login.StatusCode != http.StatusOK { t.Fatalf("login = %d", login.StatusCode) }
if login.Header.Get("Set-Cookie") != "" || login.Header.Get(CSRFHeaderName()) != "" {
    t.Fatal("mobile login emitted browser session material")
}
var body MobileSessionResponse
decodeJSON(t, login, &body)
if body.AccessToken == "" || body.RefreshToken == "" || body.User.ID == "" {
    t.Fatalf("mobile response = %+v", body)
}
```

- [ ] **Step 2: Verify endpoint tests fail**

Run: `go test ./internal/auth ./internal/httpapi -run 'Mobile|MountsMobile' -count=1`

Expected: FAIL because the handler and routes do not exist.

- [ ] **Step 3: Implement handler and response contract**

First split the existing password check from browser-session creation:

```go
func (s *Service) AuthenticateAccount(ctx context.Context, username, password string) (Account, error)

func (s *Service) Authenticate(ctx context.Context, username, password string) (Account, Session, error) {
    account, err := s.AuthenticateAccount(ctx, username, password)
    if err != nil { return Account{}, Session{}, err }
    session, err := s.createSession(ctx, account.ID)
    return account, session, err
}
```

The browser login continues calling `Authenticate`. Mobile login calls `AuthenticateAccount` followed by `CreateMobileSession`; it must not create an unused row in `sessions`.

Create `NewMobileHTTPHandler(service *Service) http.Handler` with these routes:

```go
POST   /api/v1/mobile/auth/login
POST   /api/v1/mobile/auth/refresh
POST   /api/v1/mobile/auth/logout
GET    /api/v1/mobile/devices
DELETE /api/v1/mobile/devices/{id}
```

Use this JSON response shape:

```go
type MobileSessionResponse struct {
    AccessToken string `json:"access_token"`
    AccessTokenExpiresAt time.Time `json:"access_token_expires_at"`
    RefreshToken string `json:"refresh_token"`
    RefreshTokenExpiresAt time.Time `json:"refresh_token_expires_at"`
    Device MobileDevice `json:"device"`
    User Account `json:"user"`
}
```

Mount `/api/v1/mobile/` in `NewHandlerWithServices` before the fallback route. Reuse `decodeBody`, `writeAuthError`, and the existing login rate limiter. Require Bearer access authentication for logout/list/delete; deleting another user's device returns 404.

- [ ] **Step 4: Verify HTTP tests pass**

Run: `go test ./internal/auth ./internal/httpapi -run 'Mobile|MountsMobile' -count=1`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/auth/mobile_http.go internal/auth/mobile_http_test.go internal/httpapi/server.go internal/httpapi/services_test.go
git commit -m "feat: expose mobile authentication API"
```

### Task 4: Make existing APIs accept Bearer without weakening CSRF

**Files:**
- Create: `internal/auth/request.go`
- Create: `internal/auth/request_test.go`
- Modify: `internal/auth/http.go`
- Modify: `internal/folders/http.go`
- Modify: `internal/photos/http.go`
- Modify: `internal/photos/live.go`
- Modify: `internal/indexer/http.go`
- Modify: `internal/sharelinks/http.go`
- Modify: `internal/shares/http.go`
- Modify: `internal/users/http.go`
- Test: matching `*_test.go` files in each package

- [ ] **Step 1: Write authentication-mode tests**

```go
func TestAuthorizeWriteSeparatesCookieAndBearer(t *testing.T) {
    service, account := newMobileAuthService(t)
    mobile, _ := service.CreateMobileSession(context.Background(), account.ID,
        MobileDeviceInput{Name: "Pixel", Platform: "android", AppVersion: "1"})

    bearerReq := httptest.NewRequest(http.MethodPost, "/api/v1/photos/upload", nil)
    bearerReq.Header.Set("Authorization", "Bearer "+mobile.AccessToken)
    bearer, err := service.AuthenticateRequest(bearerReq.Context(), bearerReq)
    if err != nil || bearer.Method != AuthMethodBearer { t.Fatalf("bearer = %+v, %v", bearer, err) }
    if err := service.AuthorizeWrite(bearerReq, bearer); err != nil { t.Fatal(err) }

    cookieReq := httptest.NewRequest(http.MethodPost, "/api/v1/photos/upload", nil)
    cookie := createCookieAuth(t, service, account.ID)
    cookieReq.AddCookie(&http.Cookie{Name: SessionCookieName(), Value: cookie.Token})
    cookieAuth, _ := service.AuthenticateRequest(cookieReq.Context(), cookieReq)
    if err := service.AuthorizeWrite(cookieReq, cookieAuth); !errors.Is(err, ErrCSRF) {
        t.Fatalf("cookie without csrf = %v, want ErrCSRF", err)
    }
}
```

- [ ] **Step 2: Verify the new tests fail**

Run: `go test ./internal/auth -run TestAuthorizeWriteSeparatesCookieAndBearer -count=1`

Expected: FAIL because `RequestAuth`, `AuthMethodBearer`, and `AuthorizeWrite` do not exist.

- [ ] **Step 3: Add one request-authentication contract**

```go
type AuthMethod string
const (
    AuthMethodCookie AuthMethod = "cookie"
    AuthMethodBearer AuthMethod = "bearer"
)

type RequestAuth struct {
    Account Account
    Session Session
    Method AuthMethod
    Credential string
    DeviceID string
}

func (s *Service) AuthenticateRequest(ctx context.Context, r *http.Request) (RequestAuth, error)
func (s *Service) AuthorizeWrite(r *http.Request, authenticated RequestAuth) error
```

`AuthenticateRequest` checks a syntactically valid `Authorization: Bearer` first and never falls back to Cookie when a Bearer header is present but invalid. `AuthorizeWrite` returns nil for valid Bearer and calls `ValidateCSRF` for Cookie.

Replace every handler call shaped like:

```go
account, session, _, err := h.authService.AuthenticateRequest(r.Context(), r)
if err == nil {
    err = h.authService.ValidateCSRF(session, r.Header.Get(auth.CSRFHeaderName()))
}
```

with:

```go
authenticated, err := h.authService.AuthenticateRequest(r.Context(), r)
if err == nil {
    err = h.authService.AuthorizeWrite(r, authenticated)
}
account := authenticated.Account
```

Read routes use `authenticated.Account` and do not call `AuthorizeWrite`.

- [ ] **Step 4: Add representative package regressions**

For folders, photos upload, share-link creation and admin rescan, run each existing write test once with a Bearer header and no CSRF; assert success. Keep all existing Cookie-without-CSRF tests and assert 403.

- [ ] **Step 5: Run the complete Go suite**

Run: `go test ./...`

Expected: PASS with both Web Cookie and mobile Bearer paths.

- [ ] **Step 6: Commit**

```bash
git add internal/auth internal/folders internal/photos internal/indexer internal/sharelinks internal/shares internal/users
git commit -m "feat: authorize API requests with mobile bearer tokens"
```

### Task 5: Revoke mobile sessions on account lifecycle changes and document the API

**Files:**
- Modify: `internal/users/service.go`
- Modify: `internal/users/service_test.go`
- Modify: `docs/api/openapi.yaml`
- Modify: `docs/operations/security.md`

- [ ] **Step 1: Write user-lifecycle revocation tests**

Create three cases that issue a mobile session, then disable, delete, or change the password of that user. After each operation:

```go
_, err := authService.CurrentBearer(context.Background(), mobile.AccessToken)
if !errors.Is(err, auth.ErrUnauthorized) {
    t.Fatalf("mobile access after account change = %v", err)
}
```

- [ ] **Step 2: Verify lifecycle tests fail**

Run: `go test ./internal/users -run Mobile -count=1`

Expected: FAIL because existing user updates revoke browser sessions only.

- [ ] **Step 3: Revoke both session types in the same user transaction**

Add `RevokeMobileSessionsForUserTx(ctx, tx, userID)` to `auth.Service`. Call it beside browser-session revocation when `password`, `is_active=false`, or deletion is applied. Do not revoke sessions for username-only or role-only changes.

- [ ] **Step 4: Extend OpenAPI**

Add `bearerAuth` and the five mobile endpoints. For existing authenticated endpoints, use:

```yaml
security:
  - cookieAuth: []
  - bearerAuth: []
```

Keep the CSRF parameter documented only for Cookie-authenticated writes and state that Bearer clients must not send browser CSRF tokens. Add schemas for `MobileLoginRequest`, `MobileRefreshRequest`, `MobileSessionResponse`, and `MobileDevice` matching Task 3.

- [ ] **Step 5: Verify API and security docs**

Run: `go test ./... && npx --yes @redocly/cli@latest lint docs/api/openapi.yaml`

Expected: Go PASS and OpenAPI lint exits 0 without errors.

- [ ] **Step 6: Commit**

```bash
git add internal/auth internal/users docs/api/openapi.yaml docs/operations/security.md
git commit -m "feat: revoke and document mobile sessions"
```

## Stage B — React Native foundation and gallery

### Task 6: Scaffold and pin the Android app

**Files:**
- Create: `mobile/` generated React Native project
- Modify: `mobile/package.json`
- Modify: `mobile/android/build.gradle`
- Modify: `mobile/android/app/build.gradle`
- Modify: `.github/workflows/ci.yml`
- Modify: `.gitignore`

- [ ] **Step 1: Generate the pinned project**

Run:

```bash
npx @react-native-community/cli@20.2.0 init mobile --version 0.87.1 --skip-git-init --pm npm --package-name com.photo77
```

Expected: `mobile/package.json`, `mobile/android/`, `mobile/ios/`, and the template test are created. Keep `ios/` compilable but do not add iOS feature work.

- [ ] **Step 2: Install the application dependencies**

Run from `mobile/`:

```bash
npm install @react-navigation/native@7.3.18 @react-navigation/native-stack @react-navigation/bottom-tabs react-native-screens react-native-safe-area-context @tanstack/react-query@5.102.8 zustand@5.0.15 @shopify/flash-list@2.3.2 react-native-gesture-handler react-native-reanimated react-native-video@6.19.2 @react-native-async-storage/async-storage @react-native-community/netinfo i18next react-i18next
npm install --save-dev @testing-library/react-native @types/jest eslint prettier
```

Expected: `package-lock.json` pins the complete graph and `npm ls --depth=0` exits 0.

- [ ] **Step 3: Set platform and quality gates**

Set Android `minSdkVersion` to 31. Add scripts:

```json
{
  "scripts": {
    "test": "jest",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "android:assemble": "cd android && ./gradlew assembleDebug"
  }
}
```

Add a `mobile` CI job using Node 22, Java 17, `npm ci`, `npm test -- --runInBand`, `npm run typecheck`, and `npm run android:assemble`.

- [ ] **Step 4: Verify the untouched scaffold and CI commands**

Run: `cd mobile && npm test -- --runInBand && npm run typecheck && npm run android:assemble`

Expected: PASS and `android/app/build/outputs/apk/debug/app-debug.apk` exists.

- [ ] **Step 5: Commit**

```bash
git add mobile .github/workflows/ci.yml .gitignore
git commit -m "build: scaffold React Native Android client"
```

### Task 7: Implement server configuration and LAN HTTP policy

**Files:**
- Create: `mobile/src/services/connection/types.ts`
- Create: `mobile/src/services/connection/cidr.ts`
- Create: `mobile/src/services/connection/policy.ts`
- Create: `mobile/src/services/connection/store.ts`
- Create: `mobile/src/services/connection/policy.test.ts`

- [ ] **Step 1: Write URL and CIDR policy tests**

```ts
describe('connection policy', () => {
  it.each([
    ['http://192.168.1.8:8080', true],
    ['http://10.2.3.4', true],
    ['http://172.31.0.2', true],
    ['http://[fd00::8]:8080', true],
    ['http://8.8.8.8', false],
    ['http://photo.local', false],
    ['https://8.8.8.8', true],
  ])('%s allowed=%s', (raw, allowed) => {
    expect(evaluateServerURL(raw, DEFAULT_LAN_CIDRS).allowed).toBe(allowed);
  });

  it('rejects catch-all manual ranges', () => {
    expect(validateManualCIDR('0.0.0.0/0')).toEqual({ ok: false, reason: 'catch_all' });
    expect(validateManualCIDR('::/0')).toEqual({ ok: false, reason: 'catch_all' });
  });
});
```

- [ ] **Step 2: Verify tests fail**

Run: `cd mobile && npm test -- src/services/connection/policy.test.ts --runInBand`

Expected: FAIL because the connection modules do not exist.

- [ ] **Step 3: Implement the policy contract**

```ts
export const DEFAULT_LAN_CIDRS = [
  '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',
  '169.254.0.0/16', '::1/128', 'fc00::/7', 'fe80::/10',
] as const;

export type ConnectionDecision =
  | { allowed: true; normalizedURL: string; insecure: boolean }
  | { allowed: false; reason: 'invalid_url' | 'http_hostname' | 'http_outside_lan' | 'unsupported_scheme' };

export function evaluateServerURL(raw: string, cidrs: readonly string[]): ConnectionDecision;
export function validateManualCIDR(raw: string): { ok: true; normalized: string; globallyRoutable: boolean } | { ok: false; reason: string };
export function assertRedirectAllowed(from: URL, to: URL, cidrs: readonly string[]): void;
```

Parse IPv4 and IPv6 numerically; do not match CIDRs with string prefixes. Normalize host casing, preserve explicit ports, strip only trailing `/`, and reject URL username/password/query/hash.

- [ ] **Step 4: Add persistent configuration**

Store `ServerConfig { id, baseURL, displayName, allowInsecureConfirmedAt }`, selected server ID, built-in CIDR enabled flags, manual CIDRs, upload concurrency, and cellular-upload preference in AsyncStorage. Generate server IDs once; never use the mutable URL as an upload foreign key.

- [ ] **Step 5: Verify policy and persistence tests**

Run: `cd mobile && npm test -- src/services/connection --runInBand && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add mobile/src/services/connection
git commit -m "feat: add mobile server connection policy"
```

### Task 8: Add secure credentials, API client and refresh serialization

**Files:**
- Create: `mobile/src/native/NativeCredentials.ts`
- Create: `mobile/src/services/credentials/index.ts`
- Create: `mobile/src/services/api/types.ts`
- Create: `mobile/src/services/api/client.ts`
- Create: `mobile/src/services/api/client.test.ts`
- Create: `mobile/android/app/src/main/java/com/photo77/credentials/CredentialCipher.kt`
- Create: `mobile/android/app/src/main/java/com/photo77/credentials/NativeCredentialsModule.kt`
- Test: `mobile/android/app/src/test/java/com/photo77/credentials/CredentialCipherTest.kt`

- [ ] **Step 1: Write API single-flight tests**

```ts
it('performs one refresh for concurrent 401 responses', async () => {
  const transport = createScriptedTransport({ protected401Count: 2, refreshedToken: 'access-2' });
  const credentials = createMemoryCredentials({ accessToken: 'expired', refreshToken: 'refresh-1' });
  const client = createApiClient({ baseURL: 'https://server.test', transport, credentials });

  await Promise.all([client.listPhotos(), client.listFolders()]);

  expect(transport.calls('/api/v1/mobile/auth/refresh')).toHaveLength(1);
  expect(transport.authorizationHeaders()).toContain('Bearer access-2');
});
```

Also test one retry maximum, refresh failure clearing credentials, JSON error decoding, request ID retention, and no Authorization header on login/refresh.

- [ ] **Step 2: Verify TypeScript tests fail**

Run: `cd mobile && npm test -- src/services/api/client.test.ts --runInBand`

Expected: FAIL because the API client does not exist.

- [ ] **Step 3: Implement credentials and API contracts**

Define the TurboModule spec:

```ts
export type StoredCredentials = {
  serverId: string;
  deviceId: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
};

export interface Spec extends TurboModule {
  get(serverId: string): Promise<StoredCredentials | null>;
  set(value: StoredCredentials): Promise<void>;
  clear(serverId: string): Promise<void>;
}
```

`createApiClient` accepts injected `transport` and `credentials`, adds Bearer for protected routes, serializes refresh through one shared Promise, saves both rotated tokens before replaying callers, and retries each failed request once.

- [ ] **Step 4: Implement Keystore-backed storage**

Use Android Keystore AES/GCM with a non-exportable key alias `77photo.mobile.credentials.v1`. Store ciphertext, IV, and schema version in private SharedPreferences keyed by server ID. `clear` removes ciphertext; uninstall removes both app data and key. Never expose the encryption key to JS.

- [ ] **Step 5: Verify credentials and API tests**

Run:

```bash
cd mobile
npm test -- src/services/api src/services/credentials --runInBand
cd android && ./gradlew testDebugUnitTest
```

Expected: Jest PASS and Kotlin unit tests PASS.

- [ ] **Step 6: Commit**

```bash
git add mobile/src/native/NativeCredentials.ts mobile/src/services/credentials mobile/src/services/api mobile/android/app/src/main/java/com/photo77/credentials mobile/android/app/src/test/java/com/photo77/credentials
git commit -m "feat: add secure mobile API sessions"
```

### Task 9: Build app shell and login flow

**Files:**
- Create: `mobile/src/app/AppProviders.tsx`
- Create: `mobile/src/app/navigation.tsx`
- Create: `mobile/src/app/useBoot.ts`
- Create: `mobile/src/features/auth/LoginScreen.tsx`
- Create: `mobile/src/features/auth/ConnectionSettingsScreen.tsx`
- Create: `mobile/src/features/auth/LoginScreen.test.tsx`
- Create: `mobile/src/components/`
- Create: `mobile/src/i18n/`
- Modify: `mobile/App.tsx`

- [ ] **Step 1: Write login behavior tests**

Test HTTPS login, HTTP-LAN warning, blocked public HTTP, loading state, invalid credentials, unsupported server route, and credential persistence. A representative assertion:

```tsx
render(<LoginScreen services={servicesFor('http://192.168.1.9:8080')} />);
expect(screen.getByText(/内网未加密/)).toBeOnTheScreen();
fireEvent.press(screen.getByRole('button', { name: '安全登录' }));
await waitFor(() => expect(mockAuth.login).toHaveBeenCalled());
```

- [ ] **Step 2: Verify UI tests fail**

Run: `cd mobile && npm test -- src/features/auth/LoginScreen.test.tsx --runInBand`

Expected: FAIL because the app providers, navigator and login screen do not exist.

- [ ] **Step 3: Implement boot and navigation states**

Use this finite state instead of scattered booleans:

```ts
type BootState =
  | { status: 'loading' }
  | { status: 'needs-server' }
  | { status: 'needs-login'; server: ServerConfig }
  | { status: 'authenticated'; server: ServerConfig; user: User };
```

Create `RootStack` for login/connection/main/viewer and `MainTabs` with exactly Gallery, Upload and Settings. Use centralized warm-white/slate-blue tokens, 48dp touch targets, safe areas, system dark mode and Chinese/English strings.

- [ ] **Step 4: Implement connection check and login**

Normalize and validate the URL, call `/healthz`, then mobile login. A 404 from `/api/v1/mobile/auth/login` maps to `SERVER_MOBILE_API_UNSUPPORTED`; do not fall back to Cookie. Persist credentials only after the full JSON response validates.

- [ ] **Step 5: Verify login and shell**

Run: `cd mobile && npm test -- src/features/auth src/app --runInBand && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add mobile/App.tsx mobile/src/app mobile/src/features/auth mobile/src/components mobile/src/i18n
git commit -m "feat: add Android login and navigation shell"
```

### Task 10: Implement gallery, folders and media viewer

**Files:**
- Create: `mobile/src/features/gallery/queries.ts`
- Create: `mobile/src/features/gallery/GalleryScreen.tsx`
- Create: `mobile/src/features/gallery/GalleryScreen.test.tsx`
- Create: `mobile/src/features/gallery/AuthenticatedImage.tsx`
- Create: `mobile/src/features/folders/FolderBrowserScreen.tsx`
- Create: `mobile/src/features/folders/FolderPickerScreen.tsx`
- Create: `mobile/src/features/viewer/MediaViewerScreen.tsx`
- Create: `mobile/src/features/viewer/MediaDetailsSheet.tsx`
- Modify: `mobile/src/services/api/types.ts`
- Modify: `mobile/src/services/api/client.ts`

- [ ] **Step 1: Write query and screen tests**

Cover stable cursor append, date grouping in local time, cursor-expired refresh, cached first render, empty/error/loading states, folder back navigation, write-disabled folders, and authenticated thumbnail headers.

```ts
expect(groupPhotosByLocalDay([
  photo('a', '2026-09-15T00:30:00Z'),
  photo('b', '2026-09-14T23:30:00Z'),
], 'Asia/Shanghai')).toEqual([
  { key: '2026-09-15', ids: ['a', 'b'] },
]);
```

- [ ] **Step 2: Verify focused tests fail**

Run: `cd mobile && npm test -- src/features/gallery src/features/folders src/features/viewer --runInBand`

Expected: FAIL because the feature modules do not exist.

- [ ] **Step 3: Implement typed reads and query keys**

Use server-scoped keys:

```ts
export const photoKeys = {
  all: (serverId: string, userId: string) => ['photos', serverId, userId] as const,
  list: (serverId: string, userId: string, folderId?: string) =>
    [...photoKeys.all(serverId, userId), 'list', folderId ?? 'timeline'] as const,
};
```

Implement `listPhotos`, `listFolders`, `getFolder`, `getPhoto`, preview/original URLs, `createShareLink`, and delete. On logout/server change, remove queries for the old server/user and clear the authenticated-image context.

- [ ] **Step 4: Implement mobile browsing**

Use FlashList with three square columns, local-day section headers, 256/512 thumbnails, pull-to-refresh and next-cursor loading. Folder browser reuses the API types; `FolderPickerScreen` returns only writable folder IDs. Viewer uses 1280 preview, horizontal paging, double-tap/pinch, Android back, details sheet, download/share and confirmed permanent delete. Use `react-native-video` for MP4/WebM playback and forward the same Bearer header used by image requests; unsupported codecs show a download action instead of a blank player.

- [ ] **Step 5: Verify features and Android build**

Run: `cd mobile && npm test -- src/features/gallery src/features/folders src/features/viewer --runInBand && npm run typecheck && npm run android:assemble`

Expected: PASS and debug APK builds.

- [ ] **Step 6: Commit**

```bash
git add mobile/src/features/gallery mobile/src/features/folders mobile/src/features/viewer mobile/src/services/api
git commit -m "feat: add mobile gallery and media viewer"
```

## Stage C — Native background uploads

### Task 11: Add Room upload queue and TurboModule contract

**Files:**
- Modify: `mobile/android/app/build.gradle`
- Create: `mobile/src/native/NativeUploadQueue.ts`
- Create: `mobile/src/features/upload/types.ts`
- Create: `mobile/src/features/upload/uploadService.ts`
- Create: `mobile/android/app/src/main/java/com/photo77/upload/db/UploadTaskEntity.kt`
- Create: `mobile/android/app/src/main/java/com/photo77/upload/db/UploadTaskDao.kt`
- Create: `mobile/android/app/src/main/java/com/photo77/upload/db/UploadDatabase.kt`
- Create: `mobile/android/app/src/main/java/com/photo77/bridge/NativeUploadQueueModule.kt`
- Test: `mobile/android/app/src/test/java/com/photo77/upload/db/UploadTaskDaoTest.kt`

- [ ] **Step 1: Add Room dependencies and write DAO tests**

Add Room runtime, KTX, compiler/KSP and Robolectric test dependencies. Test enqueue, state transitions, server isolation, lease acquisition and expired-lease recovery:

```kotlin
val leased = dao.acquireQueued(
    serverId = "server-a", owner = "worker-1", limit = 2, now = 1000, leaseUntil = 31000
)
assertEquals(listOf("task-1", "task-2"), leased.map { it.id })
assertTrue(dao.acquireQueued("server-a", "worker-2", 2, 1001, 31001).isEmpty())
```

- [ ] **Step 2: Verify DAO tests fail**

Run: `cd mobile/android && ./gradlew testDebugUnitTest --tests '*UploadTaskDaoTest'`

Expected: FAIL because Room queue classes do not exist.

- [ ] **Step 3: Implement queue schema**

Use states `queued`, `uploading`, `paused`, `succeeded`, `failed`, `canceled` and fields from design section 6.3. Add `leaseOwner` and `leaseUntilEpochMs`. DAO state updates must include the expected current state in the `WHERE` clause so notification actions and workers cannot overwrite each other.

- [ ] **Step 4: Expose a stable TurboModule API**

```ts
export type UploadQueueSnapshot = {
  tasks: UploadTask[];
  queued: number;
  uploading: number;
  succeeded: number;
  failed: number;
  sentBytes: number;
  totalBytes: number;
};

export interface Spec extends TurboModule {
  enqueue(serverId: string, deviceId: string, folderId: string, items: readonly PickedMedia[]): Promise<readonly string[]>;
  snapshot(serverId: string): Promise<UploadQueueSnapshot>;
  pause(serverId: string): Promise<void>;
  resume(serverId: string): Promise<void>;
  retryFailed(serverId: string): Promise<void>;
  cancel(taskIds: readonly string[]): Promise<void>;
}
```

- [ ] **Step 5: Verify native and TypeScript contracts**

Run: `cd mobile && npm run typecheck && cd android && ./gradlew testDebugUnitTest`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add mobile/package.json mobile/package-lock.json mobile/src/native/NativeUploadQueue.ts mobile/src/features/upload mobile/android/app
git commit -m "feat: add persistent Android upload queue"
```

### Task 12: Implement Photo Picker with persistent URI access

**Files:**
- Create: `mobile/src/native/NativePhotoPicker.ts`
- Create: `mobile/android/app/src/main/java/com/photo77/picker/NativePhotoPickerModule.kt`
- Test: `mobile/android/app/src/test/java/com/photo77/picker/NativePhotoPickerModuleTest.kt`

- [ ] **Step 1: Write picker result tests**

Test selection cancellation, multiple URI metadata, MIME filtering, `DISPLAY_NAME`/`SIZE` fallback, and persisted read grants. The returned DTO is:

```ts
export type PickedMedia = {
  uri: string;
  displayName: string;
  mimeType: string;
  size: number | null;
};
```

- [ ] **Step 2: Verify picker tests fail**

Run: `cd mobile/android && ./gradlew testDebugUnitTest --tests '*NativePhotoPickerModuleTest'`

Expected: FAIL because the picker module does not exist.

- [ ] **Step 3: Implement Android Photo Picker**

Register `ActivityResultContracts.PickMultipleVisualMedia`, request images and videos, inspect each `content://` URI through `ContentResolver`, and call `takePersistableUriPermission(uri, FLAG_GRANT_READ_URI_PERMISSION)` when the provider exposes the persistable flag. Return a rejected Promise with code `PICKER_METADATA_UNREADABLE` when a selected URI cannot be reopened; do not enqueue unusable jobs.

- [ ] **Step 4: Verify picker tests and debug build**

Run: `cd mobile && npm run typecheck && npm run android:assemble`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/native/NativePhotoPicker.ts mobile/android/app/src/main/java/com/photo77/picker mobile/android/app/src/test/java/com/photo77/picker
git commit -m "feat: select upload media with Android Photo Picker"
```

### Task 13: Implement concurrent native uploader and retry policy

**Files:**
- Create: `mobile/android/app/src/main/java/com/photo77/upload/UploadRequestBody.kt`
- Create: `mobile/android/app/src/main/java/com/photo77/upload/UploadApi.kt`
- Create: `mobile/android/app/src/main/java/com/photo77/upload/UploadScheduler.kt`
- Create: `mobile/android/app/src/main/java/com/photo77/upload/UploadRetryPolicy.kt`
- Create: `mobile/android/app/src/main/java/com/photo77/upload/UploadForegroundService.kt`
- Test: `mobile/android/app/src/test/java/com/photo77/upload/UploadSchedulerTest.kt`
- Test: `mobile/android/app/src/test/java/com/photo77/upload/UploadRetryPolicyTest.kt`

- [ ] **Step 1: Write concurrency and retry tests**

Use a fake uploader with latches and assert active work never exceeds 1, 2, 3 or 4. Change from 4 to 1 while four tasks run; assert existing transfers finish and only one replacement starts. Classify errors exactly:

```kotlin
assertEquals(PERMANENT, policy.classify(413, "UPLOAD_TOO_LARGE"))
assertEquals(SKIPPED, policy.classify(409, "DUPLICATE_PHOTO"))
assertEquals(RETRYABLE, policy.classify(429, "RATE_LIMITED"))
assertEquals(RETRYABLE, policy.classify(503, "INTERNAL_ERROR"))
assertEquals(PERMANENT, policy.classify(415, "UNSUPPORTED_MEDIA_TYPE"))
```

- [ ] **Step 2: Verify scheduler tests fail**

Run: `cd mobile/android && ./gradlew testDebugUnitTest --tests '*UploadSchedulerTest' --tests '*UploadRetryPolicyTest'`

Expected: FAIL because scheduler and policy classes do not exist.

- [ ] **Step 3: Implement streaming multipart upload**

`UploadRequestBody` reads `ContentResolver.openInputStream(uri)` into OkHttp's sink with an 64KiB buffer and invokes throttled byte callbacks. Multipart fields must be ordered `folder_id`, `conflict=rename`, then `file`, matching the current server parser. Never base64 encode or load the complete item in memory.

- [ ] **Step 4: Implement scheduler semantics**

Clamp configured concurrency to 1..4. Acquire Room leases up to available slots. A 401 performs one native refresh using the same mobile endpoint and atomically replaces Keystore credentials; refresh failure pauses all jobs for that device with `AUTH_REQUIRED`. Retryable failures use full-jitter exponential backoff capped at 15 minutes. Three consecutive 429/5xx responses reduce effective concurrency to 1 until three consecutive successes.

- [ ] **Step 5: Implement the data-sync foreground service**

Start only from a user upload/resume action, promote immediately with a notification, observe Wi-Fi/cellular preference, and stop when no runnable jobs remain. `onTimeout` and `onDestroy` release leases without marking jobs successful.

- [ ] **Step 6: Verify scheduler tests**

Run: `cd mobile/android && ./gradlew testDebugUnitTest`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add mobile/android/app/src/main/java/com/photo77/upload mobile/android/app/src/test/java/com/photo77/upload
git commit -m "feat: upload media concurrently in Android foreground service"
```

### Task 14: Add notifications, WorkManager recovery and upload UI

**Files:**
- Create: `mobile/android/app/src/main/java/com/photo77/notifications/UploadNotificationFactory.kt`
- Create: `mobile/android/app/src/main/java/com/photo77/notifications/UploadActionReceiver.kt`
- Create: `mobile/android/app/src/main/java/com/photo77/upload/UploadRecoveryWorker.kt`
- Modify: `mobile/android/app/src/main/AndroidManifest.xml`
- Create: `mobile/src/features/upload/UploadScreen.tsx`
- Create: `mobile/src/features/upload/UploadScreen.test.tsx`
- Test: `mobile/android/app/src/test/java/com/photo77/notifications/UploadNotificationFactoryTest.kt`

- [ ] **Step 1: Write notification and screen tests**

Assert channel ID stability, byte-based determinate progress, indeterminate fallback, pause/resume PendingIntent actions, completion summary, no file names/server URL in notification text, notification-permission guidance, picker → folder → enqueue flow, and retry-failed UI.

- [ ] **Step 2: Verify focused tests fail**

Run:

```bash
cd mobile
npm test -- src/features/upload/UploadScreen.test.tsx --runInBand
cd android && ./gradlew testDebugUnitTest --tests '*UploadNotificationFactoryTest'
```

Expected: both fail because UI and notification classes do not exist.

- [ ] **Step 3: Implement notification and recovery wiring**

Declare `POST_NOTIFICATIONS`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC`, the non-exported service, and receiver. Create channel `77photo_uploads_v1`. Update progress no more than once per second. Schedule unique WorkManager work per server with connected-network constraint; the Worker acquires the same Room leases as the service and exits successfully when another owner holds them.

- [ ] **Step 4: Implement the upload screen**

Show Photo Picker action, selected target folder, active/queued/completed/failed rows, overall progress, pause/resume, retry failures and cancel confirmation. Subscribe to throttled native snapshots while mounted and refresh once on AppState foreground. If Android 13+ notification permission is denied, show the background-upload limitation before starting.

- [ ] **Step 5: Verify uploads and Android manifest**

Run: `cd mobile && npm test -- src/features/upload --runInBand && npm run typecheck && npm run android:assemble`

Expected: PASS; merged manifest contains the data-sync service and notification permission.

- [ ] **Step 6: Commit**

```bash
git add mobile/src/features/upload mobile/android/app/src/main
git commit -m "feat: show and recover Android background uploads"
```

## Stage D — Settings, acceptance and release

### Task 15: Implement settings, CIDR editor and admin rescan

**Files:**
- Create: `mobile/src/features/settings/SettingsScreen.tsx`
- Create: `mobile/src/features/settings/LanRangesScreen.tsx`
- Create: `mobile/src/features/settings/RescanPanel.tsx`
- Create: `mobile/src/features/settings/SettingsScreen.test.tsx`
- Modify: `mobile/src/services/api/client.ts`
- Modify: `mobile/src/app/navigation.tsx`

- [ ] **Step 1: Write settings tests**

Cover concurrency values 1–4/default 2, cellular default off, built-in CIDR disable-only behavior, manual CIDR add/delete, catch-all rejection, global-range confirmation, server switch with queued-task decision, cache clear isolation, admin-only rescan, and polling stop on background/unmount.

```tsx
expect(screen.getByLabelText('同时上传数')).toHaveProp('selectedValue', 2);
fireEvent(screen.getByLabelText('同时上传数'), 'valueChange', 4);
await waitFor(() => expect(connectionStore.getState().uploadConcurrency).toBe(4));
expect(mockUploadQueue.setConcurrency).toHaveBeenCalledWith(4);
```

- [ ] **Step 2: Verify settings tests fail**

Run: `cd mobile && npm test -- src/features/settings --runInBand`

Expected: FAIL because settings screens do not exist.

- [ ] **Step 3: Implement settings groups**

Build Account & Server, LAN ranges, Upload & Storage, Language, and admin-only Server Management. Built-in ranges can be disabled but not edited; manual entries normalize to CIDR. Warn twice before accepting a globally routable manual range, and always reject `/0`. Do not show a persistent insecure banner after login.

- [ ] **Step 4: Implement rescan polling**

Add `startRescan` and `getRescan`. Poll serially every 1500ms only while AppState is active and status is queued/running. A `RESCAN_IN_PROGRESS` response must display the existing job when its ID is present; otherwise show a refresh action.

- [ ] **Step 5: Verify settings**

Run: `cd mobile && npm test -- src/features/settings --runInBand && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add mobile/src/features/settings mobile/src/services/api/client.ts mobile/src/app/navigation.tsx
git commit -m "feat: add Android settings and server scan controls"
```

### Task 16: Add accessibility, integration tests and Android E2E

**Files:**
- Create: `mobile/e2e/maestro/login-gallery.yaml`
- Create: `mobile/e2e/maestro/background-upload.yaml`
- Create: `mobile/e2e/maestro/lan-http.yaml`
- Create: `mobile/e2e/README.md`
- Create: `mobile/src/test/accessibility.test.tsx`
- Modify: feature tests from Tasks 9, 10, 14, 15

- [ ] **Step 1: Add accessibility assertions**

Render every core screen at 1.0x and 2.0x font scale. Assert all icon-only controls have `accessibilityLabel`, upload progress has role/progress values plus text, disabled folders explain their state, and no core action has a touch target below 48dp.

- [ ] **Step 2: Add Maestro flows**

`login-gallery.yaml`: launch clean, enter server, log in, wait for gallery, open a photo, swipe, open details, return.

`background-upload.yaml`: choose fixture media, select folder, set concurrency 2, begin upload, background App, open notification shade, assert progress text, tap pause/resume, return and assert completion summary.

`lan-http.yaml`: assert `http://192.168.1.10` shows the login warning and proceeds after confirmation; assert `http://8.8.8.8` is blocked.

- [ ] **Step 3: Run unit and integration gates**

Run:

```bash
go test ./...
go vet ./...
cd mobile
npm test -- --runInBand
npm run typecheck
npm run lint
npm run android:assemble
```

Expected: every command exits 0.

- [ ] **Step 4: Run E2E on the Android 12 emulator**

Run: `cd mobile && maestro test e2e/maestro`

Expected: all three flows PASS. Repeat manually on Android 13 and the current latest stable Android device/emulator, especially notification denial and data-sync timeout behavior.

- [ ] **Step 5: Commit**

```bash
git add mobile/e2e mobile/src/test mobile/src/features
git commit -m "test: cover Android client acceptance flows"
```

### Task 17: Complete CI, release configuration and operational docs

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/android-release.yml`
- Modify: `README.md`
- Create: `docs/operations/android-client.md`
- Modify: `docs/operations/acceptance.md`
- Modify: `docs/operations/security.md`
- Modify: `mobile/android/app/proguard-rules.pro`

- [ ] **Step 1: Add CI and release checks**

CI must run Go tests/vet, Web tests/typecheck/build, mobile Jest/typecheck/lint, Kotlin unit tests and debug APK assembly. Release workflow accepts a version tag, restores an upload keystore from encrypted repository secrets, builds AAB and APK, and uploads artifacts without printing passwords or key material.

- [ ] **Step 2: Document operator and user setup**

Document minimum server version, reverse-proxy HTTPS, IP SAN requirements, private-CA limitation, HTTP CIDR risk, notification permission, battery optimization behavior, upload restart semantics, cache clearing, device revocation and troubleshooting request IDs.

- [ ] **Step 3: Build the release variant**

Run: `cd mobile/android && ./gradlew clean bundleRelease assembleRelease`

Expected: signed local test artifacts are created under `app/build/outputs/bundle/release/` and `app/build/outputs/apk/release/`; R8 reports no missing classes.

- [ ] **Step 4: Run the repository release gate**

Run:

```bash
go test ./...
go vet ./...
cd web && npm ci && npm test -- --run && npm run typecheck && npm run build
cd ../mobile && npm ci && npm test -- --runInBand && npm run typecheck && npm run lint && npm run android:assemble
```

Expected: all commands exit 0.

- [ ] **Step 5: Audit the final diff and secrets**

Run:

```bash
git diff --check
git grep -nE '(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|Authorization: Bearer [A-Za-z0-9_-]{16,}|storePassword=|keyPassword=)' -- ':!docs/superpowers/plans/*'
```

Expected: `git diff --check` exits 0 and the secret scan returns no matches.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows README.md docs/operations mobile/android/app/proguard-rules.pro
git commit -m "build: prepare Android client release"
```

## Final acceptance gate

Do not call the Android client complete until all of the following are evidenced in one fresh run:

- [ ] `go test ./...` and `go vet ./...` pass.
- [ ] Existing Web tests, typecheck and build pass, proving Cookie+CSRF did not regress.
- [ ] Mobile Jest, TypeScript, lint, Kotlin unit tests and Android build pass.
- [ ] Android 12, 13 and current stable Android have completed the manual device matrix.
- [ ] Background upload continues after home-button navigation and shows notification progress.
- [ ] Process death, Wi-Fi loss and token refresh do not lose queued tasks.
- [ ] Concurrency 1 and 4 are observed and never exceeded.
- [ ] HTTPS domain, IP HTTPS, allowed private-IP HTTP and blocked public HTTP are verified.
- [ ] Normal users cannot see rescan; administrators can start and resume observing it.
- [ ] No secrets or private media metadata are written to logs or notification text.
- [ ] `docs/api/openapi.yaml`, security operations and Android client documentation match shipped behavior.
