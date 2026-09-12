package auth

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	dbstore "github.com/zxxx98/77Photo/internal/database"
)

func newAuthService(t *testing.T) (*Service, *sql.DB) {
	t.Helper()
	db, err := dbstore.Open(context.Background(), filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return NewService(db, 2*time.Hour, false), db
}

func TestSetupAdminIsOneTimeAndCreatesSession(t *testing.T) {
	service, _ := newAuthService(t)
	ctx := context.Background()
	account, session, err := service.SetupAdmin(ctx, "admin", "correct horse battery staple")
	if err != nil {
		t.Fatalf("SetupAdmin() error = %v", err)
	}
	if account.Role != RoleAdmin || !account.IsActive || account.ID == "" {
		t.Fatalf("account = %+v", account)
	}
	if session.Token == "" || session.CSRFToken == "" || session.ExpiresAt.Before(time.Now()) {
		t.Fatalf("session = %+v", session)
	}
	if _, _, err := service.SetupAdmin(ctx, "second", "another correct password"); !errors.Is(err, ErrSetupComplete) {
		t.Fatalf("second SetupAdmin() error = %v, want ErrSetupComplete", err)
	}
}

func TestAuthenticateCurrentCSRFAndRevoke(t *testing.T) {
	service, _ := newAuthService(t)
	ctx := context.Background()
	if _, _, err := service.SetupAdmin(ctx, "admin", "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	account, session, err := service.Authenticate(ctx, "admin", "correct horse battery staple")
	if err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	current, lookedUp, err := service.Current(ctx, session.Token)
	if err != nil {
		t.Fatalf("Current() error = %v", err)
	}
	if current.ID != account.ID || lookedUp.ID != session.ID {
		t.Fatalf("current/session = %+v/%+v", current, lookedUp)
	}
	if err := service.ValidateCSRF(session, session.CSRFToken); err != nil {
		t.Fatalf("ValidateCSRF(correct) error = %v", err)
	}
	if err := service.ValidateCSRF(lookedUp, session.CSRFToken); err != nil {
		t.Fatalf("ValidateCSRF(after lookup) error = %v", err)
	}
	if !errors.Is(service.ValidateCSRF(session, "wrong"), ErrCSRF) {
		t.Fatal("ValidateCSRF(wrong) did not return ErrCSRF")
	}
	if err := service.Revoke(ctx, session.Token); err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.Current(ctx, session.Token); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("Current(revoked) error = %v, want ErrUnauthorized", err)
	}
}

func TestAuthenticateHidesUnknownAndWrongPassword(t *testing.T) {
	service, _ := newAuthService(t)
	ctx := context.Background()
	if _, _, err := service.SetupAdmin(ctx, "admin", "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	_, _, wrongErr := service.Authenticate(ctx, "admin", "wrong password")
	_, _, unknownErr := service.Authenticate(ctx, "nobody", "wrong password")
	if !errors.Is(wrongErr, ErrInvalidCredentials) || !errors.Is(unknownErr, ErrInvalidCredentials) {
		t.Fatalf("errors = %v and %v, want ErrInvalidCredentials", wrongErr, unknownErr)
	}
}

func TestExpiredSessionCannotBeUsed(t *testing.T) {
	service, db := newAuthService(t)
	ctx := context.Background()
	if _, _, err := service.SetupAdmin(ctx, "admin", "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	_, session, err := service.Authenticate(ctx, "admin", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, "UPDATE sessions SET expires_at=? WHERE id=?", time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano), session.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.Current(ctx, session.Token); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("Current(expired) error = %v, want ErrUnauthorized", err)
	}
}

func TestLoginRateLimitAfterRepeatedFailures(t *testing.T) {
	service, _ := newAuthService(t)
	ctx := context.Background()
	if _, _, err := service.SetupAdmin(ctx, "admin", "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		_, _, err := service.Authenticate(ctx, "admin", "wrong password")
		if !errors.Is(err, ErrInvalidCredentials) {
			t.Fatalf("failure %d error = %v, want ErrInvalidCredentials", i+1, err)
		}
	}
	if _, _, err := service.Authenticate(ctx, "admin", "wrong password"); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("sixth failure error = %v, want ErrRateLimited", err)
	}
}
