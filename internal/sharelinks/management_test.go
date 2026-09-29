package sharelinks

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
	dbstore "github.com/zxxx98/77Photo/internal/database"
	"github.com/zxxx98/77Photo/internal/folders"
)

func TestManagedLinksPaginationPermissionsAndStatuses(t *testing.T) {
	f := shareLinkFixture(t)
	ctx := context.Background()
	service := NewService(f.db, f.store, nil, false)
	owner := acl.Principal{UserID: f.owner.ID, Role: acl.RoleUser}
	admin := acl.Principal{UserID: f.owner.ID, Role: acl.RoleAdmin}
	other := acl.Principal{UserID: "u_other", Role: acl.RoleUser}
	if _, err := f.db.Exec(`INSERT INTO users(id,username,password_hash,role,is_active,created_at,updated_at) VALUES('u_other','other','hash','user',1,'2026-01-01','2026-01-01')`); err != nil {
		t.Fatal(err)
	}
	links := make([]Link, 3)
	for i := range links {
		var err error
		links[i], err = service.Create(ctx, admin, CreateInput{ResourceType: ResourcePhoto, ResourceID: f.photoID, Duration: DurationForever})
		if err != nil {
			t.Fatal(err)
		}
		// Keep keyset ordering deterministic.
		if _, err := f.db.Exec(`UPDATE share_links SET created_at=? WHERE id=?`, time.Date(2026, 1, 1, i, 0, 0, 0, time.UTC).Format(time.RFC3339Nano), links[i].ID); err != nil {
			t.Fatal(err)
		}
	}
	page, err := service.ListManaged(ctx, owner, ManageFilter{Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 || page.NextCursor == "" || page.Items[0].ID != links[2].ID {
		t.Fatalf("first page = %+v", page)
	}
	second, err := service.ListManaged(ctx, owner, ManageFilter{Limit: 2, Cursor: page.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Items) != 1 || second.Items[0].ID != links[0].ID || second.NextCursor != "" {
		t.Fatalf("second page = %+v", second)
	}
	encoded, _ := json.Marshal(page)
	if strings.Contains(string(encoded), links[2].Token) || strings.Contains(string(encoded), "token_hash") || strings.Contains(string(encoded), "password_hash") || strings.Contains(string(encoded), "storage_path") {
		t.Fatalf("management leaked secrets: %s", encoded)
	}
	if _, err := service.ListManaged(ctx, owner, ManageFilter{Cursor: "bad"}); err != ErrInvalid {
		t.Fatalf("invalid cursor = %v", err)
	}
	otherPage, err := service.ListManaged(ctx, other, ManageFilter{})
	if err != nil || len(otherPage.Items) != 0 {
		t.Fatalf("unrelated user's page = %+v, %v", otherPage, err)
	}
	if err := service.RevokeManaged(ctx, other, links[0].ID); err != ErrNotFound {
		t.Fatalf("other revoke = %v", err)
	}
	if err := service.RevokeManaged(ctx, owner, links[0].ID); err != nil {
		t.Fatal(err)
	}
	if err := service.RevokeManaged(ctx, owner, links[0].ID); err != nil {
		t.Fatalf("repeat revoke = %v", err)
	}
	revoked, err := service.ListManaged(ctx, owner, ManageFilter{Status: "revoked"})
	if err != nil || len(revoked.Items) != 1 || revoked.Items[0].ID != links[0].ID {
		t.Fatalf("revoked = %+v, %v", revoked, err)
	}
	if _, err := f.db.Exec(`UPDATE share_links SET expires_at=? WHERE id=?`, "2025-01-01T00:00:00Z", links[1].ID); err != nil {
		t.Fatal(err)
	}
	expired, err := service.ListManaged(ctx, owner, ManageFilter{Status: "expired"})
	if err != nil || len(expired.Items) != 1 || expired.Items[0].ID != links[1].ID {
		t.Fatalf("expired = %+v, %v", expired, err)
	}
	if _, err := f.db.Exec(`UPDATE photos SET deleted_at='2026-01-01T00:00:00Z' WHERE id=?`, f.photoID); err != nil {
		t.Fatal(err)
	}
	unavailable, err := service.ListManaged(ctx, owner, ManageFilter{Status: "unavailable"})
	if err != nil || len(unavailable.Items) != 2 || unavailable.Items[0].ID != links[2].ID {
		t.Fatalf("unavailable = %+v, %v", unavailable, err)
	}
	if err := service.RevokeManaged(ctx, owner, links[2].ID); err != nil {
		t.Fatalf("deleted photo revoke = %v", err)
	}
	if _, err := f.db.Exec(`UPDATE photos SET owner_id='u_other' WHERE id=?`, f.photoID); err != nil {
		t.Fatal(err)
	}
	old, err := service.ListManaged(ctx, owner, ManageFilter{})
	if err != nil || len(old.Items) != 0 {
		t.Fatalf("old owner links = %+v, %v", old, err)
	}
	transferred, err := service.ListManaged(ctx, other, ManageFilter{})
	if err != nil || len(transferred.Items) != 3 {
		t.Fatalf("new owner links = %+v, %v", transferred, err)
	}
	if err := service.RevokeManaged(ctx, owner, links[1].ID); err != ErrNotFound {
		t.Fatalf("old owner revoke after transfer = %v", err)
	}
}

func TestManagedPaginationSortsFractionalTimestamps(t *testing.T) {
	f := shareLinkFixture(t)
	ctx := context.Background()
	service := NewService(f.db, f.store, nil, false)
	principal := acl.Principal{UserID: f.owner.ID, Role: acl.RoleAdmin}
	first, err := service.Create(ctx, principal, CreateInput{ResourceType: ResourceFolder, ResourceID: f.folderID, Duration: DurationForever})
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.Create(ctx, principal, CreateInput{ResourceType: ResourceFolder, ResourceID: f.folderID, Duration: DurationForever})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.ExecContext(ctx, "UPDATE share_links SET created_at='2026-01-01T00:00:00Z' WHERE id=?", first.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.ExecContext(ctx, "UPDATE share_links SET created_at='2026-01-01T00:00:00.100Z' WHERE id=?", second.ID); err != nil {
		t.Fatal(err)
	}
	page, err := service.ListManaged(ctx, principal, ManageFilter{Limit: 1})
	if err != nil || len(page.Items) != 1 || page.Items[0].ID != second.ID || page.NextCursor == "" {
		t.Fatalf("first time page=%+v, %v", page, err)
	}
	next, err := service.ListManaged(ctx, principal, ManageFilter{Limit: 1, Cursor: page.NextCursor})
	if err != nil || len(next.Items) != 1 || next.Items[0].ID != first.ID || next.NextCursor != "" {
		t.Fatalf("second time page=%+v, %v", next, err)
	}
}

func TestManagedPaginationPreservesNanosecondsAndBreaksTiesByID(t *testing.T) {
	f := shareLinkFixture(t)
	ctx := context.Background()
	service := NewService(f.db, f.store, nil, false)
	principal := acl.Principal{UserID: f.owner.ID, Role: acl.RoleUser}
	// IDs deliberately run against chronological order. Equal instants with
	// different precision must still use the ID tie-breaker across page boundaries.
	records := []struct{ id, created string }{
		{"sl_a", "2026-01-02T00:00:00Z"},
		{"sl_b", "2026-01-01T23:59:59.999999999Z"},
		{"sl_c", "2026-01-01T00:00:00.100000002Z"},
		{"sl_d", "2026-01-01T00:00:00.100000001Z"},
		{"sl_f", "2026-01-01T00:00:00.100Z"},
		{"sl_e", "2026-01-01T00:00:00.1Z"},
		{"sl_g", "2026-01-01T00:00:00.000000001Z"},
		{"sl_i", "2026-01-01T00:00:00Z"},
		{"sl_h", "2026-01-01T00:00:00.000Z"},
	}
	for _, record := range records {
		if _, err := f.db.ExecContext(ctx, `INSERT INTO share_links
(id, resource_type, resource_id, token_hash, created_at, updated_at)
VALUES (?, 'folder', ?, ?, ?, ?)`, record.id, f.folderID, hashToken(record.id), record.created, record.created); err != nil {
			t.Fatal(err)
		}
	}
	for _, limit := range []int{1, 2, 3, 100} {
		cursor := ""
		var ids []string
		for {
			page, err := service.ListManaged(ctx, principal, ManageFilter{Limit: limit, Cursor: cursor})
			if err != nil {
				t.Fatal(err)
			}
			if len(page.Items) == 0 || len(page.Items) > limit {
				t.Fatalf("limit %d: invalid page %+v", limit, page)
			}
			for _, item := range page.Items {
				ids = append(ids, item.ID)
			}
			if len(ids) > len(records) {
				t.Fatalf("limit %d: duplicate results %v", limit, ids)
			}
			if page.NextCursor == "" {
				break
			}
			cursor = page.NextCursor
		}
		if len(ids) != len(records) {
			t.Fatalf("limit %d: got %v, want %d results", limit, ids, len(records))
		}
		for i, record := range records {
			if ids[i] != record.id {
				t.Fatalf("limit %d: position %d = %s, want %s (results %v)", limit, i, ids[i], record.id, ids)
			}
		}
	}
}

func TestManagedRevokeCoversPermanentTimedAndProtectedLinks(t *testing.T) {
	f := shareLinkFixture(t)
	service := NewService(f.db, f.store, nil, false)
	principal := acl.Principal{UserID: f.owner.ID, Role: acl.RoleAdmin}
	for _, tc := range []struct {
		duration Duration
		password string
	}{
		{DurationForever, ""}, {DurationOneDay, ""}, {DurationSevenDays, "secure password"},
	} {
		link, err := service.Create(context.Background(), principal, CreateInput{ResourceType: ResourcePhoto, ResourceID: f.photoID, Duration: tc.duration, Password: tc.password})
		if err != nil {
			t.Fatal(err)
		}
		if err := service.RevokeManaged(context.Background(), principal, link.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := service.Inspect(context.Background(), link.Token); err != ErrUnavailable {
			t.Fatalf("%s link still public: %v", tc.duration, err)
		}
	}
}

func TestRevokeSurvivesDatabaseRestart(t *testing.T) {
	f := shareLinkFixture(t)
	ctx := context.Background()
	principal := acl.Principal{UserID: f.owner.ID, Role: acl.RoleAdmin}
	service := NewService(f.db, f.store, nil, false)
	link, err := service.Create(ctx, principal, CreateInput{ResourceType: ResourcePhoto, ResourceID: f.photoID, Duration: DurationForever})
	if err != nil {
		t.Fatal(err)
	}
	if err := service.RevokeManaged(ctx, principal, link.ID); err != nil {
		t.Fatal(err)
	}
	var revoked string
	if err := f.db.QueryRowContext(ctx, "SELECT revoked_at FROM share_links WHERE id=?", link.ID).Scan(&revoked); err != nil {
		t.Fatal(err)
	}
	var seq int
	var name, path string
	if err := f.db.QueryRowContext(ctx, "PRAGMA database_list").Scan(&seq, &name, &path); err != nil {
		t.Fatal(err)
	}
	if err := f.db.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := dbstore.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	service = NewService(reopened, f.store, nil, false)
	page, err := service.ListManaged(ctx, principal, ManageFilter{})
	if err != nil || len(page.Items) != 1 || page.Items[0].Status != "revoked" {
		t.Fatalf("restarted page = %+v, %v", page, err)
	}
	if _, err := service.Inspect(ctx, link.Token); err != ErrUnavailable {
		t.Fatalf("restarted public access = %v", err)
	}
	if err := service.RevokeManaged(ctx, principal, link.ID); err != nil {
		t.Fatal(err)
	}
	var after string
	if err := reopened.QueryRowContext(ctx, "SELECT revoked_at FROM share_links WHERE id=?", link.ID).Scan(&after); err != nil || after != revoked {
		t.Fatalf("revoked timestamp after restart = %q, want %q, %v", after, revoked, err)
	}
}

func TestRevokeClearsUnlockAndRejectsFreshMediaRequests(t *testing.T) {
	f := shareLinkHTTPFixture(t)
	service := NewService(f.db, f.store, nil, false)
	link := createHTTPShareLink(t, f, ResourcePhoto, f.photo.ID, DurationForever, "password 12345")
	access, _, err := service.Unlock(context.Background(), link.Token, "password 12345")
	if err != nil {
		t.Fatal(err)
	}
	preview := func() int {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/share-links/"+link.Token+"/photos/"+f.photo.ID+"/preview", nil)
		req.AddCookie(&http.Cookie{Name: shareAccessCookie, Value: access})
		out := httptest.NewRecorder()
		f.handler.ServeHTTP(out, req)
		return out.Code
	}
	if preview() == http.StatusNotFound {
		t.Fatal("preview unavailable before revocation")
	}
	if err := service.RevokeManaged(context.Background(), acl.Principal{UserID: f.owner.ID, Role: acl.RoleAdmin}, link.ID); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := f.db.QueryRow(`SELECT count(*) FROM share_link_access WHERE share_link_id=?`, link.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("unlock sessions = %d, %v", count, err)
	}
	for _, suffix := range []string{"", "/photos", "/photos/" + f.photo.ID + "/preview"} {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/share-links/"+link.Token+suffix, nil)
		req.AddCookie(&http.Cookie{Name: shareAccessCookie, Value: access})
		out := httptest.NewRecorder()
		f.handler.ServeHTTP(out, req)
		if out.Code != http.StatusNotFound {
			t.Fatalf("%s after revoke = %d", suffix, out.Code)
		}
	}
	if preview() != http.StatusNotFound {
		t.Fatal("old cookie still accesses preview")
	}
}

func TestMissingResourceIsAdminOnlyAndRetainsDisplaySnapshot(t *testing.T) {
	f := shareLinkFixture(t)
	ctx := context.Background()
	service := NewService(f.db, f.store, nil, false)
	owner := acl.Principal{UserID: f.owner.ID, Role: acl.RoleUser}
	admin := acl.Principal{UserID: f.owner.ID, Role: acl.RoleAdmin}
	if _, err := f.db.ExecContext(ctx, `INSERT INTO folders(id,owner_id,name,storage_path,created_at,updated_at)
VALUES('f_orphan',?,'Old album','users/u_owner/Old album','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, f.owner.ID); err != nil {
		t.Fatal(err)
	}
	link, err := service.Create(ctx, owner, CreateInput{ResourceType: ResourceFolder, ResourceID: "f_orphan", Duration: DurationForever})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.ExecContext(ctx, "DELETE FROM folders WHERE id='f_orphan'"); err != nil {
		t.Fatal(err)
	}
	for _, principal := range []acl.Principal{owner, admin} {
		page, err := service.ListManaged(ctx, principal, ManageFilter{})
		if err != nil {
			t.Fatal(err)
		}
		if principal.Role == acl.RoleUser && len(page.Items) != 0 {
			t.Fatalf("former owner sees orphan: %+v", page)
		}
		if principal.Role == acl.RoleAdmin && (len(page.Items) != 1 || page.Items[0].ResourceName != "Old album" || page.Items[0].Status != "unavailable") {
			t.Fatalf("admin orphan = %+v", page)
		}
	}
	if err := service.RevokeManaged(ctx, owner, link.ID); err != ErrNotFound {
		t.Fatalf("former owner revoke = %v", err)
	}
	if err := service.RevokeManaged(ctx, admin, link.ID); err != nil {
		t.Fatal(err)
	}
}

func TestFolderDeletionKeepsLatestShareNameForAdmin(t *testing.T) {
	f := shareLinkHTTPFixture(t)
	ctx := context.Background()
	principal := acl.Principal{UserID: f.owner.ID, Role: acl.RoleAdmin}
	folderService := folders.NewService(f.db, f.store)
	empty, err := folderService.Create(ctx, principal, folders.CreateInput{Name: "Old name"})
	if err != nil {
		t.Fatal(err)
	}
	link, err := NewService(f.db, f.store, nil, false).Create(ctx, principal, CreateInput{ResourceType: ResourceFolder, ResourceID: empty.ID, Duration: DurationForever})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := folderService.Rename(ctx, principal, empty.ID, folders.RenameInput{Name: "New name"}); err != nil {
		t.Fatal(err)
	}
	if err := folderService.Delete(ctx, principal, empty.ID); err != nil {
		t.Fatal(err)
	}
	page, err := NewService(f.db, f.store, nil, false).ListManaged(ctx, principal, ManageFilter{ResourceType: ResourceFolder, ResourceID: empty.ID})
	if err != nil || len(page.Items) != 1 || page.Items[0].ID != link.ID || page.Items[0].ResourceName != "New name" || page.Items[0].Status != "unavailable" {
		t.Fatalf("deleted folder share = %+v, %v", page, err)
	}
}

func TestManageHTTPRequiresAuthenticationAndCSRF(t *testing.T) {
	f := shareLinkHTTPFixture(t)
	link := createHTTPShareLink(t, f, ResourceFolder, f.folder.ID, DurationForever, "")
	request := func(method, path, csrf string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, nil)
		req.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: f.session.Token})
		if csrf != "" {
			req.Header.Set(auth.CSRFHeaderName(), csrf)
		}
		out := httptest.NewRecorder()
		f.handler.ServeHTTP(out, req)
		return out
	}
	if out := request(http.MethodGet, "/api/v1/me/share-links", ""); out.Code != http.StatusOK {
		t.Fatalf("list = %d %s", out.Code, out.Body.String())
	}
	if out := request(http.MethodDelete, "/api/v1/me/share-links/"+link.ID, ""); out.Code != http.StatusForbidden {
		t.Fatalf("without CSRF = %d", out.Code)
	}
	if out := request(http.MethodDelete, "/api/v1/me/share-links/"+link.ID, f.session.CSRFToken); out.Code != http.StatusNoContent {
		t.Fatalf("revoke = %d %s", out.Code, out.Body.String())
	}
	if out := request(http.MethodDelete, "/api/v1/me/share-links/"+link.ID, f.session.CSRFToken); out.Code != http.StatusNoContent {
		t.Fatalf("repeat revoke = %d", out.Code)
	}
	bearerLink := createHTTPShareLink(t, f, ResourceFolder, f.folder.ID, DurationForever, "")
	bearer := createShareLinkBearer(t, f)
	bearerList := httptest.NewRequest(http.MethodGet, "/api/v1/me/share-links", nil)
	bearerList.Header.Set("Authorization", "Bearer "+bearer)
	bearerListResponse := httptest.NewRecorder()
	f.handler.ServeHTTP(bearerListResponse, bearerList)
	if bearerListResponse.Code != http.StatusOK {
		t.Fatalf("bearer list = %d %s", bearerListResponse.Code, bearerListResponse.Body.String())
	}
	bearerRequest := httptest.NewRequest(http.MethodDelete, "/api/v1/me/share-links/"+bearerLink.ID, nil)
	bearerRequest.Header.Set("Authorization", "Bearer "+bearer)
	bearerResponse := httptest.NewRecorder()
	f.handler.ServeHTTP(bearerResponse, bearerRequest)
	if bearerResponse.Code != http.StatusNoContent {
		t.Fatalf("bearer revoke = %d %s", bearerResponse.Code, bearerResponse.Body.String())
	}
}

func TestRevokedVideoRangeRequestIsRejected(t *testing.T) {
	f := shareLinkHTTPFixture(t)
	link := createHTTPShareLink(t, f, ResourcePhoto, f.photo.ID, DurationForever, "")
	if _, err := f.db.Exec(`UPDATE photos SET mime_type='video/mp4' WHERE id=?`, f.photo.ID); err != nil {
		t.Fatal(err)
	}
	rangeRequest := func() int {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/share-links/"+link.Token+"/photos/"+f.photo.ID+"/preview", nil)
		req.Header.Set("Range", "bytes=0-2")
		out := httptest.NewRecorder()
		f.handler.ServeHTTP(out, req)
		return out.Code
	}
	if got := rangeRequest(); got != http.StatusPartialContent {
		t.Fatalf("range before revoke = %d", got)
	}
	if err := NewService(f.db, f.store, nil, false).RevokeManaged(context.Background(), acl.Principal{UserID: f.owner.ID, Role: acl.RoleAdmin}, link.ID); err != nil {
		t.Fatal(err)
	}
	if got := rangeRequest(); got != http.StatusNotFound {
		t.Fatalf("range after revoke = %d", got)
	}
}

func TestDisabledOwnerCannotUseManagementSession(t *testing.T) {
	f := shareLinkHTTPFixture(t)
	link := createHTTPShareLink(t, f, ResourceFolder, f.folder.ID, DurationForever, "")
	if _, err := f.db.Exec(`UPDATE users SET is_active=0 WHERE id=?`, f.owner.ID); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{http.MethodGet, http.MethodDelete} {
		path := "/api/v1/me/share-links"
		if method == http.MethodDelete {
			path += "/" + link.ID
		}
		req := httptest.NewRequest(method, path, nil)
		req.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: f.session.Token})
		req.Header.Set(auth.CSRFHeaderName(), f.session.CSRFToken)
		out := httptest.NewRecorder()
		f.handler.ServeHTTP(out, req)
		if out.Code != http.StatusUnauthorized {
			t.Fatalf("disabled management %s = %d", method, out.Code)
		}
	}
	public := httptest.NewRecorder()
	f.handler.ServeHTTP(public, httptest.NewRequest(http.MethodGet, "/api/v1/share-links/"+link.Token, nil))
	if public.Code != http.StatusOK {
		t.Fatalf("existing public link after owner disable = %d", public.Code)
	}
}

func TestFolderMoveKeepsManagedAndPublicLink(t *testing.T) {
	f := shareLinkHTTPFixture(t)
	ctx := context.Background()
	principal := acl.Principal{UserID: f.owner.ID, Role: acl.RoleAdmin}
	service := NewService(f.db, f.store, nil, false)
	link, err := service.Create(ctx, principal, CreateInput{ResourceType: ResourceFolder, ResourceID: f.folder.ID, Duration: DurationForever})
	if err != nil {
		t.Fatal(err)
	}
	folderService := folders.NewService(f.db, f.store)
	target, err := folderService.Create(ctx, principal, folders.CreateInput{Name: "Destination"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := folderService.Move(ctx, principal, f.folder.ID, target.ID); err != nil {
		t.Fatal(err)
	}
	page, err := service.ListManaged(ctx, principal, ManageFilter{ResourceType: ResourceFolder, ResourceID: f.folder.ID})
	if err != nil || len(page.Items) != 1 || page.Items[0].ID != link.ID || page.Items[0].Status != "active" {
		t.Fatalf("moved folder management = %+v, %v", page, err)
	}
	photos, err := service.ListPhotos(ctx, link.Token, "")
	if err != nil || len(photos) != 1 || photos[0].ID != f.photo.ID {
		t.Fatalf("moved folder public photos = %+v, %v", photos, err)
	}
}
