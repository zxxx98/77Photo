package photos

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
	dbstore "github.com/zxxx98/77Photo/internal/database"
	"github.com/zxxx98/77Photo/internal/folders"
	"github.com/zxxx98/77Photo/internal/shares"
	"github.com/zxxx98/77Photo/internal/storage"
)

func TestListPhotosUsesStableCursorWithoutDuplicates(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	ctx := context.Background()
	for index, name := range []string{"one.jpg", "two.jpg", "three.jpg"} {
		if _, err := fixture.service.Upload(ctx, fixture.principal, UploadInput{FolderID: fixture.folderID, Filename: name, DeclaredMIME: "image/jpeg", Body: bytes.NewReader(jpegBytes(t, 2+index, 2)), Conflict: ConflictRename}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := fixture.service.db.Exec("UPDATE photos SET captured_at=?", "2026-09-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	first, err := fixture.service.List(ctx, fixture.principal, ListFilter{FolderID: &fixture.folderID, Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Items) != 2 || first.NextCursor == nil {
		t.Fatalf("first page = (%d, %v), want two items and cursor", len(first.Items), first.NextCursor)
	}
	second, err := fixture.service.List(ctx, fixture.principal, ListFilter{FolderID: &fixture.folderID, Limit: 2, Cursor: *first.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Items) != 1 || second.Items[0].ID == first.Items[0].ID || second.Items[0].ID == first.Items[1].ID {
		t.Fatalf("second page = %+v, contains duplicate or wrong count", second.Items)
	}
	if second.NextCursor != nil {
		t.Fatalf("final cursor = %v, want null", second.NextCursor)
	}
}

func TestListPhotosRejectsTamperedCursor(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	if _, err := fixture.service.List(context.Background(), fixture.principal, ListFilter{Cursor: "this-is-not-a-valid-signed-cursor"}); !errors.Is(err, ErrInvalidCursor) {
		t.Fatalf("List(tampered cursor) error = %v, want ErrInvalidCursor", err)
	}
}

func TestListPhotosRejectsCursorBoundToDifferentFilter(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	ctx := context.Background()
	for index, name := range []string{"one.jpg", "two.jpg"} {
		if _, err := fixture.service.Upload(ctx, fixture.principal, UploadInput{FolderID: fixture.folderID, Filename: name, DeclaredMIME: "image/jpeg", Body: bytes.NewReader(jpegBytes(t, 2+index, 2))}); err != nil {
			t.Fatal(err)
		}
	}
	first, err := fixture.service.List(ctx, fixture.principal, ListFilter{FolderID: &fixture.folderID, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if first.NextCursor == nil {
		t.Fatal("first page cursor = nil, want cursor")
	}
	if _, err := fixture.service.List(ctx, fixture.principal, ListFilter{Limit: 1, Cursor: *first.NextCursor}); !errors.Is(err, ErrInvalidCursor) {
		t.Fatalf("List(different filter) error = %v, want ErrInvalidCursor", err)
	}
}

func TestListPhotosCursorDoesNotSkipSparseSharedResults(t *testing.T) {
	ctx := context.Background()
	db, err := dbstore.Open(ctx, filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authService := auth.NewService(db, time.Hour, false)
	owner, _, err := authService.SetupAdmin(ctx, "owner", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	memberHash, err := auth.HashPassword("member secure password")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at)
VALUES ('member', 'member', ?, 'user', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, memberHash); err != nil {
		t.Fatal(err)
	}
	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	authorizer := acl.NewAuthorizer(db)
	folderService := folders.NewService(db, store)
	folderService.SetAuthorizer(authorizer)
	privateFolder, err := folderService.Create(ctx, acl.Principal{UserID: owner.ID, Role: acl.RoleAdmin}, folders.CreateInput{Name: "private"})
	if err != nil {
		t.Fatal(err)
	}
	sharedFolder, err := folderService.Create(ctx, acl.Principal{UserID: owner.ID, Role: acl.RoleAdmin}, folders.CreateInput{Name: "shared"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := shares.NewService(db).Create(ctx, acl.Principal{UserID: owner.ID, Role: acl.RoleAdmin}, shares.CreateInput{FolderID: sharedFolder.ID, UserID: "member", Permission: acl.PermissionRead}); err != nil {
		t.Fatal(err)
	}
	photoService := NewService(db, store, 1<<20)
	photoService.SetAuthorizer(authorizer)
	for i := 0; i < 5; i++ {
		if _, err := photoService.Upload(ctx, acl.Principal{UserID: owner.ID, Role: acl.RoleAdmin}, UploadInput{FolderID: privateFolder.ID, Filename: "private-" + string(rune('a'+i)) + ".jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(jpegBytes(t, 2, 2+i))}); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 3; i++ {
		if _, err := photoService.Upload(ctx, acl.Principal{UserID: owner.ID, Role: acl.RoleAdmin}, UploadInput{FolderID: sharedFolder.ID, Filename: "shared-" + string(rune('a'+i)) + ".jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(jpegBytes(t, 2, 2+i))}); err != nil {
			t.Fatal(err)
		}
	}
	// Put inaccessible rows first in the sort order. The SQL visibility
	// predicate must still return all three shared rows over two pages.
	if _, err := db.ExecContext(ctx, "UPDATE photos SET captured_at=CASE WHEN folder_id=? THEN '2026-09-02T00:00:00Z' ELSE '2026-09-01T00:00:00Z' END", privateFolder.ID); err != nil {
		t.Fatal(err)
	}
	member := acl.Principal{UserID: "member", Role: acl.RoleUser}
	first, err := photoService.List(ctx, member, ListFilter{Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Items) != 2 || first.NextCursor == nil {
		t.Fatalf("first shared page = %d items, cursor=%v; want 2 items and cursor", len(first.Items), first.NextCursor)
	}
	second, err := photoService.List(ctx, member, ListFilter{Limit: 2, Cursor: *first.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Items) != 1 || second.NextCursor != nil {
		t.Fatalf("second shared page = %+v, cursor=%v; want final shared item", second.Items, second.NextCursor)
	}
}
