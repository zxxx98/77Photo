package users

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path"
	"strings"
)

type storageMove struct{ from, to string }

// moveUserStorage moves every top-level entry of users/<fromID> into
// users/<toID> on disk and rewrites the matching folder and photo paths in tx.
// Name clashes in the target root get a " (2)", " (3)", … suffix. On error the
// disk moves already made are reverted; on success the caller must revert them
// with undoMoves if the transaction is not committed.
func (s *Service) moveUserStorage(ctx context.Context, tx *sql.Tx, fromID, toID, now string) (moves []storageMove, err error) {
	defer func() {
		if err != nil {
			s.undoMoves(moves)
			moves = nil
		}
	}()
	sourceRoot, err := s.storage.UserRoot(fromID)
	if err != nil {
		return nil, fmt.Errorf("resolve transferred user root: %w", err)
	}
	entries, err := os.ReadDir(sourceRoot)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("list transferred user root: %w", err)
	}
	if err := s.storage.EnsureUserRoot(toID); err != nil {
		return nil, fmt.Errorf("prepare transfer target root: %w", err)
	}
	for _, entry := range entries {
		from := path.Join("users", fromID, entry.Name())
		name, to, err := s.moveToFreeName(ctx, tx, from, toID, entry.Name(), entry.IsDir())
		if err != nil {
			return moves, err
		}
		moves = append(moves, storageMove{from: from, to: to})
		if err := rewritePrefix(ctx, tx, "folders", from, to, now); err != nil {
			return moves, err
		}
		if err := rewritePrefix(ctx, tx, "photos", from, to, now); err != nil {
			return moves, err
		}
		if name != entry.Name() {
			if _, err := tx.ExecContext(ctx, "UPDATE folders SET name=? WHERE storage_path=?", name, to); err != nil {
				return moves, fmt.Errorf("rename transferred folder: %w", err)
			}
		}
	}
	return moves, nil
}

func (s *Service) moveToFreeName(ctx context.Context, tx *sql.Tx, from, toID, name string, isDir bool) (string, string, error) {
	for attempt := 1; attempt <= 1000; attempt++ {
		candidate := suffixedName(name, attempt, isDir)
		to := path.Join("users", toID, candidate)
		taken, err := pathTaken(ctx, tx, to, candidate, isDir)
		if err != nil {
			return "", "", err
		}
		if taken {
			continue
		}
		err = s.storage.Rename(from, to)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return "", "", fmt.Errorf("move %s: %w", from, err)
		}
		return candidate, to, nil
	}
	return "", "", fmt.Errorf("move %s: no free name in target root", from)
}

// pathTaken reports whether the index already uses target (or anything below
// it), or, for directories, whether a top-level folder already has the name.
// Top-level folder names are unique across the library.
func pathTaken(ctx context.Context, tx *sql.Tx, target, name string, isDir bool) (bool, error) {
	var count int
	query := `SELECT
 (SELECT count(*) FROM folders WHERE storage_path=? OR substr(storage_path, 1, length(?)+1)=?||'/') +
 (SELECT count(*) FROM photos WHERE storage_path=? OR substr(storage_path, 1, length(?)+1)=?||'/')`
	if err := tx.QueryRowContext(ctx, query, target, target, target, target, target, target).Scan(&count); err != nil {
		return false, fmt.Errorf("inspect transfer target: %w", err)
	}
	if count == 0 && isDir {
		if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM folders WHERE parent_id IS NULL AND name=? COLLATE NOCASE", name).Scan(&count); err != nil {
			return false, fmt.Errorf("inspect transfer target name: %w", err)
		}
	}
	return count > 0, nil
}

func rewritePrefix(ctx context.Context, tx *sql.Tx, table, from, to, now string) error {
	// substr comparisons avoid LIKE, whose wildcards may appear in names.
	_, err := tx.ExecContext(ctx, "UPDATE "+table+` SET storage_path = ? || substr(storage_path, length(?)+1), updated_at=?
WHERE storage_path=? OR substr(storage_path, 1, length(?)+1)=?||'/'`, to, from, now, from, from, from)
	if err != nil {
		return fmt.Errorf("rewrite transferred %s paths: %w", table, err)
	}
	return nil
}

func (s *Service) undoMoves(moves []storageMove) {
	for i := len(moves) - 1; i >= 0; i-- {
		_ = s.storage.Rename(moves[i].to, moves[i].from)
	}
}

func suffixedName(name string, attempt int, isDir bool) string {
	if attempt == 1 {
		return name
	}
	extension := ""
	if !isDir {
		extension = path.Ext(name)
	}
	return fmt.Sprintf("%s (%d)%s", strings.TrimSuffix(name, extension), attempt, extension)
}
