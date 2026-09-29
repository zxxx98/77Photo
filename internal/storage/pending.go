package storage

import (
	"context"
	"database/sql"
	"errors"
)

var ErrRecoveryRequired = errors.New("a file operation needs recovery before further changes")

func CheckPendingTrash(ctx context.Context, db *sql.DB) error {
	var count int
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM trash_items WHERE state!='trashed'").Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return ErrRecoveryRequired
	}
	return nil
}
