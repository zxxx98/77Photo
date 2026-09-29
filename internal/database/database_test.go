package database

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"

	"github.com/zxxx98/77Photo/migrations"
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
	var synchronous int
	if err := db.QueryRowContext(ctx, "PRAGMA synchronous").Scan(&synchronous); err != nil || synchronous != 2 {
		t.Fatalf("journal durability = %d, err %v; want FULL", synchronous, err)
	}
	var foreignKeys int
	if err := db.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&foreignKeys); err != nil {
		t.Fatal(err)
	}
	if foreignKeys != 1 {
		t.Fatalf("foreign_keys = %d, want 1", foreignKeys)
	}

	for _, table := range []string{
		"users", "folders", "photos", "shares", "sessions",
		"share_links", "share_link_access", "mobile_devices", "mobile_tokens",
		"trash_items", "photo_motion_sources", "photo_favorites", "server_identity", "schema_migrations", "face_profile", "face_jobs", "face_items", "face_analyses", "people", "faces", "face_exclusions",
	} {
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
	if migrationCount != 13 {
		t.Fatalf("schema migration count = %d, want 13", migrationCount)
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
	if migrationCount != 13 {
		t.Fatalf("schema migration count = %d, want 13", migrationCount)
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

func TestPhotoScanStatusAllowsPairedCompanions(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.ExecContext(ctx, "INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES ('u-paired', 'paired-user', 'hash', 'user', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO folders (id, owner_id, name, storage_path, created_at, updated_at) VALUES ('f-paired', 'u-paired', 'photos', 'users/u-paired/photos', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"); err != nil {
		t.Fatal(err)
	}
	checksum := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if _, err := db.ExecContext(ctx, "INSERT INTO photos (id, owner_id, folder_id, storage_path, filename, mime_type, size, checksum, captured_at, captured_at_source, indexed_at, source_revision, scan_status, created_at, updated_at) VALUES ('p-paired', 'u-paired', 'f-paired', 'users/u-paired/photos/live.mp4', 'live.mp4', 'video/mp4', 16, ?, '2026-01-01T00:00:00Z', 'file_mtime', '2026-01-01T00:00:00Z', ?, 'paired', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", checksum, checksum); err != nil {
		t.Fatalf("insert paired photo row: %v", err)
	}
	var status string
	if err := db.QueryRowContext(ctx, "SELECT scan_status FROM photos WHERE id='p-paired'").Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "paired" {
		t.Fatalf("scan_status = %q, want paired", status)
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

func TestMigrationFreesUsernamesOfExistingTombstones(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open(driverName, filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if err := configure(ctx, db); err != nil {
		t.Fatal(err)
	}
	before := fstest.MapFS{}
	entries, err := fs.Glob(migrations.FS, "*.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range entries {
		if version, _ := migrationVersion(name); version >= 6 {
			continue
		}
		data, err := fs.ReadFile(migrations.FS, name)
		if err != nil {
			t.Fatal(err)
		}
		before[name] = &fstest.MapFile{Data: data}
	}
	if err := MigrateFS(ctx, db, before); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO users (id, username, password_hash, role, is_active, deleted_at, created_at, updated_at) VALUES
('u_gone', 'alice', 'hash', 'user', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
('u_live', 'bob', 'hash', 'user', 1, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	var displayName string
	if err := db.QueryRowContext(ctx, "SELECT deleted_username FROM users WHERE id='u_gone'").Scan(&displayName); err != nil || displayName != "alice" {
		t.Fatalf("deleted_username = %q, %v", displayName, err)
	}
	var bob string
	if err := db.QueryRowContext(ctx, "SELECT username FROM users WHERE id='u_live'").Scan(&bob); err != nil || bob != "bob" {
		t.Fatalf("active username changed to %q, %v", bob, err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES ('u_new', 'Alice', 'hash', 'user', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')`); err != nil {
		t.Fatalf("reusing the deleted username failed: %v", err)
	}
}

func TestUpgradeNineToTrashPreservesData(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "upgrade.db")
	db, err := sql.Open(driverName, path)
	if err != nil {
		t.Fatal(err)
	}
	old := fstest.MapFS{}
	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() >= "010" {
			continue
		}
		data, err := fs.ReadFile(migrations.FS, entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		old[entry.Name()] = &fstest.MapFile{Data: data}
	}
	if err := MigrateFS(ctx, db, old); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO users(id,username,password_hash,role,created_at,updated_at) VALUES('upgrade-owner','upgrade','hash','user','2026-01-01','2026-01-01')`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var owner string
	if err := db.QueryRow("SELECT username FROM users WHERE id='upgrade-owner'").Scan(&owner); err != nil || owner != "upgrade" {
		t.Fatalf("owner lost: %s %v", owner, err)
	}
	var integrity string
	if err := db.QueryRow("PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
		t.Fatalf("integrity: %s %v", integrity, err)
	}
	var count int
	if err := db.QueryRow("SELECT count(*) FROM trash_items").Scan(&count); err != nil || count != 0 {
		t.Fatalf("trash upgrade: %d %v", count, err)
	}
}

func TestUpgradeFromPreviousSchemaBackfillsShareManagement(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open(driverName, filepath.Join(t.TempDir(), "old.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if err := configure(ctx, db); err != nil {
		t.Fatal(err)
	}
	old := fstest.MapFS{}
	for version := 1; version <= 10; version++ {
		name := fmt.Sprintf("%03d", version)
		entries, err := fs.Glob(migrations.FS, name+"_*.sql")
		if err != nil || len(entries) != 1 {
			t.Fatalf("old migration %s: %v %+v", name, err, entries)
		}
		data, err := fs.ReadFile(migrations.FS, entries[0])
		if err != nil {
			t.Fatal(err)
		}
		old[entries[0]] = &fstest.MapFile{Data: data}
	}
	if err := MigrateFS(ctx, db, old); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO users(id,username,password_hash,role,is_active,created_at,updated_at) VALUES('u_old','old','hash','user',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO folders(id,owner_id,name,storage_path,created_at,updated_at) VALUES('f_old','u_old','Holiday','users/u_old/Holiday','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO share_links(id,resource_type,resource_id,token_hash,created_at,updated_at) VALUES('sl_old','folder','f_old','old-hash','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO photos(id,owner_id,folder_id,storage_path,filename,mime_type,size,checksum,captured_at,captured_at_source,indexed_at,source_revision,created_at,updated_at)
VALUES('p_old','u_old','f_old','users/u_old/Holiday/photo.jpg','photo.jpg','image/jpeg',1,?,'2026-01-01T00:00:00Z','file_mtime','2026-01-01T00:00:00Z',?,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, strings.Repeat("a", 64), strings.Repeat("b", 64)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO share_links(id,resource_type,resource_id,token_hash,created_at,updated_at) VALUES('sl_photo','photo','p_old','photo-hash','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	var owner, name string
	if err := db.QueryRowContext(ctx, "SELECT owner_id,resource_name FROM share_links WHERE id='sl_old'").Scan(&owner, &name); err != nil {
		t.Fatal(err)
	}
	if owner != "u_old" || name != "Holiday" {
		t.Fatalf("backfill owner=%q name=%q", owner, name)
	}
	if err := db.QueryRowContext(ctx, "SELECT owner_id,resource_name FROM share_links WHERE id='sl_photo'").Scan(&owner, &name); err != nil || owner != "u_old" || name != "photo.jpg" {
		t.Fatalf("photo backfill owner=%q name=%q error=%v", owner, name, err)
	}
	var photoID, checksum string
	if err := db.QueryRowContext(ctx, `SELECT id, checksum FROM photos INDEXED BY photos_active_timeline_idx WHERE deleted_at IS NULL AND scan_status='indexed' ORDER BY captured_at DESC, id DESC LIMIT 1`).Scan(&photoID, &checksum); err != nil || photoID != "p_old" || checksum != strings.Repeat("a", 64) {
		t.Fatalf("migrated timeline photo=%q checksum=%q error=%v", photoID, checksum, err)
	}
	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("repeat migration: %v", err)
	}
	var integrity string
	if err := db.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
		t.Fatalf("integrity = %q, %v", integrity, err)
	}
}
