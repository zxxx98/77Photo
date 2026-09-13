# Contextual Public Share Links Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

Goal: Replace member-targeted sharing with contextual, read-only public links for photos and folders, including optional passwords and fixed expiration choices, while removing the Sharing page and redundant upload start action.

Architecture: Add an internal/sharelinks Go package backed by share_links and share_link_access tables. Authenticated owners/admins create links; unauthenticated visitors use an SPA public route and token-scoped APIs, with an HttpOnly cookie after password verification. Keep internal/shares for legacy authenticated ACLs, but remove its frontend workspace. Use one reusable React ShareDialog for Viewer and folder rows.

Tech Stack: Go 1.22, SQLite embedded migrations, existing Argon2id helper, React 18, TypeScript, Vitest, lucide-react, Vite, and embedded Go static assets.

---

## File map

Create:

- migrations/003_share_links.sql: public-link and unlock-session schema with resource validation triggers.
- internal/sharelinks/service.go: link types, duration/token/password validation, creation, inspection, unlock, scope checks, and public photo resolution.
- internal/sharelinks/http.go: authenticated creation and unauthenticated metadata, unlock, list, and preview endpoints.
- internal/sharelinks/service_test.go and http_test.go: service and HTTP security/behavior coverage.
- web/src/features/sharing/shareDialog.ts and shareDialog.test.ts: pure copy and duration-selection helpers and tests.
- web/src/features/sharing/ShareDialog.tsx: reusable contextual create-link dialog.
- web/src/features/sharing/PublicSharePage.tsx: public photo/folder viewer and password gate.
- web/src/app/routes.ts and routes.test.ts: pure hash-route parsing helpers and tests.

Modify:

- internal/httpapi/server.go, internal/httpapi/services_test.go, and cmd/77photo/main.go: service construction and route mounting.
- web/src/app/api.ts and api.test.ts: share-link/public-view contracts and request serialization.
- web/src/app/App.tsx: public route before auth gating and removal of Sharing navigation.
- web/src/features/viewer/Viewer.tsx: Share2 action and readable folder name.
- web/src/features/folders/FoldersWorkspace.tsx: row-level Share2 action without nested buttons.
- web/src/features/upload/UploadWorkspace.tsx and web/src/styles/global.css: remove Start upload and update UI.
- docs/api/openapi.yaml and docs/PRODUCT_DESIGN.md: public-link contract and removed member-sharing UI.

Do not change internal/shares in the first implementation; existing member ACL records may still authorize old authenticated shared folders.

## Task 1: Schema and public-link domain

Files:
- Create migrations/003_share_links.sql
- Create internal/sharelinks/service.go
- Create internal/sharelinks/service_test.go
- Modify internal/database/database_test.go

- [ ] Step 1: Write failing domain tests

Create a fixture with an admin, folder, photo, and storage file. Add tests before implementation:

~~~go
func TestCreateUsesRequestedDuration(t *testing.T) {
  for _, test := range []struct {
    duration Duration
    want time.Duration
  }{
    {DurationOneDay, 24 * time.Hour},
    {DurationSevenDays, 7 * 24 * time.Hour},
    {DurationForever, 0},
  } {
    ctx, db, owner, photo := shareLinkFixture(t)
    service := NewService(db, fixtureStore(t), nil, false)
    before := time.Now().UTC()
    link, err := service.Create(ctx, acl.Principal{UserID: owner.ID, Role: acl.RoleAdmin}, CreateInput{
      ResourceType: ResourcePhoto, ResourceID: photo.ID, Duration: test.duration,
    })
    if err != nil { t.Fatal(err) }
    if test.want == 0 && link.ExpiresAt != nil { t.Fatalf("got %v, want forever", link.ExpiresAt) }
    if test.want > 0 && (link.ExpiresAt == nil || link.ExpiresAt.Sub(before) < test.want-time.Second || link.ExpiresAt.Sub(before) > test.want+time.Second) {
      t.Fatalf("got %v, want about %v after %v", link.ExpiresAt, test.want, before)
    }
  }
}

func TestCreateStoresOnlyDigests(t *testing.T) {
  ctx, db, owner, photo := shareLinkFixture(t)
  service := NewService(db, fixtureStore(t), nil, false)
  link, err := service.Create(ctx, acl.Principal{UserID: owner.ID, Role: acl.RoleAdmin}, CreateInput{
    ResourceType: ResourcePhoto, ResourceID: photo.ID,
    Duration: DurationSevenDays, Password: "correct horse battery staple",
  })
  if err != nil { t.Fatal(err) }
  var tokenHash, passwordHash string
  if err := db.QueryRowContext(ctx, "SELECT token_hash, password_hash FROM share_links WHERE id=?", link.ID).Scan(&tokenHash, &passwordHash); err != nil { t.Fatal(err) }
  if tokenHash == "" || tokenHash == link.Token || strings.Contains(passwordHash, "correct horse battery staple") {
    t.Fatalf("stored secrets are unsafe")
  }
}
~~~

Also verify a fresh database migration creates share_links and share_link_access.

- [ ] Step 2: Verify the tests fail

Run:

~~~bash
go test ./internal/sharelinks ./internal/database -run 'TestCreateUsesRequestedDuration|TestCreateStoresOnlyDigests|Test.*ShareLink' -count=1
~~~

Expected: missing package or migration failures, not unrelated fixture errors.

- [ ] Step 3: Add migration 003_share_links.sql

Use these columns and constraints:

~~~sql
CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('photo', 'folder')),
  resource_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS share_links_resource_idx ON share_links(resource_type, resource_id);

CREATE TABLE IF NOT EXISTS share_link_access (
  id TEXT PRIMARY KEY NOT NULL,
  share_link_id TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS share_link_access_link_idx ON share_link_access(share_link_id, expires_at);
~~~

Add these triggers after the indexes. They reject a photo resource unless it
exists with deleted_at null, or a folder resource unless it exists. A
polymorphic resource_id cannot use one direct foreign key. The service must
still recheck deletion, revocation, and expiry.

~~~sql
CREATE TRIGGER IF NOT EXISTS share_links_resource_insert
BEFORE INSERT ON share_links
WHEN (NEW.resource_type = 'photo' AND NOT EXISTS (
  SELECT 1 FROM photos WHERE id = NEW.resource_id AND deleted_at IS NULL
)) OR (NEW.resource_type = 'folder' AND NOT EXISTS (
  SELECT 1 FROM folders WHERE id = NEW.resource_id
))
BEGIN
  SELECT RAISE(ABORT, 'share link resource does not exist');
END;

CREATE TRIGGER IF NOT EXISTS share_links_resource_update
BEFORE UPDATE OF resource_type, resource_id ON share_links
WHEN (NEW.resource_type = 'photo' AND NOT EXISTS (
  SELECT 1 FROM photos WHERE id = NEW.resource_id AND deleted_at IS NULL
)) OR (NEW.resource_type = 'folder' AND NOT EXISTS (
  SELECT 1 FROM folders WHERE id = NEW.resource_id
))
BEGIN
  SELECT RAISE(ABORT, 'share link resource does not exist');
END;
~~~

- [ ] Step 4: Implement the minimal domain service

Define ResourceType, Duration, ResourcePhoto, ResourceFolder, DurationOneDay, DurationSevenDays, DurationForever, CreateInput, and Link. Link has ID, ResourceType, ResourceID, URL, ExpiresAt, PasswordProtected, and an internal Token field excluded from JSON.

Implement NewService(db, store, thumbnailService, secureCookies), Create, Inspect, Unlock, ListPhotos, and PublicPhoto. Create validates resource type, ID, duration, owner/admin permission, and optional password through auth.ValidateCredentials('valid-user', password). Generate a 32-byte crypto/rand token and sl_ ID, store only SHA-256 token and Argon2id password digests, and return URL /#/share/<token>. Use one UTC now value and treat now greater than or equal to expires_at as expired.

Inspect returns resource type, readable name, folder path, password-required status, and expiry without secrets. Build folder paths with a recursive CTE. ListPhotos returns one photo for a photo link or all non-deleted descendants for a folder link. PublicPhoto rejects a photo outside the linked scope. Unlock verifies the password, creates a random share_link_access token no later than the link expiry, and returns that raw cookie token only to the HTTP layer. Unknown links and wrong passwords use one generic unavailable/auth error.

- [ ] Step 5: Run and commit the domain layer

Run:

~~~bash
gofmt -w internal/sharelinks/service.go internal/sharelinks/service_test.go
go test ./internal/sharelinks ./internal/database -run 'TestCreateUsesRequestedDuration|TestCreateStoresOnlyDigests|Test.*ShareLink' -count=1
~~~

Expected: focused tests pass.

Commit:

~~~bash
git add migrations/003_share_links.sql internal/sharelinks internal/database/database_test.go
git commit -m 'feat: add public share link domain'
~~~

## Task 2: HTTP endpoints and server integration

Files:
- Create internal/sharelinks/http.go
- Create internal/sharelinks/http_test.go
- Modify internal/httpapi/server.go
- Modify internal/httpapi/services_test.go
- Modify cmd/77photo/main.go

- [ ] Step 1: Write failing HTTP tests

Cover these exact behaviors with httptest, an authenticated owner session, an image fixture, and a fake thumbnail service:

~~~go
func TestCreatePhotoLinkRequiresCSRFAndReturnsPublicURL(t *testing.T)
func TestCreateFolderLinkRejectsInvalidDuration(t *testing.T)
func TestPasswordlessLinkCanBeReadWithoutLogin(t *testing.T)
func TestProtectedLinkRequiresUnlockBeforePhotoList(t *testing.T)
func TestUnlockSetsHttpOnlyScopedCookie(t *testing.T)
func TestWrongPasswordExpiredAndRevokedLinksAreUnavailable(t *testing.T)
func TestPhotoLinkCannotReadAnotherPhoto(t *testing.T)
func TestFolderLinkContainsOnlyDescendantPhotos(t *testing.T)
~~~

Assert 201 and a URL beginning /#/share/, 403 without CSRF, 401 with SHARE_PASSWORD_REQUIRED before unlock, an HttpOnly cookie after correct unlock, inline media with no attachment disposition, and no access to out-of-scope photos.

- [ ] Step 2: Verify HTTP tests fail

Run:

~~~bash
go test ./internal/sharelinks ./internal/httpapi -run 'Test(Create|Passwordless|Protected|Unlock|WrongPassword|PhotoLink|FolderLink)' -count=1
~~~

Expected: missing handler or route failures.

- [ ] Step 3: Implement the handler

Support exactly:

~~~text
POST /api/v1/share-links
GET  /api/v1/share-links/{token}
POST /api/v1/share-links/{token}/unlock
GET  /api/v1/share-links/{token}/photos
GET  /api/v1/share-links/{token}/photos/{photoID}/preview
~~~

Creation authenticates, validates CSRF, rejects unknown JSON fields, calls Service.Create, and returns 201. Public routes do not require login or CSRF and use generic SHARE_UNAVAILABLE for malformed, missing, revoked, expired, or deleted links.

Metadata returns resource_type, name, optional folder_name, password_required, and expires_at. Photo list returns id, filename, mime_type, captured_at, width, and height. Unlock accepts password and sets 77photo_share_access as HttpOnly, SameSite=Lax, configured Secure, token-route Path, and Max-Age. Never serialize or log passwords, hashes, or unlock tokens.

Images use the thumbnail service at 1280. Videos stream the source with Content-Disposition inline and Cache-Control no-store. There is no public original-download route. Recheck token scope and expiry on every request.

- [ ] Step 4: Mount the service

Add ShareLinks *sharelinks.Service to httpapi.Services. Mount the handler at both route prefixes. Construct it in cmd/77photo/main.go with the existing database, storage, thumbnail service, and secure-cookie setting. Add a server test proving the public route is mounted and unknown API routes remain 404.

- [ ] Step 5: Run and commit

Run:

~~~bash
gofmt -w internal/sharelinks internal/httpapi/server.go internal/httpapi/services_test.go cmd/77photo/main.go
go test ./internal/sharelinks ./internal/httpapi ./cmd/77photo -count=1
~~~

Expected: selected packages pass.

Commit:

~~~bash
git add internal/sharelinks internal/httpapi cmd/77photo/main.go
git commit -m 'feat: expose public share link endpoints'
~~~

## Task 3: Frontend API and pure dialog rules

Files:
- Modify web/src/app/api.ts and web/src/app/api.test.ts
- Create web/src/features/sharing/shareDialog.ts and shareDialog.test.ts

- [ ] Step 1: Write failing tests

Test:

~~~ts
expect(selectShareDuration('1_day', '7_days')).toBe('7_days');
expect(selectShareDuration('7_days', 'forever')).toBe('forever');
expect(shareCopy('photo', 'IMG_2048.jpg').title).toBe('Share photo');
expect(shareCopy('folder', 'Family / Summer trip').createLabel).toBe('Create folder link');
~~~

Add API assertions that createShareLink serializes resource_type, resource_id, duration, and password; getFolder requests /api/v1/folders/f_1; public metadata requests /api/v1/share-links/token; unlock requests /unlock; and publicSharePreviewURL encodes token and photo ID.

- [ ] Step 2: Verify tests fail

Run from web:

~~~bash
npm test -- --run src/app/api.test.ts src/features/sharing/shareDialog.test.ts
~~~

Expected: missing type, method, and helper failures.

- [ ] Step 3: Implement contracts and helpers

Add ShareResourceType, ShareDuration, ShareLink, PublicShare, and PublicPhoto. Add these ApiClient methods:

~~~ts
createShareLink(input: {
  resource_type: ShareResourceType;
  resource_id: string;
  duration: ShareDuration;
  password?: string;
}): Promise<ShareLink>;
getFolder(id: string): Promise<Folder>;
getPublicShare(token: string): Promise<PublicShare>;
unlockPublicShare(token: string, password: string): Promise<PublicShare>;
listPublicSharePhotos(token: string): Promise<{ items: PublicPhoto[] }>;
publicSharePreviewURL(token: string, photoID: string): string;
~~~

Use the existing request helper, credentials include, and CSRF behavior. Define shareDurations as 1_day/1 day, 7_days/7 days, forever/Forever. selectShareDuration always returns the new value. shareCopy returns resource-specific title, createLabel, successPrefix, and name. Add shareButtonLabel(type) returning Share photo or Share folder, and successMessage(type, duration) returning the resource-specific completion text.

- [ ] Step 4: Run and commit

Run:

~~~bash
npm test -- --run src/app/api.test.ts src/features/sharing/shareDialog.test.ts
~~~

Expected: focused tests pass.

Commit:

~~~bash
git add web/src/app/api.ts web/src/app/api.test.ts web/src/features/sharing/shareDialog.ts web/src/features/sharing/shareDialog.test.ts
git commit -m 'feat: add share link client contracts'
~~~

## Task 4: Reusable ShareDialog

Files:
- Create web/src/features/sharing/ShareDialog.tsx
- Modify web/src/features/sharing/shareDialog.ts and shareDialog.test.ts
- Modify web/src/styles/global.css

- [ ] Step 1: Add failing success-message tests

Test Photo shared for 7 days and Folder shared forever, and test that changing a duration never produces an empty selection.

- [ ] Step 2: Verify the focused failure

Run:

~~~bash
npm test -- --run src/features/sharing/shareDialog.test.ts
~~~

Expected: the success-message tests fail because the helper is not implemented.

- [ ] Step 3: Implement the dialog

Props are resource {type: ShareResourceType, id: string, name: string}, api, and onClose. Render role dialog and aria-modal, Share2 in the heading, and X to close. Do not render a member selector or permission selector. Show Anyone with the link can view and No account or sign-in required.

Render three real input type=checkbox controls labelled 1 day, 7 days, Forever. Keep one duration state, default forever, and mark only the matching checkbox checked. Clicking any option replaces the prior value. Render optional password input with placeholder Leave blank for no password. Submit createShareLink with resource, duration, and password. Disable during create and map errors to one alert.

After success show a read-only URL input, copy button using navigator.clipboard.writeText, and resource-specific success message. Do not show the password again. Add responsive modal, checkbox list, password, URL/copy, and 44px touch-target styles.

- [ ] Step 4: Run and commit

Run:

~~~bash
npm test -- --run src/features/sharing/shareDialog.test.ts
npm run typecheck
~~~

Expected: tests and typecheck pass.

Commit with message feat: add contextual share dialog.

## Task 5: Public SPA viewer

Files:
- Create web/src/features/sharing/PublicSharePage.tsx
- Create web/src/app/routes.ts and routes.test.ts
- Modify web/src/app/App.tsx, web/src/app/api.test.ts, web/src/styles/global.css

- [ ] Step 1: Write failing route tests

Add:

~~~ts
expect(readPublicShareToken('#/share/sl_abc')).toBe('sl_abc');
expect(readPublicShareToken('#/gallery')).toBeNull();
expect(readPublicShareToken('#/share/')).toBeNull();
~~~

Test public metadata, unlock, list, and preview request serialization.

- [ ] Step 2: Verify failure

Run npm test -- --run src/app/api.test.ts. Expected: missing route/helper/API method failures.

- [ ] Step 3: Implement route and viewer states

Export readPublicShareToken(hash: string): string | null from routes.ts. Accept only #/share/<non-empty token> with no additional slash. App.tsx calls it before authenticated-shell gating and renders PublicSharePage so recipients do not reach LoginPage.

Implement loading, generic unavailable, password form, single-photo, and folder-grid states. Use Shared photo or Shared folder and resource name. Never render download, rename, move, delete, upload, or member controls. Use controlsList=nodownload for video as a UI hint while the backend exposes no download route. Successful unlock reloads metadata/photos and incorrect password maps to one generic message.

- [ ] Step 4: Run and commit

Run npm test -- --run src/app/api.test.ts and npm run typecheck. Expected: pass.

Commit with message feat: add public share viewer.

## Task 6: Contextual UI integration and existing bug cleanup

Files:
- Modify web/src/features/viewer/Viewer.tsx
- Modify web/src/features/folders/FoldersWorkspace.tsx
- Modify web/src/features/upload/UploadWorkspace.tsx
- Modify web/src/app/App.tsx
- Modify web/src/styles/global.css
- Delete web/src/features/sharing/SharingWorkspace.tsx after the reference scan confirms no imports

- [ ] Step 1: Add regression tests

Test shareButtonLabel('photo') equals Share photo, shareButtonLabel('folder') equals Share folder, and readView('#/sharing') equals gallery. Add a focused upload markup test that reads UploadWorkspace.tsx and asserts it does not contain the text Start upload while it still contains the Retry branch text.

- [ ] Step 2: Verify the new tests fail

Run npm test -- --run. Expected: contextual-entry assertions fail until components are wired.

- [ ] Step 3: Update Viewer

Load api.getFolder(photo.folder_id) whenever the selected photo changes. Render folder.name or Unknown folder, never the raw ID. Refetch after a successful move. Add icon-only Share2 beside authenticated Download and Delete with aria-label Share photo; it opens ShareDialog with photo ID and filename.

- [ ] Step 4: Update FoldersWorkspace

Refactor each row into two sibling buttons, never nested buttons:

~~~tsx
<div className="folder-row">
  <button className="folder-row-link" onClick={() => setParent(folder)}>
    <Folder size={19} />
    <span className="folder-row-copy">
      <strong>{folder.name}</strong>
      <small>{(folder.photo_count ?? 0) + ' photos · ' + (folder.child_folder_count ?? 0) + ' folders'}</small>
    </span>
    <ChevronRight size={18} />
  </button>
  <button className="icon-button folder-share-button"
    aria-label={'Share folder ' + folder.name}
    onClick={() => setShareResource({type: 'folder', id: folder.id, name: folder.name})}>
    <Share2 size={18} />
  </button>
</div>
~~~

Render one ShareDialog at workspace level. Preserve navigation and breadcrumbs.

- [ ] Step 5: Remove stale UI

Remove Sharing from desktop and mobile nav, its import and workspace branch, and make #/sharing fall back to gallery. Remove only the Start upload button and .upload-start rule; retain automatic upload and retry. Remove SharingWorkspace after rg confirms no imports.

- [ ] Step 6: Run and commit

Run:

~~~bash
npm test -- --run
npm run typecheck
npm run build
~~~

Expected: all tests, typecheck, and build pass.

Commit with message fix: add contextual sharing and clean upload actions.

## Task 7: API and product documentation

Files:
- Modify docs/api/openapi.yaml
- Modify docs/PRODUCT_DESIGN.md

- [ ] Step 1: Document the new contract

Add ShareLink, PublicShare, PublicPhoto, CreateShareLinkRequest, and stable errors. Document authenticated POST /api/v1/share-links and the four public token routes. State read-only scope, folder descendants, password behavior, expiration values, and lack of original-download endpoint. Remove or label legacy the member-targeted Sharing workspace descriptions.

- [ ] Step 2: Validate and commit

Run:

~~~bash
rg -n 'share-links|PublicShare|CreateShareLinkRequest|SharingWorkspace|Start upload' docs/api/openapi.yaml docs/PRODUCT_DESIGN.md
git diff --check
~~~

Expected: new paths and schemas exist and stale UI descriptions are removed or explicitly legacy.

Commit with message docs: document public share links.

## Task 8: Full verification and public deployment on port 28888

Files:
- Generated web/dist and internal/webassets/static
- Runtime exact application process on :28888

- [ ] Step 1: Run all checks

Run:

~~~bash
go test ./...
cd web && npm test -- --run && npm run typecheck && npm run build
cd .. && git diff --check && git status --short
~~~

Expected: all tests, typecheck, build, and whitespace checks pass.

- [ ] Step 2: Refresh embedded assets

Copy web/dist/. into internal/webassets/static/. Run web asset tests and inspect that only expected bundle files changed.

- [ ] Step 3: Replace runtime safely

Stop the persistent visual companion with its recorded session directory. Resolve the exact listener with ss -ltnp '( sport = :28888 )'. Stop only the old test PID, never delete/reset the data directory, build a fresh binary under /tmp/77photo-public-share-links, and start it on :28888 using existing database/storage paths. Record the new PID in /tmp/77photo-test.pid.

- [ ] Step 4: Verify the deployed flow

Run:

~~~bash
curl --fail --silent http://158.178.243.20:28888/healthz
curl --fail --silent http://158.178.243.20:28888/ | rg 'index-[A-Za-z0-9]+\\.js'
~~~

Use a temporary authenticated session to create one passwordless photo link and one password-protected folder link. Verify no-login viewing, password-required before unlock, correct unlock cookie, wrong password, expiry, revoked behavior, scope isolation, no original download, no Sharing nav, no Start upload, readable folder text, and Share2 icons.

- [ ] Step 5: Commit generated assets

Run git diff --check and git status --short. Add internal/webassets/static and commit with message build: publish contextual public sharing UI. Do not claim completion until deployed smoke checks pass.
