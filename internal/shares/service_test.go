package shares

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"image"
	"image/jpeg"
	"path/filepath"
	"testing"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
	dbstore "github.com/zxxx98/77Photo/internal/database"
	"github.com/zxxx98/77Photo/internal/folders"
	"github.com/zxxx98/77Photo/internal/photos"
	"github.com/zxxx98/77Photo/internal/storage"
)

func TestSharePermissionIsInheritedByDescendants(t *testing.T) {
	ctx := context.Background()
	db, err := dbstore.Open(ctx, filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authService := auth.NewService(db, 1, false)
	owner, _, err := authService.SetupAdmin(ctx, "owner", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	member, err := createShareUser(ctx, db, "member", "u_member")
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	folderService := folders.NewService(db, store)
	root, err := folderService.Create(ctx, acl.Principal{UserID: owner.ID, Role: acl.RoleAdmin}, folders.CreateInput{Name: "shared"})
	if err != nil {
		t.Fatal(err)
	}
	childID := root.ID
	child, err := folderService.Create(ctx, acl.Principal{UserID: owner.ID, Role: acl.RoleAdmin}, folders.CreateInput{Name: "child", ParentID: &childID})
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(db)
	created, err := service.Create(ctx, acl.Principal{UserID: owner.ID, Role: acl.RoleAdmin}, CreateInput{FolderID: root.ID, UserID: member.ID, Permission: acl.PermissionRead})
	if err != nil || created.UserID != member.ID {
		t.Fatalf("Create() = (%+v, %v)", created, err)
	}
	authorizer := acl.NewAuthorizer(db)
	permission, err := authorizer.Permission(ctx, acl.Principal{UserID: member.ID, Role: acl.RoleUser}, child.ID)
	if err != nil || permission != acl.PermissionRead {
		t.Fatalf("inherited permission = (%q, %v), want read", permission, err)
	}
	if _, err := service.Create(ctx, acl.Principal{UserID: member.ID, Role: acl.RoleUser}, CreateInput{FolderID: root.ID, UserID: member.ID, Permission: acl.PermissionWrite}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member Create() error = %v, want ErrForbidden", err)
	}
}

func TestReadShareAllowsPhotoReadButNotWrite(t *testing.T) {
	ctx := context.Background()
	db, err := dbstore.Open(ctx, filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authService := auth.NewService(db, 1, false)
	owner, _, err := authService.SetupAdmin(ctx, "owner", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	member, err := createShareUser(ctx, db, "member", "u_member")
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	authorizer := acl.NewAuthorizer(db)
	folderService := folders.NewService(db, store)
	folderService.SetAuthorizer(authorizer)
	root, err := folderService.Create(ctx, acl.Principal{UserID: owner.ID, Role: acl.RoleAdmin}, folders.CreateInput{Name: "shared"})
	if err != nil {
		t.Fatal(err)
	}
	photoService := photos.NewService(db, store, 1<<20)
	photoService.SetAuthorizer(authorizer)
	photo, err := photoService.Upload(ctx, acl.Principal{UserID: owner.ID, Role: acl.RoleAdmin}, photos.UploadInput{FolderID: root.ID, Filename: "photo.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(testJPEG())})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewService(db).Create(ctx, acl.Principal{UserID: owner.ID, Role: acl.RoleAdmin}, CreateInput{FolderID: root.ID, UserID: member.ID, Permission: acl.PermissionRead}); err != nil {
		t.Fatal(err)
	}
	memberPrincipal := acl.Principal{UserID: member.ID, Role: acl.RoleUser}
	if _, err := photoService.Get(ctx, memberPrincipal, photo.ID); err != nil {
		t.Fatalf("shared Get() error = %v", err)
	}
	if _, err := photoService.Rename(ctx, memberPrincipal, photo.ID, photos.RenameInput{Name: "renamed.jpg"}); !errors.Is(err, photos.ErrForbidden) {
		t.Fatalf("shared Rename() error = %v, want forbidden", err)
	}
}

func testJPEG() []byte {
	var body bytes.Buffer
	_ = jpeg.Encode(&body, image.NewRGBA(image.Rect(0, 0, 1, 1)), nil)
	return body.Bytes()
}

func createShareUser(ctx context.Context, db interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}, username, id string) (auth.Account, error) {
	hash, err := auth.HashPassword("member secure password")
	if err != nil {
		return auth.Account{}, err
	}
	_, err = db.ExecContext(ctx, `INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, 'user', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, id, username, hash)
	return auth.Account{ID: id, Username: username, Role: acl.RoleUser, IsActive: true}, err
}
