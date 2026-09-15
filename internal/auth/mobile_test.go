package auth

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	dbstore "github.com/zxxx98/77Photo/internal/database"
)

func newMobileAuthService(t *testing.T) (*Service, Account) {
	t.Helper()
	db, err := dbstore.Open(context.Background(), filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	service := NewService(db, 2*time.Hour, false)
	account, _, err := service.SetupAdmin(context.Background(), "mobile-owner", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	return service, account
}

func TestMobileTokensRotateAndRejectReuse(t *testing.T) {
	service, account := newMobileAuthService(t)
	first, err := service.CreateMobileSession(context.Background(), account.ID, MobileDeviceInput{
		Name: "Pixel 9", Platform: "android", AppVersion: "1.0.0",
	})
	if err != nil {
		t.Fatal(err)
	}

	current, err := service.CurrentBearer(context.Background(), first.AccessToken)
	if err != nil || current.Account.ID != account.ID {
		t.Fatalf("CurrentBearer() = %+v, %v", current, err)
	}

	rotated, err := service.RefreshMobileSession(context.Background(), first.RefreshToken)
	if err != nil {
		t.Fatal(err)
	}
	if rotated.RefreshToken == first.RefreshToken || rotated.AccessToken == first.AccessToken {
		t.Fatal("refresh did not rotate both credentials")
	}

	if _, err := service.RefreshMobileSession(context.Background(), first.RefreshToken); !errors.Is(err, ErrRefreshReuse) {
		t.Fatalf("reused refresh error = %v, want ErrRefreshReuse", err)
	}
	if _, err := service.CurrentBearer(context.Background(), rotated.AccessToken); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("family access after reuse = %v, want unauthorized", err)
	}
}

func TestMobileSessionUsesFixedAccessAndRefreshExpiries(t *testing.T) {
	service, account := newMobileAuthService(t)
	session, err := service.CreateMobileSession(context.Background(), account.ID, MobileDeviceInput{
		Name: "iPhone", Platform: "ios", AppVersion: "2.3.4",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := session.AccessTokenExpiresAt.Sub(session.Device.CreatedAt); got != mobileAccessTTL {
		t.Fatalf("access expiry duration = %v, want %v", got, mobileAccessTTL)
	}
	if got := session.RefreshTokenExpiresAt.Sub(session.Device.CreatedAt); got != mobileRefreshTTL {
		t.Fatalf("refresh expiry duration = %v, want %v", got, mobileRefreshTTL)
	}
}

func TestExpiredPersistedMobileAccessTokenIsUnauthorized(t *testing.T) {
	service, account := newMobileAuthService(t)
	session, err := service.CreateMobileSession(context.Background(), account.ID, MobileDeviceInput{Name: "Pixel 9", Platform: "android", AppVersion: "1.0.0"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.db.ExecContext(context.Background(), `UPDATE mobile_tokens SET expires_at=? WHERE token_type='access' AND token_hash=?`, formatTime(time.Now().UTC().Add(-time.Minute)), hashToken(session.AccessToken)); err != nil {
		t.Fatal(err)
	}
	if _, err := service.CurrentBearer(context.Background(), session.AccessToken); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("expired persisted access error = %v, want ErrUnauthorized", err)
	}
}

func TestExpiredPersistedMobileRefreshTokenIsUnauthorized(t *testing.T) {
	service, account := newMobileAuthService(t)
	session, err := service.CreateMobileSession(context.Background(), account.ID, MobileDeviceInput{Name: "Pixel 9", Platform: "android", AppVersion: "1.0.0"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.db.ExecContext(context.Background(), `UPDATE mobile_tokens SET expires_at=? WHERE token_type='refresh' AND token_hash=?`, formatTime(time.Now().UTC().Add(-time.Minute)), hashToken(session.RefreshToken)); err != nil {
		t.Fatal(err)
	}
	if _, err := service.RefreshMobileSession(context.Background(), session.RefreshToken); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("expired persisted refresh error = %v, want ErrUnauthorized", err)
	}
}

func TestCurrentBearerRejectsInactiveMobileAccount(t *testing.T) {
	service, account := newMobileAuthService(t)
	session, err := service.CreateMobileSession(context.Background(), account.ID, MobileDeviceInput{Name: "Pixel 9", Platform: "android", AppVersion: "1.0.0"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.db.ExecContext(context.Background(), "UPDATE users SET is_active=0 WHERE id=?", account.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.CurrentBearer(context.Background(), session.AccessToken); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("inactive account bearer error = %v, want ErrUnauthorized", err)
	}
}

func TestCurrentBearerRejectsDeletedMobileAccount(t *testing.T) {
	service, account := newMobileAuthService(t)
	session, err := service.CreateMobileSession(context.Background(), account.ID, MobileDeviceInput{Name: "Pixel 9", Platform: "android", AppVersion: "1.0.0"})
	if err != nil {
		t.Fatal(err)
	}
	deletedAt := time.Now().UTC()
	if _, err := service.db.ExecContext(context.Background(), "UPDATE users SET deleted_at=? WHERE id=?", formatTime(deletedAt), account.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.CurrentBearer(context.Background(), session.AccessToken); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("deleted account bearer error = %v, want ErrUnauthorized", err)
	}
}

func TestRevokeMobileSessionsForUserTxRevokesOnlyTargetUser(t *testing.T) {
	service, account := newMobileAuthService(t)
	other := createMobileTestAccount(t, service, "mobile-other")
	owned, err := service.CreateMobileSession(context.Background(), account.ID, MobileDeviceInput{Name: "Owner phone", Platform: "android", AppVersion: "1.0.0"})
	if err != nil {
		t.Fatal(err)
	}
	otherSession, err := service.CreateMobileSession(context.Background(), other.ID, MobileDeviceInput{Name: "Other phone", Platform: "ios", AppVersion: "1.0.0"})
	if err != nil {
		t.Fatal(err)
	}

	tx, err := service.db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.RevokeMobileSessionsForUserTx(context.Background(), tx, account.ID); err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	if _, err := service.CurrentBearer(context.Background(), owned.AccessToken); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("revoked access error = %v, want ErrUnauthorized", err)
	}
	if _, err := service.RefreshMobileSession(context.Background(), owned.RefreshToken); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("revoked refresh error = %v, want ErrUnauthorized", err)
	}
	if _, err := service.CurrentBearer(context.Background(), otherSession.AccessToken); err != nil {
		t.Fatalf("other user access error = %v, want nil", err)
	}
	if _, err := service.RefreshMobileSession(context.Background(), otherSession.RefreshToken); err != nil {
		t.Fatalf("other user refresh error = %v, want nil", err)
	}
}

func TestConcurrentMobileRefreshAllowsOneRotationAndRevokesFamilyOnReuse(t *testing.T) {
	service, account := newMobileAuthService(t)
	first, err := service.CreateMobileSession(context.Background(), account.ID, MobileDeviceInput{Name: "Pixel 9", Platform: "android", AppVersion: "1.0.0"})
	if err != nil {
		t.Fatal(err)
	}

	start := make(chan struct{})
	ready := make(chan struct{}, 2)
	type refreshResult struct {
		session MobileSession
		err     error
	}
	results := make(chan refreshResult, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ready <- struct{}{}
			<-start
			rotated, err := service.RefreshMobileSession(context.Background(), first.RefreshToken)
			results <- refreshResult{session: rotated, err: err}
		}()
	}
	<-ready
	<-ready
	close(start)
	wg.Wait()
	close(results)

	var winner MobileSession
	var loserErr error
	winners := 0
	for result := range results {
		if result.err == nil {
			winner = result.session
			winners++
			continue
		}
		loserErr = result.err
	}
	if winners != 1 {
		t.Fatalf("successful concurrent refreshes = %d, want 1", winners)
	}
	if !errors.Is(loserErr, ErrRefreshReuse) && !errors.Is(loserErr, ErrUnauthorized) {
		t.Fatalf("losing concurrent refresh error = %v, want ErrRefreshReuse or ErrUnauthorized", loserErr)
	}

	if _, err := service.RefreshMobileSession(context.Background(), first.RefreshToken); !errors.Is(err, ErrRefreshReuse) {
		t.Fatalf("serialized reused refresh error = %v, want ErrRefreshReuse", err)
	}
	if _, err := service.CurrentBearer(context.Background(), winner.AccessToken); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("concurrent refresh family access error = %v, want ErrUnauthorized", err)
	}
}

func TestMobileSessionStoresOnlyTokenHashes(t *testing.T) {
	service, account := newMobileAuthService(t)
	session, err := service.CreateMobileSession(context.Background(), account.ID, MobileDeviceInput{
		Name: "Pixel 9", Platform: "android", AppVersion: "1.0.0",
	})
	if err != nil {
		t.Fatal(err)
	}
	rows, err := service.db.QueryContext(context.Background(), "SELECT token_hash FROM mobile_tokens WHERE device_id=?", session.Device.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	seen := 0
	for rows.Next() {
		var stored string
		if err := rows.Scan(&stored); err != nil {
			t.Fatal(err)
		}
		if stored == session.AccessToken || stored == session.RefreshToken {
			t.Fatalf("stored token %q equals a raw token", stored)
		}
		if !strings.HasPrefix(stored, "sha256:") {
			t.Fatalf("stored token = %q, want a token hash", stored)
		}
		seen++
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if seen != 2 {
		t.Fatalf("stored token count = %d, want 2", seen)
	}
}

func TestListMobileDevicesOnlyReturnsCurrentUsersDevices(t *testing.T) {
	service, account := newMobileAuthService(t)
	other := createMobileTestAccount(t, service, "mobile-other")
	if _, err := service.CreateMobileSession(context.Background(), account.ID, MobileDeviceInput{Name: "Owner phone", Platform: "android", AppVersion: "1.0.0"}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.CreateMobileSession(context.Background(), other.ID, MobileDeviceInput{Name: "Other phone", Platform: "ios", AppVersion: "1.0.0"}); err != nil {
		t.Fatal(err)
	}

	devices, err := service.ListMobileDevices(context.Background(), account.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 1 || devices[0].UserID != account.ID || devices[0].Name != "Owner phone" {
		t.Fatalf("ListMobileDevices() = %+v, want only %s's device", devices, account.ID)
	}
}

func TestRevokeMobileDeviceLeavesAnotherDeviceUsable(t *testing.T) {
	service, account := newMobileAuthService(t)
	first, err := service.CreateMobileSession(context.Background(), account.ID, MobileDeviceInput{Name: "Old phone", Platform: "android", AppVersion: "1.0.0"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.CreateMobileSession(context.Background(), account.ID, MobileDeviceInput{Name: "New phone", Platform: "ios", AppVersion: "1.0.0"})
	if err != nil {
		t.Fatal(err)
	}

	if err := service.RevokeMobileDevice(context.Background(), account.ID, first.Device.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.CurrentBearer(context.Background(), first.AccessToken); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("revoked device access error = %v, want unauthorized", err)
	}
	principal, err := service.CurrentBearer(context.Background(), second.AccessToken)
	if err != nil || principal.DeviceID != second.Device.ID {
		t.Fatalf("other device bearer = %+v, %v", principal, err)
	}
}

func createMobileTestAccount(t *testing.T, service *Service, username string) Account {
	t.Helper()
	now := time.Now().UTC()
	account := Account{ID: newID(), Username: username, Role: RoleUser, IsActive: true, CreatedAt: now, UpdatedAt: now}
	hash, err := HashPassword("another correct password")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.db.ExecContext(context.Background(), `INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at)
VALUES (?, ?, ?, ?, 1, ?, ?)`, account.ID, account.Username, hash, account.Role, formatTime(now), formatTime(now)); err != nil {
		t.Fatal(err)
	}
	return account
}
