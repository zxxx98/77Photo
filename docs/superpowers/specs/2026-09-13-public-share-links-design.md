# Contextual public share links

## Problem

The current sharing flow is a separate `Sharing` workspace that creates
folder ACLs for a selected family member. It does not match the desired
workflow: sharing should start from the resource being viewed, produce a
public read-only link, optionally protect that link with a password, and
expire it after a user-selected duration. The current folder selector also
allows invalid recipient choices, and the photo viewer renders a folder ID
instead of a readable folder name.

The upload workspace now starts selected files automatically, so its `Start
upload` action is redundant and should be removed.

## Goals

- Remove the `Sharing` workspace from desktop and mobile navigation.
- Let an authenticated owner or administrator create a public link for a
  photo or folder from the relevant context.
- Make public links view-only. They must not expose edit, delete, or original
  download actions.
- Support exactly one expiration choice per link: 1 day, 7 days, or forever.
  The UI uses checkbox controls as requested, while the form enforces that
  only one duration can be checked at a time.
- Allow an optional password. A blank password means anyone with the link can
  view; a configured password is required before shared content is returned.
- Use distinct photo and folder labels in the share dialog, public viewer, and
  completion feedback.
- Replace the share arrow with the lucide `Share2` node icon in both the photo
  details action row and folder list rows.
- Show the photo's readable folder name in the details inspector.
- Remove the redundant `Start upload` button while retaining failed/cancelled
  item retry behavior.

## Non-goals

- This change does not add public editing, deletion, upload, or original-file
  download capabilities.
- This change does not add arbitrary expiration dates or custom durations.
- This change does not redesign the gallery or folder navigation beyond adding
  a contextual share action.
- Existing authenticated ACL behavior is not used to authorize public links;
  public links are a separate, read-only access mechanism.

## User experience

### Contextual entry points

The photo viewer keeps its download, `Share2`, and delete actions in one
compact icon-only row. The share button has an accessible label such as
`Share photo` and opens the share dialog without closing the viewer.

Each folder row gets an icon-only `Share2` button between the folder summary and
the navigation chevron. Clicking the row still opens the folder; clicking the
share button stops row navigation and opens the same dialog with the folder
resource selected. The button has an accessible label such as `Share folder`.

The old desktop `Sharing` navigation item, mobile `Sharing` item, and
`SharingWorkspace` are removed. A public share viewer remains a separate route
and is not the authenticated Sharing workspace.

### Share dialog

The dialog derives its copy from the resource type:

- Photo: `Share photo`, the filename, `Create photo link`, and
  `Photo shared for 7 days`.
- Folder: `Share folder`, the readable folder path/name, `Create folder link`,
  and `Folder shared forever`.

The dialog does not ask for a family member. It explains that anyone with the
link can view and that no account is required. It contains:

- Three checkbox inputs labelled `1 day`, `7 days`, and `Forever`. Exactly one
  is selected, with `Forever` selected by default.
- An optional password input. Blank means no password. A configured password
  must satisfy the existing password policy and is never returned in an API
  response.
- A primary create-link action.

After creation, the dialog shows the generated share URL in a read-only field
and a copy action, plus the resource-specific success message. The raw token
is returned only as part of this creation response and is not persisted in the
database.

### Public viewer

The generated URL opens a public viewer without requiring an authenticated
session. A passwordless link immediately displays the resource. A protected
link displays a password form and only shows the resource after successful
verification. The public viewer distinguishes `Shared photo` from `Shared
folder`, displays the resource name, and offers view controls only. It does
not render download, rename, move, delete, or upload actions.

A folder link lists photos in the folder subtree using the existing read-only
photo presentation. A photo link displays only the linked photo. Expired,
revoked, malformed, or missing links show a generic unavailable state without
revealing whether a resource used to exist.

## Backend design

### Persistence

Add a `share_links` table through a new migration. It is separate from the
existing authenticated `shares` table so the old ACL schema and inherited
permissions remain stable while the contextual public-link feature is added.
The table contains:

- `id`: internal opaque share-link ID.
- `resource_type`: `photo` or `folder`.
- `resource_id`: referenced application resource ID.
- `token_hash`: SHA-256 hash of a cryptographically random URL token.
- `password_hash`: nullable Argon2id PHC string.
- `expires_at`: nullable timestamp; null represents forever.
- `created_at` and `updated_at` timestamps.
- `revoked_at`: nullable timestamp for immediate invalidation.

Add an index on `token_hash` and on `(resource_type, resource_id)` for
validation and contextual lookup. Because `resource_id` is polymorphic, the
SQLite migration uses insert/update triggers to reject a link whose photo or
folder resource does not exist; the service still rechecks soft-deleted
photos and accessible folders before serving content. Access-session records
use a normal foreign key to cascade when their share link is removed.

The service generates a high-entropy random token, stores only its SHA-256
digest, and returns the raw token once in the create response. Passwords use
the existing Argon2id helper and validation policy. The API never logs or
serializes either secret.

### Authenticated creation API

Replace the UI's use of the member-share create flow with a public-link API:

```text
POST /api/v1/share-links
```

The request contains:

```json
{
  "resource_type": "photo",
  "resource_id": "p_…",
  "duration": "7_days",
  "password": "optional password"
}
```

`resource_type` is `photo` or `folder`; `duration` is `1_day`, `7_days`, or
`forever`; `password` may be omitted or empty. The request requires an
authenticated session, a valid CSRF token, and write/manage authority over the
resource. Creation always records read-only access.

The response contains the link metadata and generated URL, but no password or
token hash:

```json
{
  "id": "sl_…",
  "resource_type": "photo",
  "resource_id": "p_…",
  "url": "/share/…",
  "expires_at": "2026-09-20T00:00:00Z",
  "password_protected": true
}
```

The existing member-share list/create/revoke UI and its client methods are no
longer used. The legacy authenticated share endpoints and data may remain for
ACL compatibility, but no new UI path presents member selection or write
permission.

### Public access API

Serve the public viewer through an SPA route such as `#/share/{token}` and add
unauthenticated endpoints under the token namespace:

```text
GET  /api/v1/share-links/{token}
POST /api/v1/share-links/{token}/unlock
GET  /api/v1/share-links/{token}/photos
GET  /api/v1/share-links/{token}/photos/{photoID}/preview
```

The metadata endpoint returns the resource type/name, expiration, and whether
a password is required. If the link is passwordless, it also permits content
requests. If protected, content requests return a stable password-required
error until the unlock endpoint verifies the password.

Successful unlock sets a short-lived, HttpOnly, Secure-when-configured,
SameSite=Lax share-access cookie scoped to the public share routes. The cookie
is random and server-verifiable, does not contain the password, and expires no
later than the link's own expiration. Invalid passwords return a generic
authentication error and do not disclose link metadata. Public requests never
use the authenticated user's session or CSRF token.

The public photo endpoints reuse server-side read/preview logic but do not
expose original-file download routes. They enforce the link's resource scope:
a photo link can return only its photo, and a folder link can return only
non-deleted photos in that folder subtree. Every request rechecks expiration
and revocation.

### Errors

Use stable API errors for invalid resource type, invalid duration, inaccessible
resource, invalid password length, expired link, missing link, password
required, and incorrect password. The frontend maps them to concise inline
messages and never displays raw server/database errors. Creation failures must
not leave a partially inserted link or expose a generated token.

## Frontend structure

- Add a reusable `ShareDialog` component that accepts a photo or folder
  resource, owns duration/password/create/link-copy state, and renders
  resource-specific text.
- Extend `ApiClient` with public-link creation and public-view methods. Keep
  credentials and CSRF behavior consistent for authenticated creation; public
  reads use `credentials: 'include'` only for the share-access cookie.
- Pass the current resource into `ShareDialog` from `Viewer` and
  `FoldersWorkspace`.
- Add `getFolder(id)` or an equivalent readable-folder lookup to the client and
  use it in `Viewer`; refresh it after a move so the inspector never falls
  back to the folder ID when the request succeeds.
- Remove `SharingWorkspace`, its navigation item, and unused sharing-page
  styles/client wiring. Keep public share route handling before authenticated
  shell gating so a recipient does not get redirected to login.
- Remove the upload start button and its now-unused style, leaving automatic
  start, progress, cancellation, and per-item retry intact.
- Use lucide `Share2` for every contextual share button, icon-only with
  resource-specific `aria-label` values and a minimum 44px touch target.

## Testing and acceptance

### Backend tests

- Create passwordless photo and folder links with each duration and verify the
  returned type, URL, password flag, and expiration.
- Verify only the owner/administrator can create a link and CSRF is required.
- Verify token digests and password hashes are persisted, while raw secrets
  never appear in response bodies or serialized records.
- Verify passwordless public reads work without login and protected reads are
  blocked until the correct password unlocks the link.
- Verify wrong passwords, expired links, revoked links, malformed tokens, and
  missing resources fail without leaking resource existence.
- Verify photo links cannot read another photo and folder links are limited to
  their subtree.
- Verify public endpoints do not offer edit, delete, or original-download
  behavior.
- Preserve the existing authenticated ACL/share test suite until legacy share
  data is intentionally migrated.

### Frontend tests

- Verify the share dialog sends the correct resource type, duration, and
  optional password, and renders photo/folder-specific copy.
- Verify exactly one duration checkbox is selected and changing it clears the
  prior choice.
- Verify the generated URL is shown with a copy action and success feedback
  includes resource type and duration.
- Verify folder-row sharing does not navigate into the folder and uses the
  selected folder ID.
- Verify viewer folder metadata renders the readable name and updates after a
  move.
- Verify no `Sharing` navigation item or `Start upload` action is rendered.
- Verify public password and passwordless states render the correct viewer
  flow.

### Verification commands

Run the complete Go test suite, the complete Vitest suite, frontend typecheck,
frontend production build, `git diff --check`, and a manual smoke test against
the public service on port `28888`. The smoke test must create one passwordless
photo link, one password-protected folder link, verify both public flows, and
confirm expired links are rejected.
