package cleanup

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
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

func TestScanAndCleanupOnlyClearlyBrokenOriginals(t *testing.T) {
	ctx := context.Background()
	db, err := dbstore.Open(ctx, filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	authService := auth.NewService(db, time.Hour, false)
	admin, _, err := authService.SetupAdmin(ctx, "admin", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	principal := acl.Principal{UserID: admin.ID, Role: acl.RoleAdmin}
	folderService := folders.NewService(db, store)
	folder, err := folderService.Create(ctx, principal, folders.CreateInput{Name: "Family"})
	if err != nil {
		t.Fatal(err)
	}
	photoService := photos.NewService(db, store, 1<<20)
	first, err := photoService.Upload(ctx, principal, photos.UploadInput{FolderID: folder.ID, Filename: "missing.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(testJPEG(t, 10))})
	if err != nil {
		t.Fatal(err)
	}
	second, err := photoService.Upload(ctx, principal, photos.UploadInput{FolderID: folder.ID, Filename: "empty.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(testJPEG(t, 20))})
	if err != nil {
		t.Fatal(err)
	}
	healthy, err := photoService.Upload(ctx, principal, photos.UploadInput{FolderID: folder.ID, Filename: "healthy.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(testJPEG(t, 30))})
	if err != nil {
		t.Fatal(err)
	}

	missingPath, _ := store.ResolvePath(first.StoragePath)
	if err := os.Remove(missingPath); err != nil {
		t.Fatal(err)
	}
	emptyPath, _ := store.ResolvePath(second.StoragePath)
	if err := os.Truncate(emptyPath, 0); err != nil {
		t.Fatal(err)
	}

	service := NewService(db, store, photoService)
	scan, err := service.Scan(ctx, principal)
	if err != nil {
		t.Fatal(err)
	}
	if scan.Scanned != 3 || scan.Broken != 2 {
		t.Fatalf("scan = %+v, want scanned=3 broken=2", scan)
	}
	reasons := map[string]string{}
	for _, item := range scan.Items {
		reasons[item.Filename] = item.Reason
	}
	if reasons["missing.jpg"] != "missing" || reasons["empty.jpg"] != "empty" {
		t.Fatalf("reasons = %#v", reasons)
	}

	result, err := service.Cleanup(ctx, principal, true)
	if err != nil {
		t.Fatal(err)
	}
	if result.Found != 2 || result.Deleted != 2 || result.Failed != 0 {
		t.Fatalf("cleanup = %+v, want found=2 deleted=2 failed=0", result)
	}
	if _, err := photoService.Get(ctx, principal, healthy.ID); err != nil {
		t.Fatalf("healthy photo was removed: %v", err)
	}
	if _, err := photoService.Get(ctx, principal, first.ID); !errors.Is(err, photos.ErrNotFound) {
		t.Fatalf("missing photo still indexed: %v", err)
	}
	if _, err := photoService.Get(ctx, principal, second.ID); !errors.Is(err, photos.ErrNotFound) {
		t.Fatalf("empty photo still indexed: %v", err)
	}
}

func TestCleanupRequiresAdminAndConfirmation(t *testing.T) {
	service := &Service{}
	if _, err := service.Scan(context.Background(), acl.Principal{UserID: "u1", Role: acl.RoleUser}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("Scan error = %v, want ErrForbidden", err)
	}
	if _, err := service.Cleanup(context.Background(), acl.Principal{UserID: "u1", Role: acl.RoleAdmin}, false); !errors.Is(err, ErrConfirmationRequired) {
		t.Fatalf("Cleanup error = %v, want ErrConfirmationRequired", err)
	}
}

func testJPEG(t *testing.T, red uint8) []byte {
	t.Helper()
	var buffer bytes.Buffer
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.RGBA{R: red, A: 255})
	if err := jpeg.Encode(&buffer, img, nil); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
