package indexer

import (
	"context"
	"image"
	"image/jpeg"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
	dbstore "github.com/zxxx98/77Photo/internal/database"
	"github.com/zxxx98/77Photo/internal/folders"
	"github.com/zxxx98/77Photo/internal/photos"
	"github.com/zxxx98/77Photo/internal/storage"
)

func TestRescanDiscoversFilesAndIsIdempotent(t *testing.T) {
	ctx := context.Background()
	db, err := dbstore.Open(ctx, filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authService := auth.NewService(db, time.Hour, false)
	admin, _, err := authService.SetupAdmin(ctx, "admin", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	folder, err := folders.NewService(db, store).Create(ctx, acl.Principal{UserID: admin.ID, Role: acl.RoleAdmin}, folders.CreateInput{Name: "imports"})
	if err != nil {
		t.Fatal(err)
	}
	path, err := store.ResolvePath(filepath.Join(folder.StoragePath, "found.jpg"))
	if err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := jpeg.Encode(file, image.NewRGBA(image.Rect(0, 0, 2, 2)), nil); err != nil {
		t.Fatal(err)
	}
	_ = file.Close()
	photoService := photos.NewService(db, store, 1<<20)
	service := NewService(db, store, photoService)
	job, err := service.Start(ctx, acl.Principal{UserID: admin.ID, Role: acl.RoleAdmin})
	if err != nil {
		t.Fatal(err)
	}
	waitForJob(t, service, acl.Principal{UserID: admin.ID, Role: acl.RoleAdmin}, job.ID)
	var count int
	if err := db.QueryRow("SELECT count(*) FROM photos WHERE scan_status='indexed'").Scan(&count); err != nil || count != 1 {
		t.Fatalf("indexed photo count = %d, err=%v", count, err)
	}
	job, err = service.Start(ctx, acl.Principal{UserID: admin.ID, Role: acl.RoleAdmin})
	if err != nil {
		t.Fatal(err)
	}
	waitForJob(t, service, acl.Principal{UserID: admin.ID, Role: acl.RoleAdmin}, job.ID)
	if err := db.QueryRow("SELECT count(*) FROM photos WHERE scan_status='indexed'").Scan(&count); err != nil || count != 1 {
		t.Fatalf("second indexed photo count = %d, err=%v", count, err)
	}
}

func TestRescanDiscoversFilesystemFolders(t *testing.T) {
	ctx := context.Background()
	db, err := dbstore.Open(ctx, filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authService := auth.NewService(db, time.Hour, false)
	admin, _, err := authService.SetupAdmin(ctx, "admin", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	importPath := filepath.Join("users", admin.ID, "camera-import", "2026")
	directory, err := store.ResolvePath(importPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(directory, 0o750); err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(filepath.Join(directory, "found.jpg"))
	if err != nil {
		t.Fatal(err)
	}
	if err := jpeg.Encode(file, image.NewRGBA(image.Rect(0, 0, 2, 2)), nil); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	photoService := photos.NewService(db, store, 1<<20)
	service := NewService(db, store, photoService)
	principal := acl.Principal{UserID: admin.ID, Role: acl.RoleAdmin}
	job, err := service.Start(ctx, principal)
	if err != nil {
		t.Fatal(err)
	}
	waitForJob(t, service, principal, job.ID)

	var parentID string
	if err := db.QueryRowContext(ctx, "SELECT id FROM folders WHERE storage_path=?", filepath.ToSlash(filepath.Join("users", admin.ID, "camera-import"))).Scan(&parentID); err != nil {
		t.Fatalf("load discovered parent folder: %v", err)
	}
	var childID, childOwner, actualParent string
	if err := db.QueryRowContext(ctx, "SELECT id, owner_id, parent_id FROM folders WHERE storage_path=?", filepath.ToSlash(importPath)).Scan(&childID, &childOwner, &actualParent); err != nil {
		t.Fatalf("load discovered child folder: %v", err)
	}
	if childOwner != admin.ID {
		t.Fatalf("discovered folder owner = %q, want %q", childOwner, admin.ID)
	}
	if actualParent != parentID {
		t.Fatalf("discovered folder parent = %q, want %q", actualParent, parentID)
	}
	var photoFolderID string
	if err := db.QueryRowContext(ctx, "SELECT folder_id FROM photos WHERE storage_path=? AND scan_status='indexed'", filepath.ToSlash(filepath.Join(importPath, "found.jpg"))).Scan(&photoFolderID); err != nil {
		t.Fatalf("load discovered photo: %v", err)
	}
	if photoFolderID != childID {
		t.Fatalf("photo folder = %q, want %q", photoFolderID, childID)
	}
}

func TestRescanMarksMissingWithoutDeadlock(t *testing.T) {
	ctx := context.Background()
	db, err := dbstore.Open(ctx, filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authService := auth.NewService(db, time.Hour, false)
	admin, _, err := authService.SetupAdmin(ctx, "admin", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	principal := acl.Principal{UserID: admin.ID, Role: acl.RoleAdmin}
	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	folder, err := folders.NewService(db, store).Create(ctx, principal, folders.CreateInput{Name: "imports"})
	if err != nil {
		t.Fatal(err)
	}
	path, err := store.ResolvePath(filepath.Join(folder.StoragePath, "missing.jpg"))
	if err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := jpeg.Encode(file, image.NewRGBA(image.Rect(0, 0, 2, 2)), nil); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	photoService := photos.NewService(db, store, 1<<20)
	service := NewService(db, store, photoService)
	job, err := service.Start(ctx, principal)
	if err != nil {
		t.Fatal(err)
	}
	waitForJob(t, service, principal, job.ID)

	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	job, err = service.Start(ctx, principal)
	if err != nil {
		t.Fatal(err)
	}
	waitForJob(t, service, principal, job.ID)

	finished, err := service.Get(ctx, principal, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if finished.Counts.Missing != 1 {
		t.Fatalf("missing count = %d, want 1", finished.Counts.Missing)
	}
	var status string
	if err := db.QueryRowContext(ctx, "SELECT scan_status FROM photos WHERE storage_path=?", filepath.ToSlash(filepath.Join(folder.StoragePath, "missing.jpg"))).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "missing" {
		t.Fatalf("scan status = %q, want missing", status)
	}
}

func TestRescanDiscoversManagedSharedRoot(t *testing.T) {
	ctx := context.Background()
	db, err := dbstore.Open(ctx, filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authService := auth.NewService(db, time.Hour, false)
	owner, _, err := authService.SetupAdmin(ctx, "owner", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.EnsureSharedRoot("shared-folder"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO folders (id, owner_id, storage_path, name, is_shared, created_at, updated_at)
VALUES ('shared-folder', ?, 'shared/shared-folder', 'shared', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, owner.ID); err != nil {
		t.Fatal(err)
	}
	path, err := store.ResolvePath("shared/shared-folder/found.jpg")
	if err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := jpeg.Encode(file, image.NewRGBA(image.Rect(0, 0, 2, 2)), nil); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	photoService := photos.NewService(db, store, 1<<20)
	service := NewService(db, store, photoService)
	job, err := service.Start(ctx, acl.Principal{UserID: owner.ID, Role: acl.RoleAdmin})
	if err != nil {
		t.Fatal(err)
	}
	waitForJob(t, service, acl.Principal{UserID: owner.ID, Role: acl.RoleAdmin}, job.ID)
	var count int
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM photos WHERE storage_path=?", "shared/shared-folder/found.jpg").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("shared root index count = %d, want 1", count)
	}
}

func waitForJob(t *testing.T, service *Service, principal acl.Principal, id string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		job, err := service.Get(context.Background(), principal, id)
		if err == nil && (job.Status == StatusCompleted || job.Status == StatusFailed) {
			if job.Status == StatusFailed {
				t.Fatalf("rescan failed: %v", job.Error)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("rescan did not complete")
}
