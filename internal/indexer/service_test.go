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
