package photos

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
	"github.com/zxxx98/77Photo/internal/folders"
)

func TestFavoritesArePersonalVisibleAndSurviveTrash(t *testing.T) {
	f := newUploadFixture(t, 1<<20)
	ctx := context.Background()
	photo, err := f.service.Upload(ctx, f.principal, UploadInput{FolderID: f.folderID, Filename: "family.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(jpegBytes(t, 3, 3))})
	if err != nil {
		t.Fatal(err)
	}
	for _, user := range []string{"alice", "bob"} {
		if _, err := f.service.db.ExecContext(ctx, `INSERT INTO users(id,username,password_hash,role,is_active,created_at,updated_at) VALUES(?,?, 'hash','user',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, user, user); err != nil {
			t.Fatal(err)
		}
	}
	alice := acl.Principal{UserID: "alice", Role: acl.RoleUser}
	bob := acl.Principal{UserID: "bob", Role: acl.RoleUser}
	f.service.SetAuthorizer(acl.NewAuthorizer(f.service.db))
	if err := f.service.SetFavorite(ctx, alice, photo.ID, true); !errors.Is(err, ErrForbidden) {
		t.Fatalf("unshared favorite: %v", err)
	}
	if _, err := f.service.db.ExecContext(ctx, `INSERT INTO shares(id,resource_type,resource_id,user_id,permission,created_at) VALUES('share-a','folder',?,'alice','read','2026-01-01T00:00:00Z'),('share-b','folder',?,'bob','read','2026-01-01T00:00:00Z')`, f.folderID, f.folderID); err != nil {
		t.Fatal(err)
	}
	for _, principal := range []acl.Principal{alice, bob} {
		for i := 0; i < 2; i++ {
			if err := f.service.SetFavorite(ctx, principal, photo.ID, true); err != nil {
				t.Fatal(err)
			}
		}
		page, err := f.service.List(ctx, principal, ListFilter{Favorite: true})
		if err != nil || len(page.Items) != 1 || !page.Items[0].IsFavorite {
			t.Fatalf("favorite list for %s: %+v, %v", principal.UserID, page, err)
		}
	}
	var count int
	if err := f.service.db.QueryRowContext(ctx, "SELECT count(*) FROM photo_favorites WHERE photo_id=?", photo.ID).Scan(&count); err != nil || count != 2 {
		t.Fatalf("favorite rows=%d err=%v", count, err)
	}
	if err := f.service.SetFavorite(ctx, alice, photo.ID, false); err != nil {
		t.Fatal(err)
	}
	if err := f.service.SetFavorite(ctx, alice, photo.ID, false); err != nil {
		t.Fatal(err)
	}
	page, err := f.service.List(ctx, bob, ListFilter{Favorite: true})
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("bob unaffected: %+v %v", page, err)
	}
	if _, err := f.service.db.ExecContext(ctx, "DELETE FROM shares WHERE id='share-b'"); err != nil {
		t.Fatal(err)
	}
	page, err = f.service.List(ctx, bob, ListFilter{Favorite: true})
	if err != nil || len(page.Items) != 0 {
		t.Fatalf("revoked favorite: %+v %v", page, err)
	}
	if _, err := f.service.Get(ctx, bob, photo.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("revoked detail: %v", err)
	}
	if _, err := f.service.db.ExecContext(ctx, `INSERT INTO shares(id,resource_type,resource_id,user_id,permission,created_at) VALUES('share-b','folder',?,'bob','read','2026-01-01T00:00:00Z')`, f.folderID); err != nil {
		t.Fatal(err)
	}
	renamed, err := f.service.Rename(ctx, f.principal, photo.ID, RenameInput{Name: "family-renamed.jpg"})
	if err != nil || renamed.ID != photo.ID {
		t.Fatalf("rename lost photo identity: %+v, %v", renamed, err)
	}
	subfolder, err := folders.NewService(f.service.db, f.store).Create(ctx, f.principal, folders.CreateInput{Name: "nested", ParentID: &f.folderID})
	if err != nil {
		t.Fatal(err)
	}
	moved, err := f.service.Move(ctx, f.principal, photo.ID, subfolder.ID)
	if err != nil || moved.ID != photo.ID {
		t.Fatalf("move lost photo identity: %+v, %v", moved, err)
	}
	if _, err := f.service.IndexScannedFile(ctx, photo.OwnerID, subfolder.ID, moved.StoragePath); err != nil {
		t.Fatal(err)
	}
	page, err = f.service.List(ctx, bob, ListFilter{Favorite: true})
	if err != nil || len(page.Items) != 1 || page.Items[0].ID != photo.ID {
		t.Fatalf("rename and scan favorite: %+v %v", page, err)
	}
	if err := f.service.Delete(ctx, f.principal, photo.ID, true); err != nil {
		t.Fatal(err)
	}
	page, err = f.service.List(ctx, bob, ListFilter{Favorite: true})
	if err != nil || len(page.Items) != 0 {
		t.Fatalf("trashed favorite: %+v %v", page, err)
	}
	if _, err := f.service.RestoreTrash(ctx, f.principal, photo.ID, RestoreInput{}); err != nil {
		t.Fatal(err)
	}
	page, err = f.service.List(ctx, bob, ListFilter{Favorite: true})
	if err != nil || len(page.Items) != 1 || page.Items[0].ID != photo.ID {
		t.Fatalf("restored favorite: %+v %v", page, err)
	}
	if err := f.service.Delete(ctx, f.principal, photo.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := f.service.PurgeTrash(ctx, f.principal, photo.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := f.service.db.QueryRowContext(ctx, "SELECT count(*) FROM photo_favorites WHERE photo_id=?", photo.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("purged rows=%d err=%v", count, err)
	}
}

func TestFavoriteHTTPUsesBearerAndRejectsInvalidFilter(t *testing.T) {
	f := newUploadFixture(t, 1<<20)
	ctx := context.Background()
	photo, err := f.service.Upload(ctx, f.principal, UploadInput{FolderID: f.folderID, Filename: "favorite.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(jpegBytes(t, 3, 3))})
	if err != nil {
		t.Fatal(err)
	}
	authService := auth.NewService(f.service.db, time.Hour, false)
	mobile, err := authService.CreateMobileSession(ctx, f.principal.UserID, auth.MobileDeviceInput{Name: "Pixel", Platform: "android", AppVersion: "1"})
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHTTPHandler(f.service, authService)
	call := func(method, path, token string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		return res
	}
	path := "/api/v1/photos/" + photo.ID + "/favorite"
	if res := call(http.MethodPut, path, ""); res.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous put: %d", res.Code)
	}
	for i := 0; i < 2; i++ {
		if res := call(http.MethodPut, path, mobile.AccessToken); res.Code != http.StatusOK {
			t.Fatalf("put: %d %s", res.Code, res.Body.String())
		}
	}
	res := call(http.MethodGet, "/api/v1/photos?favorite=true", mobile.AccessToken)
	if res.Code != http.StatusOK {
		t.Fatalf("list: %d %s", res.Code, res.Body.String())
	}
	var page PhotoPage
	if err := json.NewDecoder(res.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || !page.Items[0].IsFavorite || !page.FavoritesSupported {
		t.Fatalf("favorite HTTP page: %+v", page)
	}
	if res := call(http.MethodGet, "/api/v1/photos?favorite=false", mobile.AccessToken); res.Code != http.StatusBadRequest {
		t.Fatalf("invalid filter: %d", res.Code)
	}
	for i := 0; i < 2; i++ {
		if res := call(http.MethodDelete, path, mobile.AccessToken); res.Code != http.StatusOK {
			t.Fatalf("delete: %d %s", res.Code, res.Body.String())
		}
	}
}

func TestFavoriteCursorBindsFilterAndCombinesSearch(t *testing.T) {
	f := newUploadFixture(t, 1<<20)
	ctx := context.Background()
	for i, name := range []string{"family-one.jpg", "family-two.jpg", "other.jpg"} {
		photo, err := f.service.Upload(ctx, f.principal, UploadInput{FolderID: f.folderID, Filename: name, DeclaredMIME: "image/jpeg", Body: bytes.NewReader(jpegBytes(t, 3+i, 3))})
		if err != nil {
			t.Fatal(err)
		}
		if err := f.service.SetFavorite(ctx, f.principal, photo.ID, true); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.service.db.ExecContext(ctx, "UPDATE photos SET captured_at='2026-09-15T12:00:00Z'"); err != nil {
		t.Fatal(err)
	}
	from, _ := time.Parse(time.RFC3339, "2026-09-15T00:00:00Z")
	to, _ := time.Parse(time.RFC3339, "2026-09-16T00:00:00Z")
	filter := ListFilter{Favorite: true, FolderID: &f.folderID, Query: "family", MediaType: "photo", From: &from, To: &to, Limit: 1}
	first, err := f.service.List(ctx, f.principal, filter)
	if err != nil || len(first.Items) != 1 || first.NextCursor == nil {
		t.Fatalf("first=%+v err=%v", first, err)
	}
	if _, err := f.service.List(ctx, f.principal, ListFilter{Query: "family", Cursor: *first.NextCursor, Limit: 1}); !errors.Is(err, ErrInvalidCursor) {
		t.Fatalf("cursor filter mismatch: %v", err)
	}
	filter.Cursor = *first.NextCursor
	second, err := f.service.List(ctx, f.principal, filter)
	if err != nil || len(second.Items) != 1 || second.Items[0].ID == first.Items[0].ID || second.NextCursor != nil {
		t.Fatalf("second=%+v err=%v", second, err)
	}
}
