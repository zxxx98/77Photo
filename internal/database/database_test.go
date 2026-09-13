package database

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"testing/fstest"
)

func TestOpenInitializesSchemaAndSQLitePragmas(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "77photo.db")
	db, err := Open(ctx, dbPath)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer db.Close()

	var journalMode string
	if err := db.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&journalMode); err != nil {
		t.Fatal(err)
	}
	if journalMode != "wal" {
		t.Fatalf("journal_mode = %q, want wal", journalMode)
	}
	var foreignKeys int
	if err := db.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&foreignKeys); err != nil {
		t.Fatal(err)
	}
	if foreignKeys != 1 {
		t.Fatalf("foreign_keys = %d, want 1", foreignKeys)
	}

	for _, table := range []string{"users", "folders", "photos", "shares", "sessions", "share_links", "share_link_access", "schema_migrations"} {
		var count int
		if err := db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?", table).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Fatalf("table %s count = %d, want 1", table, count)
		}
	}
	var migrationCount int
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM schema_migrations").Scan(&migrationCount); err != nil {
		t.Fatal(err)
	}
	if migrationCount != 3 {
		t.Fatalf("schema migration count = %d, want 3", migrationCount)
	}
}

func TestOpenIsIdempotentAcrossRestart(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "77photo.db")
	db, err := Open(ctx, dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
VALUES ('u-restart', 'restart', 'hash', 'user', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	db, err = Open(ctx, dbPath)
	if err != nil {
		t.Fatalf("reopen error = %v", err)
	}
	defer db.Close()
	var username string
	if err := db.QueryRowContext(ctx, "SELECT username FROM users WHERE id='u-restart'").Scan(&username); err != nil {
		t.Fatal(err)
	}
	if username != "restart" {
		t.Fatalf("username = %q", username)
	}
	var migrationCount int
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM schema_migrations").Scan(&migrationCount); err != nil {
		t.Fatal(err)
	}
	if migrationCount != 3 {
		t.Fatalf("schema migration count = %d, want 3", migrationCount)
	}
}

func TestForeignKeysRejectOrphanRows(t *testing.T) {
	db, err := Open(context.Background(), filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	_, err = db.Exec(`INSERT INTO folders (id, owner_id, name, storage_path, created_at, updated_at)
VALUES ('folder-orphan', 'missing-user', 'private', 'users/missing-user', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`)
	if err == nil {
		t.Fatal("orphan folder insert succeeded, want foreign key violation")
	}
}

func TestPhotoSchemaContainsMetadataAndScanFields(t *testing.T) {
	db, err := Open(context.Background(), filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rows, err := db.Query("PRAGMA table_info(photos)")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	wanted := map[string]bool{"captured_at": false, "captured_at_source": false, "checksum": false, "source_revision": false, "scan_status": false}
	for rows.Next() {
		var cid int
		var name, columnType string
		var notNull, primaryKey int
		var defaultValue any
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			t.Fatal(err)
		}
		if _, ok := wanted[name]; ok {
			wanted[name] = true
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	for name, found := range wanted {
		if !found {
			t.Errorf("photos column %q missing", name)
		}
	}
	var csrfColumns int
	if err := db.QueryRow("SELECT count(*) FROM pragma_table_info('sessions') WHERE name='csrf_token_hash'").Scan(&csrfColumns); err != nil {
		t.Fatal(err)
	}
	if csrfColumns != 1 {
		t.Fatal("sessions csrf_token_hash column missing")
	}
}

func TestConcurrentReadsAndWritesAreSafe(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.ExecContext(ctx, `INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
VALUES ('u-concurrent', 'concurrent', 'hash', 'user', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}

	const writes = 12
	var wg sync.WaitGroup
	errCh := make(chan error, writes*2)
	for i := 0; i < writes; i++ {
		wg.Add(2)
		go func(i int) {
			defer wg.Done()
			_, err := db.ExecContext(ctx, `INSERT INTO folders (id, owner_id, name, storage_path, created_at, updated_at)
VALUES (?, 'u-concurrent', ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, fmt.Sprintf("f-%d", i), fmt.Sprintf("folder-%d", i), fmt.Sprintf("users/u-concurrent/folder-%d", i))
			if err != nil {
				errCh <- err
			}
		}(i)
		go func() {
			defer wg.Done()
			var count int
			if err := db.QueryRowContext(ctx, "SELECT count(*) FROM users").Scan(&count); err != nil {
				errCh <- err
			}
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Errorf("concurrent operation error: %v", err)
	}
	var folderCount int
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM folders WHERE owner_id='u-concurrent'").Scan(&folderCount); err != nil {
		t.Fatal(err)
	}
	if folderCount != writes {
		t.Fatalf("folder count = %d, want %d", folderCount, writes)
	}
}

func TestFailedMigrationRollsBackAndIsNotRecorded(t *testing.T) {
	ctx := context.Background()
	db, err := sqlOpenForMigrationTest(t)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	source := fstest.MapFS{
		"001_broken.sql": &fstest.MapFile{Data: []byte("CREATE TABLE broken (;")},
	}
	if err := MigrateFS(ctx, db, source); err == nil {
		t.Fatal("MigrateFS() error = nil, want migration failure")
	}
	var count int
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM schema_migrations").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("recorded migration count = %d, want 0", count)
	}
	var broken int
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE name='broken'").Scan(&broken); err != nil {
		t.Fatal(err)
	}
	if broken != 0 {
		t.Fatal("failed migration left a broken table behind")
	}
}

func sqlOpenForMigrationTest(t *testing.T) (*sql.DB, error) {
	t.Helper()
	return sql.Open(driverName, filepath.Join(t.TempDir(), "migration.db"))
}
