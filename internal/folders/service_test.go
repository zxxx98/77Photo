package folders

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
	dbstore "github.com/zxxx98/77Photo/internal/database"
	"github.com/zxxx98/77Photo/internal/storage"
)

func newFolderService(t *testing.T) (*Service, acl.Principal, acl.Principal) {
	t.Helper()
	ctx := context.Background()
	db, err := dbstore.Open(ctx, filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	authService := auth.NewService(db, 1, false)
	admin, _, err := authService.SetupAdmin(ctx, "admin", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	other, err := createAccountForFolderTest(ctx, db, "bob")
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	return NewService(db, store), acl.Principal{UserID: admin.ID, Role: acl.RoleAdmin}, acl.Principal{UserID: other.ID, Role: acl.RoleUser}
}

func createAccountForFolderTest(ctx context.Context, db interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}, username string) (auth.Account, error) {
	hash, err := auth.HashPassword("bob's secure password")
	if err != nil {
		return auth.Account{}, err
	}
	const id = "u_bob"
	_, err = db.ExecContext(ctx, `INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at)
VALUES (?, ?, ?, 'user', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, id, username, hash)
	return auth.Account{ID: id, Username: username, Role: acl.RoleUser, IsActive: true}, err
}

func TestOwnerCanCreateListAndReadFolders(t *testing.T) {
	service, admin, _ := newFolderService(t)
	ctx := context.Background()
	created, err := service.Create(ctx, admin, CreateInput{Name: "2026", ParentID: nil})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if created.Name != "2026" || created.OwnerID != admin.UserID || created.StoragePath == "" {
		t.Fatalf("created = %+v", created)
	}
	items, err := service.List(ctx, admin, nil)
	if err != nil || len(items) != 1 {
		t.Fatalf("List() = (%d, %v), want one folder", len(items), err)
	}
	got, err := service.Get(ctx, admin, created.ID)
	if err != nil || got.ID != created.ID {
		t.Fatalf("Get() = (%+v, %v)", got, err)
	}
}

func TestOtherUserCannotReadOrCreateInPrivateTree(t *testing.T) {
	service, admin, other := newFolderService(t)
	created, err := service.Create(context.Background(), admin, CreateInput{Name: "private", ParentID: nil})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Get(context.Background(), other, created.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("Get(other) error = %v, want ErrForbidden", err)
	}
	parentID := created.ID
	if _, err := service.Create(context.Background(), other, CreateInput{Name: "nope", ParentID: &parentID}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("Create(other) error = %v, want ErrForbidden", err)
	}
}

func TestUnsafeFolderNameIsRejected(t *testing.T) {
	service, admin, _ := newFolderService(t)
	if _, err := service.Create(context.Background(), admin, CreateInput{Name: "../escape", ParentID: nil}); !errors.Is(err, ErrInvalidName) {
		t.Fatalf("Create(unsafe) error = %v, want ErrInvalidName", err)
	}
}
