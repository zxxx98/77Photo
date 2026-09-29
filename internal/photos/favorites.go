package photos

import (
	"context"
	"strings"

	"github.com/zxxx98/77Photo/internal/acl"
)

// SetFavorite is idempotent. The insert checks current visibility in the same
// statement, so a concurrent share revocation cannot create a new favorite.
func (s *Service) SetFavorite(ctx context.Context, principal acl.Principal, photoID string, favorite bool) error {
	if !favorite {
		_, err := s.db.ExecContext(ctx, "DELETE FROM photo_favorites WHERE user_id=? AND photo_id=?", principal.UserID, photoID)
		return err
	}
	where := []string{"p.id=?", "p.deleted_at IS NULL", "p.scan_status='indexed'"}
	args := []any{photoID}
	appendVisibilityPredicate(&where, &args, principal, s.authorizer != nil)
	query := "INSERT INTO photo_favorites (user_id, photo_id, created_at) SELECT ?, p.id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM photos p WHERE " + strings.Join(where, " AND ") + " ON CONFLICT(user_id, photo_id) DO NOTHING"
	args = append([]any{principal.UserID}, args...)
	result, err := s.db.ExecContext(ctx, query, args...)
	if err != nil {
		return err
	}
	if count, _ := result.RowsAffected(); count != 0 {
		return nil
	}
	var exists bool
	if err := s.db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM photos WHERE id=? AND deleted_at IS NULL AND scan_status='indexed')", photoID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	// An existing favorite also makes the insert a no-op. Check visibility
	// before returning success, including when access changed since insertion.
	_, err = s.Get(ctx, principal, photoID)
	return err
}
