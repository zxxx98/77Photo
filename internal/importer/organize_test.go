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
	"github.com/zxxx98/77Photo/internal/storage"
)

func TestOrganizedImportKeepsPairsTogetherAndRenamesCollisions(t *testing.T) {
	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	stamp := time.Date(2021, 3, 4, 12, 0, 0, 0, time.UTC)
	for _, dir := range []string{"a", "b"} {
		folder := filepath.Join(store.Root(), "legacy", dir)
		if err := os.MkdirAll(folder, 0750); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(folder, "IMG_1.jpg")
		f, err := os.Create(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := jpeg.Encode(f, image.NewRGBA(image.Rect(0, 0, 2, 2)), nil); err != nil {
			t.Fatal(err)
		}
		if err := f.Close(); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, stamp, stamp); err != nil {
			t.Fatal(err)
		}
		// The companion has today's mtime; the pair must follow the still's date.
		if err := os.WriteFile(filepath.Join(folder, "IMG_1.mp4"), heifBytesForImporter("isom"), 0640); err != nil {
			t.Fatal(err)
		}
	}
	target := filepath.Join(store.Root(), "users", "user-import", "Imported", "2021", "03", "04")
	if err := os.MkdirAll(target, 0750); err != nil {
		t.Fatal(err)
	}
	// Different extension, same stem: do not accidentally create a false pair.
	existing := filepath.Join(target, "IMG_1.MOV")
	if err := os.WriteFile(existing, []byte("original"), 0640); err != nil {
		t.Fatal(err)
	}
	service := NewService(nil, store, nil)
	job := &Job{SourcePath: "legacy", UserID: "user-import", OrganizeByDate: true}
	// The scan dependency is intentionally absent; moves happen before rescan.
	if err := service.importFiles(context.Background(), acl.Principal{}, job); err == nil {
		t.Fatal("expected missing indexer error")
	}
	if job.Counts.Moved != 4 || job.Counts.Failed != 0 {
		t.Fatalf("counts: %+v", job.Counts)
	}
	for _, base := range []string{"IMG_1_2", "IMG_1_3"} {
		for _, ext := range []string{".jpg", ".mp4"} {
			if _, err := os.Stat(filepath.Join(target, base+ext)); err != nil {
				t.Fatal(err)
			}
		}
	}
	data, err := os.ReadFile(existing)
	if err != nil || string(data) != "original" {
		t.Fatalf("existing file changed: %q %v", data, err)
	}
}
