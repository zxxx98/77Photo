package sharelinks

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
	"github.com/zxxx98/77Photo/internal/storage"
	"github.com/zxxx98/77Photo/internal/thumbnails"
)

var (
	ErrForbidden        = errors.New("share link creation forbidden")
	ErrInvalid          = errors.New("share link request is invalid")
	ErrUnavailable      = errors.New("share link is unavailable")
	ErrPasswordRequired = errors.New("share link password is required")
	ErrInvalidPassword  = errors.New("share link password is invalid")
	ErrOutOfScope       = errors.New("photo is outside share link scope")
)

type ResourceType string

const (
	ResourcePhoto  ResourceType = "photo"
	ResourceFolder ResourceType = "folder"
)

type Duration string

const (
	DurationOneDay    Duration = "1_day"
	DurationSevenDays Duration = "7_days"
	DurationForever   Duration = "forever"
)

type CreateInput struct {
	ResourceType ResourceType `json:"resource_type"`
	ResourceID   string       `json:"resource_id"`
	Duration     Duration     `json:"duration"`
	Password     string       `json:"password,omitempty"`
}

type Link struct {
	ID                string       `json:"id"`
	ResourceType      ResourceType `json:"resource_type"`
	ResourceID        string       `json:"resource_id"`
	URL               string       `json:"url"`
	ExpiresAt         *time.Time   `json:"expires_at"`
	PasswordProtected bool         `json:"password_protected"`
	Token             string       `json:"-"`
}

type PublicShare struct {
	ResourceType     ResourceType `json:"resource_type"`
	Name             string       `json:"name"`
	FolderName       string       `json:"folder_name,omitempty"`
	FolderPath       string       `json:"folder_path,omitempty"`
	PasswordRequired bool         `json:"password_required"`
	ExpiresAt        *time.Time   `json:"expires_at"`
}

type PublicPhoto struct {
	ID          string    `json:"id"`
	FolderID    string    `json:"folder_id"`
	Filename    string    `json:"filename"`
	MIMEType    string    `json:"mime_type"`
	Size        int64     `json:"size"`
	CapturedAt  time.Time `json:"captured_at"`
	Width       int       `json:"width,omitempty"`
	Height      int       `json:"height,omitempty"`
	StoragePath string    `json:"-"`
}

type ThumbnailService interface {
	Ensure(context.Context, string, int) (thumbnails.State, string, error)
}

type Service struct {
	db            *sql.DB
	storage       storage.Store
	thumbnails    ThumbnailService
	secureCookies bool
}

func NewService(db *sql.DB, store storage.Store, thumbnails ThumbnailService, secureCookies bool) *Service {
	return &Service{db: db, storage: store, thumbnails: thumbnails, secureCookies: secureCookies}
}

func (s *Service) Create(ctx context.Context, principal acl.Principal, input CreateInput) (Link, error) {
	if !validResourceType(input.ResourceType) || strings.TrimSpace(input.ResourceID) == "" {
		return Link{}, ErrInvalid
	}
	duration, ok := durationValue(input.Duration)
	if !ok {
		return Link{}, ErrInvalid
	}
	ownerID, err := s.resourceOwner(ctx, input.ResourceType, input.ResourceID)
	if errors.Is(err, sql.ErrNoRows) {
		return Link{}, ErrInvalid
	}
	if err != nil {
		return Link{}, fmt.Errorf("load share resource: %w", err)
	}
	if !acl.CanManageShare(principal, ownerID) {
		return Link{}, ErrForbidden
	}

	var passwordHash *string
	if input.Password != "" {
		hash, err := auth.HashPassword(input.Password)
		if err != nil {
			return Link{}, ErrInvalid
		}
		passwordHash = &hash
	}

	now := time.Now().UTC()
	var expiresAt *time.Time
	if duration > 0 {
		expires := now.Add(duration)
		expiresAt = &expires
	}
	for attempt := 0; attempt < 3; attempt++ {
		id := newID("sl_")
		token := randomToken()
		_, err = s.db.ExecContext(ctx, `INSERT INTO share_links
(id, resource_type, resource_id, token_hash, password_hash, expires_at, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, input.ResourceType, input.ResourceID, hashToken(token), passwordHash, optionalTime(expiresAt), formatTime(now), formatTime(now))
		if err == nil {
			return Link{ID: id, ResourceType: input.ResourceType, ResourceID: input.ResourceID, URL: "/#/share/" + token, ExpiresAt: expiresAt, PasswordProtected: passwordHash != nil, Token: token}, nil
		}
		if !strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return Link{}, fmt.Errorf("create share link: %w", err)
		}
	}
	return Link{}, errors.New("could not allocate share link")
}

func (s *Service) Inspect(ctx context.Context, token string) (PublicShare, error) {
	record, err := s.activeRecord(ctx, token)
	if err != nil {
		return PublicShare{}, err
	}
	return s.publicShare(ctx, record)
}

func (s *Service) Unlock(ctx context.Context, token, password string) (string, PublicShare, error) {
	record, err := s.activeRecord(ctx, token)
	if err != nil {
		return "", PublicShare{}, err
	}
	if !record.passwordHash.Valid || record.passwordHash.String == "" {
		return "", PublicShare{}, ErrInvalidPassword
	}
	ok, verifyErr := auth.VerifyPassword(record.passwordHash.String, password)
	if verifyErr != nil || !ok {
		return "", PublicShare{}, ErrInvalidPassword
	}
	now := time.Now().UTC()
	accessExpiry := now.Add(24 * time.Hour)
	if record.link.ExpiresAt != nil && record.link.ExpiresAt.Before(accessExpiry) {
		accessExpiry = *record.link.ExpiresAt
	}
	if !accessExpiry.After(now) {
		return "", PublicShare{}, ErrUnavailable
	}
	accessToken := randomToken()
	_, err = s.db.ExecContext(ctx, `INSERT INTO share_link_access (id, share_link_id, token_hash, expires_at, created_at)
VALUES (?, ?, ?, ?, ?)`, newID("sla_"), record.link.ID, hashToken(accessToken), formatTime(accessExpiry), formatTime(now))
	if err != nil {
		return "", PublicShare{}, fmt.Errorf("create share link access: %w", err)
	}
	share, err := s.publicShare(ctx, record)
	if err != nil {
		return "", PublicShare{}, err
	}
	return accessToken, share, nil
}

func (s *Service) ListPhotos(ctx context.Context, token, accessToken string) ([]PublicPhoto, error) {
	record, err := s.authorize(ctx, token, accessToken)
	if err != nil {
		return nil, err
	}
	var rows *sql.Rows
	if record.link.ResourceType == ResourcePhoto {
		rows, err = s.db.QueryContext(ctx, `SELECT id, folder_id, filename, mime_type, size, captured_at, width, height, storage_path
FROM photos WHERE id=? AND deleted_at IS NULL`, record.link.ResourceID)
	} else {
		rows, err = s.db.QueryContext(ctx, `WITH RECURSIVE descendants(id) AS (
SELECT id FROM folders WHERE id=?
UNION ALL
SELECT f.id FROM folders f JOIN descendants d ON f.parent_id=d.id
)
SELECT p.id, p.folder_id, p.filename, p.mime_type, p.size, p.captured_at, p.width, p.height, p.storage_path
FROM photos p JOIN descendants d ON d.id=p.folder_id
WHERE p.deleted_at IS NULL ORDER BY p.captured_at DESC, p.id DESC`, record.link.ResourceID)
	}
	if err != nil {
		return nil, fmt.Errorf("list public photos: %w", err)
	}
	defer rows.Close()
	items := make([]PublicPhoto, 0)
	for rows.Next() {
		item, err := scanPublicPhoto(rows)
		if err != nil {
			return nil, fmt.Errorf("scan public photo: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read public photos: %w", err)
	}
	return items, nil
}

func (s *Service) PublicPhoto(ctx context.Context, token, accessToken, photoID string) (PublicPhoto, error) {
	record, err := s.authorize(ctx, token, accessToken)
	if err != nil {
		return PublicPhoto{}, err
	}
	var row *sql.Row
	if record.link.ResourceType == ResourcePhoto {
		if photoID != record.link.ResourceID {
			return PublicPhoto{}, ErrOutOfScope
		}
		row = s.db.QueryRowContext(ctx, `SELECT id, folder_id, filename, mime_type, size, captured_at, width, height, storage_path
FROM photos WHERE id=? AND deleted_at IS NULL`, photoID)
	} else {
		row = s.db.QueryRowContext(ctx, `WITH RECURSIVE descendants(id) AS (
SELECT id FROM folders WHERE id=?
UNION ALL
SELECT f.id FROM folders f JOIN descendants d ON f.parent_id=d.id
)
SELECT p.id, p.folder_id, p.filename, p.mime_type, p.size, p.captured_at, p.width, p.height, p.storage_path
FROM photos p JOIN descendants d ON d.id=p.folder_id
WHERE p.id=? AND p.deleted_at IS NULL`, record.link.ResourceID, photoID)
	}
	item, err := scanPublicPhoto(row)
	if errors.Is(err, sql.ErrNoRows) {
		if record.link.ResourceType == ResourcePhoto {
			return PublicPhoto{}, ErrUnavailable
		}
		return PublicPhoto{}, ErrOutOfScope
	}
	if err != nil {
		return PublicPhoto{}, fmt.Errorf("load public photo: %w", err)
	}
	return item, nil
}

func (s *Service) authorize(ctx context.Context, token, accessToken string) (linkRecord, error) {
	record, err := s.activeRecord(ctx, token)
	if err != nil {
		return linkRecord{}, err
	}
	if !record.passwordHash.Valid || record.passwordHash.String == "" {
		return record, nil
	}
	if strings.TrimSpace(accessToken) == "" {
		return linkRecord{}, ErrPasswordRequired
	}
	var count int
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM share_link_access
WHERE share_link_id=? AND token_hash=? AND expires_at>?`, record.link.ID, hashToken(accessToken), formatTime(time.Now().UTC())).Scan(&count); err != nil {
		return linkRecord{}, fmt.Errorf("check share link access: %w", err)
	}
	if count != 1 {
		return linkRecord{}, ErrPasswordRequired
	}
	return record, nil
}

type linkRecord struct {
	link         Link
	passwordHash sql.NullString
}

func (s *Service) activeRecord(ctx context.Context, token string) (linkRecord, error) {
	if strings.TrimSpace(token) == "" {
		return linkRecord{}, ErrUnavailable
	}
	var record linkRecord
	var resourceType, tokenHash string
	var passwordHash, expires, revoked sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT id, resource_type, resource_id, token_hash, password_hash, expires_at, revoked_at
FROM share_links WHERE token_hash=?`, hashToken(token)).Scan(&record.link.ID, &resourceType, &record.link.ResourceID, &tokenHash, &passwordHash, &expires, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return linkRecord{}, ErrUnavailable
	}
	if err != nil {
		return linkRecord{}, fmt.Errorf("load share link: %w", err)
	}
	if !validResourceType(ResourceType(resourceType)) || revoked.Valid {
		return linkRecord{}, ErrUnavailable
	}
	record.link.ResourceType = ResourceType(resourceType)
	record.passwordHash = passwordHash
	if expires.Valid {
		parsed, err := parseTime(expires.String)
		if err != nil {
			return linkRecord{}, ErrUnavailable
		}
		record.link.ExpiresAt = &parsed
		if !parsed.After(time.Now().UTC()) {
			return linkRecord{}, ErrUnavailable
		}
	}
	if _, err := s.resourceOwner(ctx, record.link.ResourceType, record.link.ResourceID); errors.Is(err, sql.ErrNoRows) {
		return linkRecord{}, ErrUnavailable
	} else if err != nil {
		return linkRecord{}, fmt.Errorf("check share resource: %w", err)
	}
	return record, nil
}

func (s *Service) publicShare(ctx context.Context, record linkRecord) (PublicShare, error) {
	share := PublicShare{ResourceType: record.link.ResourceType, PasswordRequired: record.passwordHash.Valid && record.passwordHash.String != "", ExpiresAt: record.link.ExpiresAt}
	if record.link.ResourceType == ResourceFolder {
		if err := s.db.QueryRowContext(ctx, "SELECT name FROM folders WHERE id=?", record.link.ResourceID).Scan(&share.Name); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return PublicShare{}, ErrUnavailable
			}
			return PublicShare{}, fmt.Errorf("load shared folder: %w", err)
		}
		share.FolderPath, _ = s.folderPath(ctx, record.link.ResourceID)
		return share, nil
	}
	if err := s.db.QueryRowContext(ctx, `SELECT p.filename, f.name FROM photos p JOIN folders f ON f.id=p.folder_id
WHERE p.id=? AND p.deleted_at IS NULL`, record.link.ResourceID).Scan(&share.Name, &share.FolderName); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return PublicShare{}, ErrUnavailable
		}
		return PublicShare{}, fmt.Errorf("load shared photo: %w", err)
	}
	share.FolderPath, _ = s.photoFolderPath(ctx, record.link.ResourceID)
	return share, nil
}

func (s *Service) resourceOwner(ctx context.Context, resourceType ResourceType, resourceID string) (string, error) {
	query := "SELECT owner_id FROM folders WHERE id=?"
	if resourceType == ResourcePhoto {
		query = "SELECT owner_id FROM photos WHERE id=? AND deleted_at IS NULL"
	}
	var owner string
	err := s.db.QueryRowContext(ctx, query, resourceID).Scan(&owner)
	return owner, err
}

func (s *Service) folderPath(ctx context.Context, folderID string) (string, error) {
	var path string
	err := s.db.QueryRowContext(ctx, `WITH RECURSIVE ancestors(id, parent_id, path) AS (
SELECT id, parent_id, name FROM folders WHERE id=?
UNION ALL
SELECT f.id, f.parent_id, f.name || ' / ' || a.path FROM folders f JOIN ancestors a ON f.id=a.parent_id
)
SELECT path FROM ancestors WHERE parent_id IS NULL LIMIT 1`, folderID).Scan(&path)
	return path, err
}

func (s *Service) photoFolderPath(ctx context.Context, photoID string) (string, error) {
	var folderID string
	if err := s.db.QueryRowContext(ctx, "SELECT folder_id FROM photos WHERE id=? AND deleted_at IS NULL", photoID).Scan(&folderID); err != nil {
		return "", err
	}
	return s.folderPath(ctx, folderID)
}

func scanPublicPhoto(row interface{ Scan(...any) error }) (PublicPhoto, error) {
	var item PublicPhoto
	var captured string
	var width, height sql.NullInt64
	if err := row.Scan(&item.ID, &item.FolderID, &item.Filename, &item.MIMEType, &item.Size, &captured, &width, &height, &item.StoragePath); err != nil {
		return PublicPhoto{}, err
	}
	var err error
	item.CapturedAt, err = parseTime(captured)
	if err != nil {
		return PublicPhoto{}, err
	}
	if width.Valid {
		item.Width = int(width.Int64)
	}
	if height.Valid {
		item.Height = int(height.Int64)
	}
	return item, nil
}

func validResourceType(resourceType ResourceType) bool {
	return resourceType == ResourcePhoto || resourceType == ResourceFolder
}

func durationValue(duration Duration) (time.Duration, bool) {
	switch duration {
	case DurationOneDay:
		return 24 * time.Hour, true
	case DurationSevenDays:
		return 7 * 24 * time.Hour, true
	case DurationForever:
		return 0, true
	default:
		return 0, false
	}
}

func newID(prefix string) string { return prefix + randomToken()[:22] }

func randomToken() string {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		panic("crypto/rand unavailable")
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func hashToken(token string) string {
	digest := sha256.Sum256([]byte(token))
	return "sha256:" + hex.EncodeToString(digest[:])
}

func formatTime(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }

func optionalTime(value *time.Time) any {
	if value == nil {
		return nil
	}
	return formatTime(*value)
}

func parseTime(value string) (time.Time, error) { return time.Parse(time.RFC3339Nano, value) }
