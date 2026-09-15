package auth

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	mobileAccessTTL  = 15 * time.Minute
	mobileRefreshTTL = 90 * 24 * time.Hour
)

var ErrRefreshReuse = errors.New("refresh token reuse detected")

type MobileDeviceInput struct {
	Name, Platform, AppVersion string
}

type MobileDevice struct {
	ID         string     `json:"id"`
	UserID     string     `json:"user_id"`
	Name       string     `json:"name"`
	Platform   string     `json:"platform"`
	AppVersion string     `json:"app_version"`
	CreatedAt  time.Time  `json:"created_at"`
	LastSeenAt time.Time  `json:"last_seen_at"`
	RevokedAt  *time.Time `json:"revoked_at,omitempty"`
}

type MobileSession struct {
	Device                                      MobileDevice
	AccessToken, RefreshToken                   string
	AccessTokenExpiresAt, RefreshTokenExpiresAt time.Time
}

type BearerPrincipal struct {
	Account  Account
	DeviceID string
	TokenID  string
}

func (s *Service) CreateMobileSession(ctx context.Context, userID string, input MobileDeviceInput) (MobileSession, error) {
	input, err := normalizeMobileDeviceInput(input)
	if err != nil {
		return MobileSession{}, err
	}
	if strings.TrimSpace(userID) == "" {
		return MobileSession{}, ErrUnauthorized
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return MobileSession{}, fmt.Errorf("begin mobile session creation: %w", err)
	}
	defer tx.Rollback()

	var active int
	var deletedAt sql.NullString
	if err := tx.QueryRowContext(ctx, "SELECT is_active, deleted_at FROM users WHERE id=?", userID).Scan(&active, &deletedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return MobileSession{}, ErrUnauthorized
		}
		return MobileSession{}, fmt.Errorf("load mobile session user: %w", err)
	}
	if active != 1 || deletedAt.Valid {
		return MobileSession{}, ErrUnauthorized
	}

	now := time.Now().UTC()
	device := MobileDevice{
		ID:         newID(),
		UserID:     userID,
		Name:       input.Name,
		Platform:   input.Platform,
		AppVersion: input.AppVersion,
		CreatedAt:  now,
		LastSeenAt: now,
		RevokedAt:  nil,
	}
	familyID := newID()
	accessToken := randomToken()
	refreshToken := randomToken()
	accessExpiresAt := now.Add(mobileAccessTTL)
	refreshExpiresAt := now.Add(mobileRefreshTTL)

	if _, err := tx.ExecContext(ctx, `INSERT INTO mobile_devices (id, user_id, name, platform, app_version, created_at, last_seen_at)
VALUES (?, ?, ?, ?, ?, ?, ?)`, device.ID, device.UserID, device.Name, device.Platform, device.AppVersion, formatTime(device.CreatedAt), formatTime(device.LastSeenAt)); err != nil {
		return MobileSession{}, fmt.Errorf("create mobile device: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO mobile_tokens (id, device_id, family_id, token_type, token_hash, expires_at, created_at)
VALUES (?, ?, ?, 'access', ?, ?, ?)`, newID(), device.ID, familyID, hashToken(accessToken), formatTime(accessExpiresAt), formatTime(now)); err != nil {
		return MobileSession{}, fmt.Errorf("create mobile access token: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO mobile_tokens (id, device_id, family_id, token_type, token_hash, expires_at, created_at)
VALUES (?, ?, ?, 'refresh', ?, ?, ?)`, newID(), device.ID, familyID, hashToken(refreshToken), formatTime(refreshExpiresAt), formatTime(now)); err != nil {
		return MobileSession{}, fmt.Errorf("create mobile refresh token: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return MobileSession{}, fmt.Errorf("commit mobile session creation: %w", err)
	}

	return MobileSession{
		Device:                device,
		AccessToken:           accessToken,
		RefreshToken:          refreshToken,
		AccessTokenExpiresAt:  accessExpiresAt,
		RefreshTokenExpiresAt: refreshExpiresAt,
	}, nil
}

func (s *Service) CurrentBearer(ctx context.Context, accessToken string) (BearerPrincipal, error) {
	if strings.TrimSpace(accessToken) == "" {
		return BearerPrincipal{}, ErrUnauthorized
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return BearerPrincipal{}, fmt.Errorf("begin mobile bearer lookup: %w", err)
	}
	defer tx.Rollback()

	var tokenID, deviceID, userID string
	var expiresAt string
	var account Account
	var active int
	var deletedAt sql.NullString
	var createdAt, updatedAt string
	err = tx.QueryRowContext(ctx, `SELECT t.id, t.expires_at, d.id, d.user_id,
u.id, u.username, u.role, u.is_active, u.deleted_at, u.created_at, u.updated_at
FROM mobile_tokens t
JOIN mobile_devices d ON d.id=t.device_id AND d.revoked_at IS NULL
JOIN users u ON u.id=d.user_id AND u.is_active=1 AND u.deleted_at IS NULL
WHERE t.token_hash=? AND t.token_type='access' AND t.revoked_at IS NULL`, hashToken(accessToken)).Scan(
		&tokenID, &expiresAt, &deviceID, &userID,
		&account.ID, &account.Username, &account.Role, &active, &deletedAt, &createdAt, &updatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return BearerPrincipal{}, ErrUnauthorized
		}
		return BearerPrincipal{}, fmt.Errorf("load mobile bearer: %w", err)
	}
	expires, err := parseTime(expiresAt)
	if err != nil || !expires.After(time.Now().UTC()) || active != 1 || deletedAt.Valid {
		return BearerPrincipal{}, ErrUnauthorized
	}
	account.IsActive = true
	account.CreatedAt, err = parseTime(createdAt)
	if err != nil {
		return BearerPrincipal{}, ErrUnauthorized
	}
	account.UpdatedAt, err = parseTime(updatedAt)
	if err != nil {
		return BearerPrincipal{}, ErrUnauthorized
	}

	now := time.Now().UTC()
	result, err := tx.ExecContext(ctx, "UPDATE mobile_devices SET last_seen_at=? WHERE id=? AND revoked_at IS NULL", formatTime(now), deviceID)
	if err != nil {
		return BearerPrincipal{}, fmt.Errorf("update mobile device activity: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return BearerPrincipal{}, fmt.Errorf("check mobile device activity: %w", err)
	}
	if affected != 1 {
		return BearerPrincipal{}, ErrUnauthorized
	}
	if err := tx.Commit(); err != nil {
		return BearerPrincipal{}, fmt.Errorf("commit mobile bearer activity: %w", err)
	}

	return BearerPrincipal{Account: account, DeviceID: deviceID, TokenID: tokenID}, nil
}

func (s *Service) RefreshMobileSession(ctx context.Context, refreshToken string) (MobileSession, error) {
	if strings.TrimSpace(refreshToken) == "" {
		return MobileSession{}, ErrUnauthorized
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return MobileSession{}, fmt.Errorf("begin mobile session refresh: %w", err)
	}
	defer tx.Rollback()

	var tokenID, deviceID, familyID, expiresAt string
	var rotatedAt, revokedAt sql.NullString
	var device MobileDevice
	var deviceCreatedAt, deviceLastSeenAt string
	var deviceRevokedAt sql.NullString
	var active int
	var deletedAt sql.NullString
	if err := tx.QueryRowContext(ctx, `SELECT t.id, t.device_id, t.family_id, t.expires_at, t.rotated_at, t.revoked_at,
d.user_id, d.name, d.platform, d.app_version, d.created_at, d.last_seen_at, d.revoked_at,
u.is_active, u.deleted_at
FROM mobile_tokens t
JOIN mobile_devices d ON d.id=t.device_id
JOIN users u ON u.id=d.user_id
WHERE t.token_hash=? AND t.token_type='refresh'`, hashToken(refreshToken)).Scan(
		&tokenID, &deviceID, &familyID, &expiresAt, &rotatedAt, &revokedAt,
		&device.UserID, &device.Name, &device.Platform, &device.AppVersion, &deviceCreatedAt, &deviceLastSeenAt, &deviceRevokedAt,
		&active, &deletedAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return MobileSession{}, ErrUnauthorized
		}
		return MobileSession{}, fmt.Errorf("load mobile refresh token: %w", err)
	}
	device.ID = deviceID
	if rotatedAt.Valid {
		if err := revokeMobileFamilyTx(ctx, tx, familyID, time.Now().UTC()); err != nil {
			return MobileSession{}, err
		}
		if err := tx.Commit(); err != nil {
			return MobileSession{}, fmt.Errorf("commit mobile refresh reuse revocation: %w", err)
		}
		return MobileSession{}, ErrRefreshReuse
	}
	if revokedAt.Valid || deviceRevokedAt.Valid || active != 1 || deletedAt.Valid {
		return MobileSession{}, ErrUnauthorized
	}
	expires, err := parseTime(expiresAt)
	if err != nil || !expires.After(time.Now().UTC()) {
		return MobileSession{}, ErrUnauthorized
	}
	createdAt, err := parseTime(deviceCreatedAt)
	if err != nil {
		return MobileSession{}, ErrUnauthorized
	}
	lastSeenAt, err := parseTime(deviceLastSeenAt)
	if err != nil {
		return MobileSession{}, ErrUnauthorized
	}
	device.CreatedAt = createdAt
	device.LastSeenAt = lastSeenAt

	now := time.Now().UTC()
	result, err := tx.ExecContext(ctx, "UPDATE mobile_tokens SET rotated_at=? WHERE id=? AND rotated_at IS NULL AND revoked_at IS NULL", formatTime(now), tokenID)
	if err != nil {
		return MobileSession{}, fmt.Errorf("rotate mobile refresh token: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return MobileSession{}, fmt.Errorf("check rotated mobile refresh token: %w", err)
	}
	if affected != 1 {
		var currentRotatedAt, currentRevokedAt sql.NullString
		if err := tx.QueryRowContext(ctx, "SELECT rotated_at, revoked_at FROM mobile_tokens WHERE id=?", tokenID).Scan(&currentRotatedAt, &currentRevokedAt); err != nil {
			return MobileSession{}, fmt.Errorf("reload rotated mobile refresh token: %w", err)
		}
		if currentRotatedAt.Valid {
			if err := revokeMobileFamilyTx(ctx, tx, familyID, now); err != nil {
				return MobileSession{}, err
			}
			if err := tx.Commit(); err != nil {
				return MobileSession{}, fmt.Errorf("commit concurrent mobile refresh reuse revocation: %w", err)
			}
			return MobileSession{}, ErrRefreshReuse
		}
		return MobileSession{}, ErrUnauthorized
	}

	if _, err := tx.ExecContext(ctx, "UPDATE mobile_tokens SET revoked_at=? WHERE family_id=? AND token_type='access' AND revoked_at IS NULL", formatTime(now), familyID); err != nil {
		return MobileSession{}, fmt.Errorf("revoke previous mobile access tokens: %w", err)
	}
	result, err = tx.ExecContext(ctx, "UPDATE mobile_devices SET last_seen_at=? WHERE id=? AND revoked_at IS NULL", formatTime(now), deviceID)
	if err != nil {
		return MobileSession{}, fmt.Errorf("update refreshed mobile device activity: %w", err)
	}
	affected, err = result.RowsAffected()
	if err != nil {
		return MobileSession{}, fmt.Errorf("check refreshed mobile device activity: %w", err)
	}
	if affected != 1 {
		return MobileSession{}, ErrUnauthorized
	}

	accessToken := randomToken()
	newRefreshToken := randomToken()
	accessExpiresAt := now.Add(mobileAccessTTL)
	refreshExpiresAt := now.Add(mobileRefreshTTL)
	if _, err := tx.ExecContext(ctx, `INSERT INTO mobile_tokens (id, device_id, family_id, token_type, token_hash, expires_at, created_at)
VALUES (?, ?, ?, 'access', ?, ?, ?)`, newID(), deviceID, familyID, hashToken(accessToken), formatTime(accessExpiresAt), formatTime(now)); err != nil {
		return MobileSession{}, fmt.Errorf("create rotated mobile access token: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO mobile_tokens (id, device_id, family_id, token_type, token_hash, expires_at, created_at)
VALUES (?, ?, ?, 'refresh', ?, ?, ?)`, newID(), deviceID, familyID, hashToken(newRefreshToken), formatTime(refreshExpiresAt), formatTime(now)); err != nil {
		return MobileSession{}, fmt.Errorf("create rotated mobile refresh token: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return MobileSession{}, fmt.Errorf("commit mobile session refresh: %w", err)
	}

	device.LastSeenAt = now
	return MobileSession{
		Device:                device,
		AccessToken:           accessToken,
		RefreshToken:          newRefreshToken,
		AccessTokenExpiresAt:  accessExpiresAt,
		RefreshTokenExpiresAt: refreshExpiresAt,
	}, nil
}

func (s *Service) ListMobileDevices(ctx context.Context, userID string) ([]MobileDevice, error) {
	if strings.TrimSpace(userID) == "" {
		return nil, ErrUnauthorized
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, user_id, name, platform, app_version, created_at, last_seen_at, revoked_at
FROM mobile_devices WHERE user_id=? ORDER BY created_at DESC, id DESC`, userID)
	if err != nil {
		return nil, fmt.Errorf("list mobile devices: %w", err)
	}
	defer rows.Close()
	devices := make([]MobileDevice, 0)
	for rows.Next() {
		device, err := scanMobileDevice(rows)
		if err != nil {
			return nil, fmt.Errorf("scan mobile device: %w", err)
		}
		devices = append(devices, device)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list mobile devices rows: %w", err)
	}
	return devices, nil
}

func (s *Service) RevokeMobileDevice(ctx context.Context, userID, deviceID string) error {
	if strings.TrimSpace(userID) == "" || strings.TrimSpace(deviceID) == "" {
		return ErrUnauthorized
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin mobile device revocation: %w", err)
	}
	defer tx.Rollback()

	var revokedAt sql.NullString
	if err := tx.QueryRowContext(ctx, "SELECT revoked_at FROM mobile_devices WHERE id=? AND user_id=?", deviceID, userID).Scan(&revokedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrUnauthorized
		}
		return fmt.Errorf("load mobile device for revocation: %w", err)
	}
	now := time.Now().UTC()
	if !revokedAt.Valid {
		if _, err := tx.ExecContext(ctx, "UPDATE mobile_devices SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL", formatTime(now), deviceID, userID); err != nil {
			return fmt.Errorf("revoke mobile device: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, "UPDATE mobile_tokens SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL", formatTime(now), deviceID); err != nil {
		return fmt.Errorf("revoke mobile device tokens: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit mobile device revocation: %w", err)
	}
	return nil
}

func (s *Service) RevokeMobileSessionsForUserTx(ctx context.Context, tx *sql.Tx, userID string) error {
	if strings.TrimSpace(userID) == "" {
		return nil
	}
	if _, err := tx.ExecContext(ctx, `UPDATE mobile_tokens SET revoked_at=?
WHERE revoked_at IS NULL AND device_id IN (SELECT id FROM mobile_devices WHERE user_id=?)`, formatTime(time.Now().UTC()), userID); err != nil {
		return fmt.Errorf("revoke mobile sessions for user: %w", err)
	}
	return nil
}

func normalizeMobileDeviceInput(input MobileDeviceInput) (MobileDeviceInput, error) {
	input.Name = strings.TrimSpace(input.Name)
	input.Platform = strings.ToLower(strings.TrimSpace(input.Platform))
	input.AppVersion = strings.TrimSpace(input.AppVersion)
	if !utf8.ValidString(input.Name) || utf8.RuneCountInString(input.Name) == 0 || utf8.RuneCountInString(input.Name) > 128 {
		return MobileDeviceInput{}, fmt.Errorf("device name must be 1-128 characters")
	}
	if input.Platform != "android" && input.Platform != "ios" {
		return MobileDeviceInput{}, fmt.Errorf("device platform must be android or ios")
	}
	if !utf8.ValidString(input.AppVersion) || utf8.RuneCountInString(input.AppVersion) == 0 || utf8.RuneCountInString(input.AppVersion) > 64 {
		return MobileDeviceInput{}, fmt.Errorf("app version must be 1-64 characters")
	}
	return input, nil
}

func revokeMobileFamilyTx(ctx context.Context, tx *sql.Tx, familyID string, now time.Time) error {
	if _, err := tx.ExecContext(ctx, "UPDATE mobile_tokens SET revoked_at=? WHERE family_id=? AND revoked_at IS NULL", formatTime(now), familyID); err != nil {
		return fmt.Errorf("revoke mobile token family: %w", err)
	}
	return nil
}

type mobileRowScanner interface {
	Scan(...any) error
}

func scanMobileDevice(row mobileRowScanner) (MobileDevice, error) {
	var device MobileDevice
	var createdAt, lastSeenAt string
	var revokedAt sql.NullString
	if err := row.Scan(&device.ID, &device.UserID, &device.Name, &device.Platform, &device.AppVersion, &createdAt, &lastSeenAt, &revokedAt); err != nil {
		return MobileDevice{}, err
	}
	var err error
	device.CreatedAt, err = parseTime(createdAt)
	if err != nil {
		return MobileDevice{}, err
	}
	device.LastSeenAt, err = parseTime(lastSeenAt)
	if err != nil {
		return MobileDevice{}, err
	}
	if revokedAt.Valid {
		value, err := parseTime(revokedAt.String)
		if err != nil {
			return MobileDevice{}, err
		}
		device.RevokedAt = &value
	}
	return device, nil
}
