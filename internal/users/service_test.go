package users

import (
	"context"
	"database/sql"
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

func TestDisableUserRevokesOnlyThatUsersMobileSession(t *testing.T) {
	service, authService, admin := newUserService(t)
	ctx := context.Background()
	target, err := service.Create(ctx, admin, CreateInput{Username: "alice", Password: "alice's secure password", Role: acl.RoleUser})
	if err != nil {
		t.Fatal(err)
	}
	other, err := service.Create(ctx, admin, CreateInput{Username: "bob", Password: "bob's secure password", Role: acl.RoleUser})
	if err != nil {
		t.Fatal(err)
	}
	mobile, err := authService.CreateMobileSession(ctx, target.ID, auth.MobileDeviceInput{Name: "Alice phone", Platform: "android", AppVersion: "1.0.0"})
	if err != nil {
		t.Fatal(err)
	}
	otherMobile, err := authService.CreateMobileSession(ctx, other.ID, auth.MobileDeviceInput{Name: "Bob phone", Platform: "ios", AppVersion: "1.0.0"})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := service.Update(ctx, admin, target.ID, UpdateInput{IsActive: boolPtr(false)}); err != nil {
		t.Fatalf("Update(disable) error = %v", err)
	}
	assertNoUnrevokedMobileTokens(t, service.db, mobile.Device.ID)
	if _, err := authService.CurrentBearer(ctx, mobile.AccessToken); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("CurrentBearer(disabled user) error = %v, want ErrUnauthorized", err)
	}
	if _, err := authService.CurrentBearer(ctx, otherMobile.AccessToken); err != nil {
		t.Fatalf("CurrentBearer(other user) error = %v, want nil", err)
	}
}

func TestDeleteUserRevokesOnlyThatUsersMobileSession(t *testing.T) {
	service, authService, admin := newUserService(t)
	ctx := context.Background()
	target, err := service.Create(ctx, admin, CreateInput{Username: "alice", Password: "alice's secure password", Role: acl.RoleUser})
	if err != nil {
		t.Fatal(err)
	}
	other, err := service.Create(ctx, admin, CreateInput{Username: "bob", Password: "bob's secure password", Role: acl.RoleUser})
	if err != nil {
		t.Fatal(err)
	}
	mobile, err := authService.CreateMobileSession(ctx, target.ID, auth.MobileDeviceInput{Name: "Alice phone", Platform: "android", AppVersion: "1.0.0"})
	if err != nil {
		t.Fatal(err)
	}
	otherMobile, err := authService.CreateMobileSession(ctx, other.ID, auth.MobileDeviceInput{Name: "Bob phone", Platform: "ios", AppVersion: "1.0.0"})
	if err != nil {
		t.Fatal(err)
	}

	if err := service.Delete(ctx, admin, target.ID, DeleteInput{}); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	assertNoUnrevokedMobileTokens(t, service.db, mobile.Device.ID)
	if _, err := authService.CurrentBearer(ctx, mobile.AccessToken); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("CurrentBearer(deleted user) error = %v, want ErrUnauthorized", err)
	}
	if _, err := authService.CurrentBearer(ctx, otherMobile.AccessToken); err != nil {
		t.Fatalf("CurrentBearer(other user) error = %v, want nil", err)
	}
}

func TestChangePasswordRevokesOnlyThatUsersMobileSession(t *testing.T) {
	service, authService, admin := newUserService(t)
	ctx := context.Background()
	target, err := service.Create(ctx, admin, CreateInput{Username: "alice", Password: "alice's secure password", Role: acl.RoleUser})
	if err != nil {
		t.Fatal(err)
	}
	other, err := service.Create(ctx, admin, CreateInput{Username: "bob", Password: "bob's secure password", Role: acl.RoleUser})
	if err != nil {
		t.Fatal(err)
	}
	mobile, err := authService.CreateMobileSession(ctx, target.ID, auth.MobileDeviceInput{Name: "Alice phone", Platform: "android", AppVersion: "1.0.0"})
	if err != nil {
		t.Fatal(err)
	}
	_, browserSession, err := authService.Authenticate(ctx, "alice", "alice's secure password")
	if err != nil {
		t.Fatal(err)
	}
	otherMobile, err := authService.CreateMobileSession(ctx, other.ID, auth.MobileDeviceInput{Name: "Bob phone", Platform: "ios", AppVersion: "1.0.0"})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := service.Update(ctx, admin, target.ID, UpdateInput{Password: stringPtr("alice's new secure password")}); err != nil {
		t.Fatalf("Update(password) error = %v", err)
	}
	assertNoUnrevokedMobileTokens(t, service.db, mobile.Device.ID)
	if _, err := authService.CurrentBearer(ctx, mobile.AccessToken); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("CurrentBearer(password-changed user) error = %v, want ErrUnauthorized", err)
	}
	if _, _, err := authService.Current(ctx, browserSession.Token); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("Current(password-changed user browser session) error = %v, want ErrUnauthorized", err)
	}
	if _, err := authService.CurrentBearer(ctx, otherMobile.AccessToken); err != nil {
		t.Fatalf("CurrentBearer(other user) error = %v, want nil", err)
	}
}

func assertNoUnrevokedMobileTokens(t *testing.T, db *sql.DB, deviceID string) {
	t.Helper()
	var count int
	if err := db.QueryRowContext(context.Background(), "SELECT count(*) FROM mobile_tokens WHERE device_id=? AND revoked_at IS NULL", deviceID).Scan(&count); err != nil {
		t.Fatalf("count unrevoked mobile tokens for device %q: %v", deviceID, err)
	}
	if count != 0 {
		t.Fatalf("unrevoked mobile tokens for device %q = %d, want 0", deviceID, count)
	}
}

func boolPtr(value bool) *bool       { return &value }
func stringPtr(value string) *string { return &value }
