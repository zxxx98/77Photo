package photos

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
)

var (
	ErrInvalidCursor = errors.New("invalid photo cursor")
	ErrCursorExpired = errors.New("photo cursor expired")
	ErrInvalidFilter = errors.New("invalid photo filter")
)

type ListFilter struct {
	FolderID *string
	From     *time.Time
	To       *time.Time
	BBox     *BBox
	Cursor   string
	Limit    int
}

type PhotoPage struct {
	Items      []Photo `json:"items"`
	NextCursor *string `json:"next_cursor"`
}

type photoCursor struct {
	Version      int    `json:"v"`
	UserID       string `json:"u"`
	Role         string `json:"r"`
	FolderID     string `json:"f,omitempty"`
	From         string `json:"from,omitempty"`
	To           string `json:"to,omitempty"`
	BBox         string `json:"b,omitempty"`
	LastCaptured string `json:"c"`
	LastID       string `json:"i"`
	ExpiresAt    int64  `json:"e"`
}

func (s *Service) List(ctx context.Context, principal acl.Principal, filter ListFilter) (PhotoPage, error) {
	limit := filter.Limit
	if limit == 0 {
		limit = 50
	}
	if limit < 1 || limit > 100 {
		return PhotoPage{}, ErrInvalidFilter
	}
	if filter.From != nil && filter.To != nil && !filter.From.Before(*filter.To) {
		return PhotoPage{}, ErrInvalidFilter
	}
	folderID := ""
	if filter.FolderID != nil {
		folderID = strings.TrimSpace(*filter.FolderID)
		if folderID == "" {
			return PhotoPage{}, ErrInvalidFilter
		}
		var owner string
		if err := s.db.QueryRowContext(ctx, "SELECT owner_id FROM folders WHERE id=?", folderID).Scan(&owner); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return PhotoPage{}, ErrNotFound
			}
			return PhotoPage{}, err
		}
		if !s.canReadFolder(ctx, principal, folderID, owner) {
			return PhotoPage{}, ErrForbidden
		}
	}
	fromValue, toValue := "", ""
	if filter.From != nil {
		fromValue = filter.From.UTC().Format(time.RFC3339Nano)
	}
	if filter.To != nil {
		toValue = filter.To.UTC().Format(time.RFC3339Nano)
	}
	bboxValue := ""
	if filter.BBox != nil {
		if !filter.BBox.Valid() {
			return PhotoPage{}, ErrInvalidFilter
		}
		bboxValue = filter.BBox.String()
	}
	lastCaptured, lastID := "", ""
	if filter.Cursor != "" {
		cursor, err := s.decodeCursor(filter.Cursor)
		if err != nil {
			return PhotoPage{}, err
		}
		if cursor.UserID != principal.UserID || cursor.Role != string(principal.Role) || cursor.FolderID != folderID || cursor.From != fromValue || cursor.To != toValue || cursor.BBox != bboxValue {
			return PhotoPage{}, ErrInvalidCursor
		}
		lastCaptured, lastID = cursor.LastCaptured, cursor.LastID
	}

	query := `SELECT p.id, p.owner_id, p.folder_id, p.storage_path, p.filename, p.mime_type, p.size, p.width, p.height, p.checksum, p.captured_at, p.captured_at_source, p.file_created_at, p.indexed_at, p.source_revision, p.scan_status, p.camera_make, p.camera_model, p.orientation, p.focal_length, p.aperture, p.iso, p.gps_latitude, p.gps_longitude, p.created_at, p.updated_at FROM photos p`
	args := make([]any, 0, 10)
	where := []string{"p.deleted_at IS NULL", "p.scan_status='indexed'"}
	if folderID != "" {
		query += ` JOIN (WITH RECURSIVE descendants(id) AS (SELECT ? UNION ALL SELECT f.id FROM folders f JOIN descendants d ON f.parent_id=d.id) SELECT id FROM descendants) d ON d.id=p.folder_id`
		args = append(args, folderID)
	}
	appendVisibilityPredicate(&where, &args, principal, s.authorizer != nil)
	if fromValue != "" {
		where = append(where, "p.captured_at>=?")
		args = append(args, fromValue)
	}
	if toValue != "" {
		where = append(where, "p.captured_at<?")
		args = append(args, toValue)
	}
	appendBBoxPredicate(&where, &args, filter.BBox)
	if lastCaptured != "" {
		where = append(where, "(p.captured_at<? OR (p.captured_at=? AND p.id<?))")
		args = append(args, lastCaptured, lastCaptured, lastID)
	}
	query += " WHERE " + strings.Join(where, " AND ") + " ORDER BY p.captured_at DESC, p.id DESC LIMIT ?"
	args = append(args, limit+1)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return PhotoPage{}, fmt.Errorf("list photos: %w", err)
	}
	defer rows.Close()
	items := make([]Photo, 0, limit)
	for rows.Next() {
		photo, scanErr := scanPhoto(rows)
		if scanErr != nil {
			return PhotoPage{}, scanErr
		}
		// Visibility is part of the SQL predicate above. Keeping the filter in
		// the query avoids issuing an ACL lookup while the SQLite result set is
		// still open (the service intentionally uses one pooled connection).
		if len(items) < limit {
			items = append(items, photo)
		}
	}
	if err := rows.Err(); err != nil {
		return PhotoPage{}, err
	}
	page := PhotoPage{Items: items}
	if len(items) == limit {
		// A full page only gets a cursor when there is another row. Re-run a
		// bounded existence check using the final tuple to avoid emitting a
		// cursor at the end of an exact-size result set.
		last := items[len(items)-1]
		if hasMore, checkErr := s.hasPhotoAfter(ctx, principal, folderID, fromValue, toValue, filter.BBox, last.CapturedAt, last.ID); checkErr != nil {
			return PhotoPage{}, checkErr
		} else if hasMore {
			cursor := s.encodeCursor(photoCursor{Version: 1, UserID: principal.UserID, Role: string(principal.Role), FolderID: folderID, From: fromValue, To: toValue, BBox: bboxValue, LastCaptured: last.CapturedAt.UTC().Format(time.RFC3339Nano), LastID: last.ID, ExpiresAt: time.Now().Add(s.cursorTTL).Unix()})
			page.NextCursor = &cursor
		}
	}
	return page, nil
}

func (s *Service) hasPhotoAfter(ctx context.Context, principal acl.Principal, folderID, fromValue, toValue string, box *BBox, captured time.Time, id string) (bool, error) {
	query := "SELECT 1 FROM photos p"
	args := make([]any, 0, 10)
	where := []string{"p.deleted_at IS NULL", "p.scan_status='indexed'", "(p.captured_at<? OR (p.captured_at=? AND p.id<?))"}
	args = append(args, captured.UTC().Format(time.RFC3339Nano), captured.UTC().Format(time.RFC3339Nano), id)
	if folderID != "" {
		query += ` JOIN (WITH RECURSIVE descendants(id) AS (SELECT ? UNION ALL SELECT f.id FROM folders f JOIN descendants d ON f.parent_id=d.id) SELECT id FROM descendants) d ON d.id=p.folder_id`
		args = append([]any{folderID}, args...)
	}
	appendVisibilityPredicate(&where, &args, principal, s.authorizer != nil)
	if fromValue != "" {
		where = append(where, "p.captured_at>=?")
		args = append(args, fromValue)
	}
	if toValue != "" {
		where = append(where, "p.captured_at<?")
		args = append(args, toValue)
	}
	appendBBoxPredicate(&where, &args, box)
	query += " WHERE " + strings.Join(where, " AND ") + " LIMIT 1"
	var one int
	err := s.db.QueryRowContext(ctx, query, args...).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// appendVisibilityPredicate keeps filtering in SQLite so cursor pagination is
// based on the visible stream. Without this predicate, a page containing many
// photos outside a member's ACL could end early and silently skip later shared
// photos.
func appendVisibilityPredicate(where *[]string, args *[]any, principal acl.Principal, withShares bool) {
	if principal.Role == acl.RoleAdmin {
		return
	}
	if !withShares {
		*where = append(*where, "p.owner_id=?")
		*args = append(*args, principal.UserID)
		return
	}
	*where = append(*where, `(p.owner_id=? OR EXISTS (
WITH RECURSIVE ancestors(id) AS (
    SELECT p.folder_id
    UNION ALL
    SELECT f.parent_id FROM folders f JOIN ancestors a ON f.id=a.id WHERE f.parent_id IS NOT NULL
)
SELECT 1 FROM shares s JOIN ancestors a ON a.id=s.resource_id
WHERE s.resource_type='folder' AND s.user_id=?
))`)
	*args = append(*args, principal.UserID, principal.UserID)
}

func (s *Service) encodeCursor(cursor photoCursor) string {
	payload, _ := json.Marshal(cursor)
	mac := hmac.New(sha256.New, s.cursorKey[:])
	_, _ = mac.Write(payload)
	return base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (s *Service) decodeCursor(value string) (photoCursor, error) {
	parts := strings.Split(value, ".")
	if len(parts) != 2 {
		return photoCursor{}, ErrInvalidCursor
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return photoCursor{}, ErrInvalidCursor
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return photoCursor{}, ErrInvalidCursor
	}
	mac := hmac.New(sha256.New, s.cursorKey[:])
	_, _ = mac.Write(payload)
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return photoCursor{}, ErrInvalidCursor
	}
	var cursor photoCursor
	if err := json.Unmarshal(payload, &cursor); err != nil || cursor.Version != 1 || cursor.LastCaptured == "" || cursor.LastID == "" {
		return photoCursor{}, ErrInvalidCursor
	}
	if cursor.ExpiresAt <= time.Now().Unix() {
		return photoCursor{}, ErrCursorExpired
	}
	return cursor, nil
}
