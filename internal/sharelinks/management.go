package sharelinks

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
)

// ManagedLink deliberately contains neither the original token nor secret hashes.
type ManagedLink struct {
	ID                string       `json:"id"`
	ResourceType      ResourceType `json:"resource_type"`
	ResourceID        string       `json:"resource_id"`
	ResourceName      string       `json:"resource_name"`
	CreatedAt         time.Time    `json:"created_at"`
	ExpiresAt         *time.Time   `json:"expires_at"`
	RevokedAt         *time.Time   `json:"revoked_at"`
	PasswordProtected bool         `json:"password_protected"`
	Status            string       `json:"status"`
}

type ManagedPage struct {
	Items      []ManagedLink `json:"items"`
	NextCursor string        `json:"next_cursor,omitempty"`
}

type ManageFilter struct {
	Status       string
	ResourceType ResourceType
	ResourceID   string
	Cursor       string
	Limit        int
}

func (s *Service) ListManaged(ctx context.Context, principal acl.Principal, filter ManageFilter) (ManagedPage, error) {
	if filter.Limit == 0 {
		filter.Limit = 30
	}
	if filter.Limit < 1 || filter.Limit > 100 {
		return ManagedPage{}, ErrInvalid
	}
	if filter.Status != "" && filter.Status != "active" && filter.Status != "expired" && filter.Status != "revoked" && filter.Status != "unavailable" {
		return ManagedPage{}, ErrInvalid
	}
	if filter.ResourceType != "" && !validResourceType(filter.ResourceType) {
		return ManagedPage{}, ErrInvalid
	}
	if filter.ResourceID != "" && filter.ResourceType == "" {
		return ManagedPage{}, ErrInvalid
	}
	cursorTime, cursorID, err := decodeManageCursor(filter.Cursor)
	if err != nil {
		return ManagedPage{}, ErrInvalid
	}
	nowKey := time.Now().UTC().Format("2006-01-02T15:04:05.000000000")
	// A surviving resource always supplies current ownership. A missing resource
	// has no authority to delegate, even when an old owner snapshot is present.
	query := fmt.Sprintf(`WITH records AS (
 SELECT sl.id, sl.resource_type, sl.resource_id,
 COALESCE(CASE WHEN sl.resource_type='photo' THEN p.filename ELSE f.name END, sl.resource_name) AS resource_name,
 sl.created_at, sl.expires_at, sl.revoked_at, sl.password_hash,
 %s AS created_key,
 CASE WHEN sl.resource_type='photo' THEN p.owner_id ELSE f.owner_id END AS current_owner,
 CASE WHEN sl.revoked_at IS NOT NULL THEN 'revoked'
      WHEN (sl.resource_type='photo' AND (p.id IS NULL OR p.deleted_at IS NOT NULL))
        OR (sl.resource_type='folder' AND f.id IS NULL) THEN 'unavailable'
      WHEN sl.expires_at IS NOT NULL AND %s<=? THEN 'expired'
      ELSE 'active' END AS status
 FROM share_links sl
 LEFT JOIN photos p ON sl.resource_type='photo' AND p.id=sl.resource_id
 LEFT JOIN folders f ON sl.resource_type='folder' AND f.id=sl.resource_id
 ) SELECT id, resource_type, resource_id, resource_name, created_at, expires_at, revoked_at, password_hash, status
 FROM records
 WHERE (?='admin' OR current_owner=?)
 AND (?='' OR resource_type=?) AND (?='' OR resource_id=?)
 AND (?='' OR created_key<? OR (created_key=? AND id<?))
 AND (?='' OR status=?)
 ORDER BY created_key DESC, id DESC LIMIT ?`, shareTimeKeySQL("sl.created_at"), shareTimeKeySQL("sl.expires_at"))
	rows, err := s.db.QueryContext(ctx, query, nowKey, string(principal.Role), principal.UserID,
		string(filter.ResourceType), string(filter.ResourceType), filter.ResourceID, filter.ResourceID,
		filter.Cursor, cursorTime, cursorTime, cursorID, filter.Status, filter.Status, filter.Limit+1)
	if err != nil {
		return ManagedPage{}, fmt.Errorf("list managed share links: %w", err)
	}
	defer rows.Close()
	page := ManagedPage{Items: []ManagedLink{}}
	for rows.Next() {
		var item ManagedLink
		var created string
		var expires, revoked, password sql.NullString
		if err := rows.Scan(&item.ID, &item.ResourceType, &item.ResourceID, &item.ResourceName, &created, &expires, &revoked, &password, &item.Status); err != nil {
			return ManagedPage{}, fmt.Errorf("scan managed share link: %w", err)
		}
		item.CreatedAt, err = parseTime(created)
		if err != nil {
			return ManagedPage{}, err
		}
		if expires.Valid {
			value, err := parseTime(expires.String)
			if err != nil {
				return ManagedPage{}, err
			}
			item.ExpiresAt = &value
		}
		if revoked.Valid {
			value, err := parseTime(revoked.String)
			if err != nil {
				return ManagedPage{}, err
			}
			item.RevokedAt = &value
		}
		item.PasswordProtected = password.Valid && password.String != ""
		page.Items = append(page.Items, item)
	}
	if err := rows.Err(); err != nil {
		return ManagedPage{}, err
	}
	if len(page.Items) > filter.Limit {
		page.Items = page.Items[:filter.Limit]
		last := page.Items[len(page.Items)-1]
		page.NextCursor = base64.RawURLEncoding.EncodeToString([]byte(formatTime(last.CreatedAt) + "\n" + last.ID))
	}
	return page, nil
}

func decodeManageCursor(cursor string) (string, string, error) {
	if cursor == "" {
		return "", "", nil
	}
	if len(cursor) > 512 {
		return "", "", ErrInvalid
	}
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return "", "", err
	}
	parts := strings.Split(string(raw), "\n")
	if len(parts) != 2 || parts[1] == "" {
		return "", "", ErrInvalid
	}
	parsed, err := parseTime(parts[0])
	if err != nil {
		return "", "", err
	}
	return parsed.UTC().Format("2006-01-02T15:04:05.000000000"), parts[1], nil
}

// shareTimeKeySQL preserves nanoseconds in the UTC timestamps written by this
// service. SQLite's julianday function rounds them to milliseconds.
func shareTimeKeySQL(column string) string {
	return fmt.Sprintf(`substr(%[1]s,1,19)||'.'||substr((CASE WHEN instr(%[1]s,'.')>0
THEN substr(%[1]s,instr(%[1]s,'.')+1,instr(%[1]s,'Z')-instr(%[1]s,'.')-1)
ELSE '' END)||'000000000',1,9)`, column)
}

func (s *Service) RevokeManaged(ctx context.Context, principal acl.Principal, id string) error {
	if strings.TrimSpace(id) == "" || len(id) > 256 {
		return ErrNotFound
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin share revoke: %w", err)
	}
	defer tx.Rollback()
	var visible int
	err = tx.QueryRowContext(ctx, `SELECT 1 FROM share_links sl
 LEFT JOIN photos p ON sl.resource_type='photo' AND p.id=sl.resource_id
 LEFT JOIN folders f ON sl.resource_type='folder' AND f.id=sl.resource_id
 WHERE sl.id=? AND (?='admin' OR (CASE WHEN sl.resource_type='photo' THEN p.owner_id ELSE f.owner_id END)=?)`, id, string(principal.Role), principal.UserID).Scan(&visible)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("authorize share revoke: %w", err)
	}
	now := formatTime(time.Now().UTC())
	if _, err := tx.ExecContext(ctx, `UPDATE share_links SET revoked_at=COALESCE(revoked_at,?), updated_at=CASE WHEN revoked_at IS NULL THEN ? ELSE updated_at END WHERE id=?`, now, now, id); err != nil {
		return fmt.Errorf("revoke share link: %w", err)
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM share_link_access WHERE share_link_id=?", id); err != nil {
		return fmt.Errorf("clear share unlocks: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit share revoke: %w", err)
	}
	return nil
}

func parseManageLimit(value string) (int, error) {
	if value == "" {
		return 30, nil
	}
	return strconv.Atoi(value)
}
