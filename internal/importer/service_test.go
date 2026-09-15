package importer

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
	"github.com/zxxx98/77Photo/internal/indexer"
	"github.com/zxxx98/77Photo/internal/photos"
	"github.com/zxxx98/77Photo/internal/storage"
)

func TestImportMovesSupportedMediaAndIndexesIt(t *testing.T) {
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
	sourceDir, err := store.ResolvePath(filepath.Join("legacy", "2024"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(sourceDir, 0o750); err != nil {
		t.Fatal(err)
	}

	imagePath := filepath.Join(sourceDir, "found.jpg")
	file, err := os.Create(imagePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := jpeg.Encode(file, image.NewRGBA(image.Rect(0, 0, 2, 2)), nil); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	textPath := filepath.Join(sourceDir, "notes.txt")
	if err := os.WriteFile(textPath, []byte("keep me here"), 0o640); err != nil {
		t.Fatal(err)
	}

	photoService := photos.NewService(db, store, 1<<20)
	indexerService := indexer.NewService(db, store, photoService)
	service := NewService(db, store, indexerService)
	job, err := service.Start(ctx, principal, "legacy", admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	service.Wait()

	finished, err := service.Get(ctx, principal, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if finished.Status != StatusCompleted {
		t.Fatalf("import status = %q, error=%v", finished.Status, finished.Error)
	}
	if finished.Counts.Scanned != 2 || finished.Counts.Moved != 1 || finished.Counts.Skipped != 1 || finished.Counts.Failed != 0 {
		t.Fatalf("unexpected import counts: %+v", finished.Counts)
	}

	destinationRelative := filepath.ToSlash(filepath.Join("users", admin.ID, "Imported", "2024", "found.jpg"))
	destination, err := store.ResolvePath(destinationRelative)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(destination); err != nil {
		t.Fatalf("migrated photo missing: %v", err)
	}
	if _, err := os.Stat(imagePath); !os.IsNotExist(err) {
		t.Fatalf("source photo still exists, stat err=%v", err)
	}
	if _, err := os.Stat(textPath); err != nil {
		t.Fatalf("unsupported source file should remain in place: %v", err)
	}

	var indexed int
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM photos WHERE storage_path=? AND scan_status='indexed'", destinationRelative).Scan(&indexed); err != nil {
		t.Fatal(err)
	}
	if indexed != 1 {
		t.Fatalf("indexed migrated photo count = %d, want 1", indexed)
	}
}
