package shares

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
)

var (
	ErrForbidden = errors.New("share access forbidden")
	ErrNotFound  = errors.New("share not found")
	ErrConflict  = errors.New("folder is already shared with this user")
	ErrInvalid   = errors.New("share request is invalid")
)

type Service struct{ db *sql.DB }

type CreateInput struct {
	FolderID   string         `json:"folder_id"`
	UserID     string         `json:"user_id"`
	Permission acl.Permission `json:"permission"`
}

type Share struct {
	ID           string         `json:"id"`
	ResourceType string         `json:"resource_type"`
	ResourceID   string         `json:"resource_id"`
	UserID       string         `json:"user_id"`
	Permission   acl.Permission `json:"permission"`
	CreatedAt    time.Time      `json:"created_at"`
}

func NewService(db *sql.DB) *Service { return &Service{db: db} }

func (s *Service) List(ctx context.Context, principal acl.Principal) ([]Share, error) {
	query := `SELECT s.id, s.resource_type, s.resource_id, s.user_id, s.permission, s.created_at FROM shares s`
	args := []any{}
	if principal.Role != acl.RoleAdmin {
		query += ` JOIN folders f ON f.id=s.resource_id WHERE s.user_id=? OR f.owner_id=?`
		args = append(args, principal.UserID, principal.UserID)
	}
	query += " ORDER BY s.created_at DESC, s.id DESC"
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Share{}
	for rows.Next() {
		var item Share
		var created string
		if err := rows.Scan(&item.ID, &item.ResourceType, &item.ResourceID, &item.UserID, &item.Permission, &created); err != nil {
			return nil, err
		}
		item.CreatedAt, err = time.Parse(time.RFC3339Nano, created)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Service) Create(ctx context.Context, principal acl.Principal, input CreateInput) (Share, error) {
	if input.Permission != acl.PermissionRead && input.Permission != acl.PermissionWrite {
		return Share{}, ErrInvalid
	}
	var owner string
	if err := s.db.QueryRowContext(ctx, "SELECT owner_id FROM folders WHERE id=?", input.FolderID).Scan(&owner); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Share{}, ErrNotFound
		}
		return Share{}, err
	}
	if !acl.CanManageShare(principal, owner) {
		return Share{}, ErrForbidden
	}
	var active int
	if err := s.db.QueryRowContext(ctx, "SELECT count(*) FROM users WHERE id=? AND is_active=1 AND deleted_at IS NULL", input.UserID).Scan(&active); err != nil {
		return Share{}, err
	}
	if active != 1 || input.UserID == owner {
		return Share{}, ErrInvalid
	}
	id := newShareID()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := s.db.ExecContext(ctx, `INSERT INTO shares (id, resource_type, resource_id, user_id, permission, created_at) VALUES (?, 'folder', ?, ?, ?, ?)`, id, input.FolderID, input.UserID, input.Permission, now); err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return Share{}, ErrConflict
		}
		return Share{}, err
	}
	_, _ = s.db.ExecContext(ctx, "UPDATE folders SET is_shared=1, updated_at=? WHERE id=?", now, input.FolderID)
	return Share{ID: id, ResourceType: "folder", ResourceID: input.FolderID, UserID: input.UserID, Permission: input.Permission, CreatedAt: parseTime(now)}, nil
}

func (s *Service) Revoke(ctx context.Context, principal acl.Principal, id string) error {
	var owner, folderID string
	if err := s.db.QueryRowContext(ctx, "SELECT f.owner_id, s.resource_id FROM shares s JOIN folders f ON f.id=s.resource_id WHERE s.id=?", id).Scan(&owner, &folderID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if !acl.CanManageShare(principal, owner) {
		return ErrForbidden
	}
	if _, err := s.db.ExecContext(ctx, "DELETE FROM shares WHERE id=?", id); err != nil {
		return err
	}
	_, _ = s.db.ExecContext(ctx, "UPDATE folders SET is_shared=EXISTS(SELECT 1 FROM shares WHERE resource_type='folder' AND resource_id=?), updated_at=? WHERE id=?", folderID, time.Now().UTC().Format(time.RFC3339Nano), folderID)
	return nil
}

func newShareID() string {
	var raw [12]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "s_" + fmt.Sprint(time.Now().UnixNano())
	}
	return "s_" + hex.EncodeToString(raw[:])
}

func parseTime(value string) time.Time {
	parsed, _ := time.Parse(time.RFC3339Nano, value)
	return parsed
}
