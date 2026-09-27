package auth

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

var ErrCurrentPasswordIncorrect = errors.New("current password is incorrect")

// ChangePassword lets a signed-in user replace their own password. Every other
// browser session and mobile device is signed out; the caller's own session
// (keepSessionID) or device (keepDeviceID) stays signed in.
func (s *Service) ChangePassword(ctx context.Context, userID, current, next, keepSessionID, keepDeviceID string) error {
	limiterKey := "password-change:" + userID
	if !s.limiter.allow(limiterKey) {
		return ErrRateLimited
	}
	var hash string
	err := s.db.QueryRowContext(ctx, "SELECT password_hash FROM users WHERE id=? AND is_active=1 AND deleted_at IS NULL", userID).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrUnauthorized
	}
	if err != nil {
		return fmt.Errorf("load account for password change: %w", err)
	}
	if ok, verifyErr := VerifyPassword(hash, current); verifyErr != nil || !ok {
		s.limiter.failure(limiterKey)
		return ErrCurrentPasswordIncorrect
	}
	if err := validateCredentials("valid-user", next); err != nil {
		return err
	}
	newHash, err := HashPassword(next)
	if err != nil {
		return err
	}
	now := formatTime(time.Now().UTC())
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin password change: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "UPDATE users SET password_hash=?, updated_at=? WHERE id=?", newHash, now, userID); err != nil {
		return fmt.Errorf("update password: %w", err)
	}
	if _, err := tx.ExecContext(ctx, "UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND id<>?", now, userID, keepSessionID); err != nil {
		return fmt.Errorf("revoke other sessions: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE mobile_tokens SET revoked_at=?
WHERE revoked_at IS NULL AND device_id IN (SELECT id FROM mobile_devices WHERE user_id=? AND id<>?)`, now, userID, keepDeviceID); err != nil {
		return fmt.Errorf("revoke other mobile devices: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit password change: %w", err)
	}
	s.limiter.success(limiterKey)
	return nil
}
