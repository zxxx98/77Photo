package database

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/zxxx98/77Photo/migrations"
	_ "modernc.org/sqlite"
)

const (
	driverName      = "sqlite"
	busyTimeoutMS   = 5000
	maxOpenSQLiteDB = 1
)

// Open opens a SQLite database, applies all pending embedded migrations and
// configures the connection for WAL-backed, foreign-key-enforced operation.
// The database is not returned if configuration or migration fails.
func Open(ctx context.Context, path string) (*sql.DB, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("database path must not be empty")
	}
	db, err := sql.Open(driverName, filepath.Clean(path))
	if err != nil {
		return nil, fmt.Errorf("open sqlite database: %w", err)
	}
	// SQLite permits one writer. A single pooled connection avoids per-
	// connection PRAGMA differences and is appropriate for the low-resource V1
	// service; WAL still lets readers observe committed snapshots safely.
	db.SetMaxOpenConns(maxOpenSQLiteDB)
	db.SetMaxIdleConns(maxOpenSQLiteDB)
	if err := configure(ctx, db); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := Migrate(ctx, db); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

func configure(ctx context.Context, db *sql.DB) error {
	for _, statement := range []string{
		"PRAGMA foreign_keys = ON",
		"PRAGMA journal_mode = WAL",
		fmt.Sprintf("PRAGMA busy_timeout = %d", busyTimeoutMS),
		"PRAGMA synchronous = NORMAL",
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("configure sqlite (%s): %w", statement, err)
		}
	}
	return nil
}

// Migrate applies embedded schema files exactly once in numeric order.
func Migrate(ctx context.Context, db *sql.DB) error {
	return MigrateFS(ctx, db, migrations.FS)
}

// MigrateFS is also used by migration tests to prove failed migrations roll
// back without recording a version. Production callers should use Migrate.
func MigrateFS(ctx context.Context, db *sql.DB, source fs.FS) error {
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
    )`); err != nil {
		return fmt.Errorf("create migration table: %w", err)
	}
	entries, err := fs.Glob(source, "*.sql")
	if err != nil {
		return fmt.Errorf("list migrations: %w", err)
	}
	migrationsInOrder := make([]migration, 0, len(entries))
	for _, name := range entries {
		version, err := migrationVersion(name)
		if err != nil {
			return err
		}
		sqlBytes, err := fs.ReadFile(source, name)
		if err != nil {
			return fmt.Errorf("read migration %q: %w", name, err)
		}
		migrationsInOrder = append(migrationsInOrder, migration{version: version, name: name, sql: string(sqlBytes)})
	}
	sort.Slice(migrationsInOrder, func(i, j int) bool { return migrationsInOrder[i].version < migrationsInOrder[j].version })

	rows, err := db.QueryContext(ctx, "SELECT version FROM schema_migrations")
	if err != nil {
		return fmt.Errorf("read migration history: %w", err)
	}
	applied := make(map[int]struct{})
	for rows.Next() {
		var version int
		if err := rows.Scan(&version); err != nil {
			_ = rows.Close()
			return fmt.Errorf("scan migration history: %w", err)
		}
		applied[version] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return fmt.Errorf("read migration history: %w", err)
	}
	_ = rows.Close()

	pending := make([]migration, 0, len(migrationsInOrder))
	for _, migration := range migrationsInOrder {
		if _, ok := applied[migration.version]; !ok {
			pending = append(pending, migration)
		}
	}
	if len(pending) == 0 {
		return nil
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin migration transaction: %w", err)
	}
	for _, migration := range pending {
		if _, err := tx.ExecContext(ctx, migration.sql); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("apply migration %03d (%s): %w", migration.version, migration.name, err)
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO schema_migrations (version, applied_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))", migration.version); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("record migration %03d: %w", migration.version, err)
		}
	}
	if err := tx.Commit(); err != nil {
		_ = tx.Rollback()
		return fmt.Errorf("commit migrations: %w", err)
	}
	return nil
}

type migration struct {
	version int
	name    string
	sql     string
}

func migrationVersion(name string) (int, error) {
	base := filepath.Base(name)
	separator := strings.IndexByte(base, '_')
	if separator <= 0 {
		return 0, fmt.Errorf("invalid migration filename %q", name)
	}
	version, err := strconv.Atoi(base[:separator])
	if err != nil || version < 1 {
		return 0, fmt.Errorf("invalid migration version in %q", name)
	}
	return version, nil
}
