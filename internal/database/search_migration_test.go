package database

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"

	"github.com/zxxx98/77Photo/migrations"
)

func TestSearchIndexUpgradeFromBackupPreservesPhotosAndShares(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	oldPath, backupPath, restoredPath := filepath.Join(root, "old.db"), filepath.Join(root, "backup.db"), filepath.Join(root, "restored.db")
	old, err := sql.Open(driverName, oldPath)
	if err != nil {
		t.Fatal(err)
	}
	old.SetMaxOpenConns(1)
	if err := configure(ctx, old); err != nil {
		t.Fatal(err)
	}
	prior := fstest.MapFS{}
	for version := 1; version <= 11; version++ {
		matches, err := fs.Glob(migrations.FS, fmt.Sprintf("%03d_*.sql", version))
		if err != nil || len(matches) != 1 {
			t.Fatalf("migration %d: %v, %v", version, matches, err)
		}
		data, err := fs.ReadFile(migrations.FS, matches[0])
		if err != nil {
			t.Fatal(err)
		}
		prior[matches[0]] = &fstest.MapFile{Data: data}
	}
	if err := MigrateFS(ctx, old, prior); err != nil {
		t.Fatal(err)
	}
	stamp := "2026-09-01T00:00:00Z"
	for _, id := range []string{"owner", "member"} {
		if _, err := old.ExecContext(ctx, `INSERT INTO users(id,username,password_hash,role,is_active,created_at,updated_at) VALUES(?,?,?,'user',1,?,?)`, id, id, "hash", stamp, stamp); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := old.ExecContext(ctx, `INSERT INTO folders(id,owner_id,storage_path,name,created_at,updated_at) VALUES('shared','owner','shared','Shared',?,?)`, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	if _, err := old.ExecContext(ctx, `INSERT INTO shares(id,resource_type,resource_id,user_id,permission,created_at) VALUES('share-1','folder','shared','member','read',?)`, stamp); err != nil {
		t.Fatal(err)
	}
	photoBytes := []byte("synthetic original retained across M3 migration")
	sum := fmt.Sprintf("%x", sha256.Sum256(photoBytes))
	photoPath := filepath.Join(root, "original.jpg")
	if err := os.WriteFile(photoPath, photoBytes, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := old.ExecContext(ctx, `INSERT INTO photos(id,owner_id,folder_id,storage_path,filename,mime_type,size,checksum,captured_at,captured_at_source,file_created_at,indexed_at,source_revision,scan_status,created_at,updated_at)
VALUES('photo-1','owner','shared','original.jpg','Family.jpg','image/jpeg',?,?,?,?,?,?,'revision','indexed',?,?)`, len(photoBytes), sum, stamp, "file_mtime", stamp, stamp, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	if _, err := old.ExecContext(ctx, "VACUUM INTO ?", backupPath); err != nil {
		t.Fatal(err)
	}
	if err := old.Close(); err != nil {
		t.Fatal(err)
	}
	source, err := os.Open(backupPath)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	destination, err := os.Create(restoredPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(destination, source); err != nil {
		t.Fatal(err)
	}
	if err := destination.Close(); err != nil {
		t.Fatal(err)
	}
	restored, err := Open(ctx, restoredPath)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	var gotID, gotChecksum, gotMember string
	if err := restored.QueryRowContext(ctx, `SELECT id,checksum FROM photos INDEXED BY photos_active_timeline_idx WHERE deleted_at IS NULL AND scan_status='indexed' ORDER BY captured_at DESC,id DESC LIMIT 1`).Scan(&gotID, &gotChecksum); err != nil {
		t.Fatal(err)
	}
	if err := restored.QueryRowContext(ctx, `SELECT user_id FROM shares WHERE id='share-1'`).Scan(&gotMember); err != nil {
		t.Fatal(err)
	}
	if gotID != "photo-1" || gotChecksum != sum || gotMember != "member" {
		t.Fatalf("restored photo=%q checksum=%q member=%q", gotID, gotChecksum, gotMember)
	}
	readBytes, err := os.ReadFile(photoPath)
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprintf("%x", sha256.Sum256(readBytes)) != gotChecksum {
		t.Fatal("original file hash changed")
	}
	var integrity string
	if err := restored.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
		t.Fatalf("integrity=%q err=%v", integrity, err)
	}
	var migrationCount int
	if err := restored.QueryRowContext(ctx, "SELECT count(*) FROM schema_migrations").Scan(&migrationCount); err != nil || migrationCount != 12 {
		t.Fatalf("migrations=%d err=%v", migrationCount, err)
	}
}
