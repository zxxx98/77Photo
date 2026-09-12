package users

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
	dbstore "github.com/zxxx98/77Photo/internal/database"
)

func newUserService(t *testing.T) (*Service, *auth.Service, acl.Principal) {
	t.Helper()
	db, err := dbstore.Open(context.Background(), filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	authService := auth.NewService(db, time.Hour, false)
	admin, _, err := authService.SetupAdmin(context.Background(), "admin", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	return NewService(db, authService), authService, acl.Principal{UserID: admin.ID, Role: acl.RoleAdmin}
}

func TestAdminCanCreateListUpdateAndDisableUser(t *testing.T) {
	service, _, admin := newUserService(t)
	ctx := context.Background()
	created, err := service.Create(ctx, admin, CreateInput{Username: "alice", Password: "alice's secure password", Role: acl.RoleUser})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if created.Username != "alice" || created.Role != acl.RoleUser || !created.IsActive {
		t.Fatalf("created = %+v", created)
	}
	users, err := service.List(ctx, admin)
	if err != nil || len(users) != 2 {
		t.Fatalf("List() = (%d, %v), want two users", len(users), err)
	}
	updated, err := service.Update(ctx, admin, created.ID, UpdateInput{Username: stringPtr("alice-renamed"), IsActive: boolPtr(false)})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if updated.Username != "alice-renamed" || updated.IsActive {
		t.Fatalf("updated = %+v", updated)
	}
}

func TestNonAdminCannotManageUsers(t *testing.T) {
	service, _, admin := newUserService(t)
	ctx := context.Background()
	alice, err := service.Create(ctx, admin, CreateInput{Username: "alice", Password: "alice's secure password", Role: acl.RoleUser})
	if err != nil {
		t.Fatal(err)
	}
	ordinary := acl.Principal{UserID: alice.ID, Role: acl.RoleUser}
	if _, err := service.List(ctx, ordinary); !errors.Is(err, ErrAdminRequired) {
		t.Fatalf("List(non-admin) error = %v, want ErrAdminRequired", err)
	}
	if _, err := service.Create(ctx, ordinary, CreateInput{Username: "bob", Password: "bob's secure password", Role: acl.RoleUser}); !errors.Is(err, ErrAdminRequired) {
		t.Fatalf("Create(non-admin) error = %v, want ErrAdminRequired", err)
	}
}

func TestCannotRemoveLastActiveAdmin(t *testing.T) {
	service, _, admin := newUserService(t)
	if err := service.Delete(context.Background(), admin, admin.UserID, DeleteInput{}); !errors.Is(err, ErrLastAdmin) {
		t.Fatalf("Delete(last admin) error = %v, want ErrLastAdmin", err)
	}
}

func TestDeleteRetainsPhotosOwnerAsTombstoneAndRevokesSessions(t *testing.T) {
	service, authService, admin := newUserService(t)
	ctx := context.Background()
	created, err := service.Create(ctx, admin, CreateInput{Username: "alice", Password: "alice's secure password", Role: acl.RoleUser})
	if err != nil {
		t.Fatal(err)
	}
	_, aliceSession, err := authService.Authenticate(ctx, "alice", "alice's secure password")
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Delete(ctx, admin, created.ID, DeleteInput{}); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if _, _, err := authService.Current(ctx, aliceSession.Token); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("Current(deleted user) error = %v, want ErrUnauthorized", err)
	}
	users, err := service.List(ctx, admin)
	if err != nil {
		t.Fatal(err)
	}
	var found auth.Account
	for _, user := range users {
		if user.ID == created.ID {
			found = user
		}
	}
	if found.DeletedAt == nil || found.IsActive {
		t.Fatalf("deleted account = %+v, want inactive tombstone", found)
	}
}

func boolPtr(value bool) *bool { return &value }
func stringPtr(value string) *string { return &value }
