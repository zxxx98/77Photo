package indexer

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"image"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
	dbstore "github.com/zxxx98/77Photo/internal/database"
	"github.com/zxxx98/77Photo/internal/folders"
	"github.com/zxxx98/77Photo/internal/media"
	"github.com/zxxx98/77Photo/internal/photos"
	"github.com/zxxx98/77Photo/internal/storage"
)

type scannerMediaRunner struct{}

func (scannerMediaRunner) Run(_ context.Context, _ string, args ...string) ([]byte, error) {
	if len(args) > 0 {
		input := args[len(args)-1]
		if extension := strings.ToLower(filepath.Ext(input)); extension == ".heic" || extension == ".heif" {
			return []byte("audio\n"), nil
		}
	}
	return []byte("video\n"), nil
}

func (scannerMediaRunner) RunToFile(_ context.Context, executable, output string, _ ...string) error {
	if filepath.Base(executable) == "heif-convert" {
		file, err := os.Create(output)
		if err != nil {
			return err
		}
		err = png.Encode(file, image.NewRGBA(image.Rect(0, 0, 2, 2)))
		if closeErr := file.Close(); err == nil {
			err = closeErr
		}
		return err
	}
	return os.WriteFile(output, []byte("motion"), 0o640)
}

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

func TestRescanPairsHEICAndMOVAndSkipsOrphanMOV(t *testing.T) {
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
	stillPath, err := store.ResolvePath(filepath.Join(folder.StoragePath, "IMG_100.HEIF"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stillPath, heicBytesForIndexer("mif1"), 0o640); err != nil {
		t.Fatal(err)
	}
	motionPath := filepath.Join(filepath.Dir(stillPath), "img_100.MOV")
	if err := os.WriteFile(motionPath, quickTimeBytesForIndexer(), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filepath.Dir(stillPath), "orphan.MOV"), quickTimeBytesForIndexer(), 0o640); err != nil {
		t.Fatal(err)
	}
	photoService := photos.NewService(db, store, 1<<20)
	photoService.SetMediaTools(&media.Tools{FFprobe: "ffprobe", HeifConvert: "heif-convert", Runner: scannerMediaRunner{}, Timeout: time.Second, MaxOutputBytes: 1 << 20})
	service := NewService(db, store, photoService)
	service.SetMediaTools(&media.Tools{FFprobe: "ffprobe", Runner: scannerMediaRunner{}, Timeout: time.Second, MaxOutputBytes: 1 << 20})
	job, err := service.Start(ctx, principal)
	if err != nil {
		t.Fatal(err)
	}
	waitForJob(t, service, principal, job.ID)
	var count int
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM photos WHERE scan_status='indexed'").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("indexed photo count = %d, want one still/MOV pair", count)
	}
	var mimeType string
	if err := db.QueryRowContext(ctx, "SELECT mime_type FROM photos WHERE scan_status='indexed'").Scan(&mimeType); err != nil {
		t.Fatal(err)
	}
	if mimeType != "image/heif" {
		t.Fatalf("indexed MIME = %q, want image/heif", mimeType)
	}
	var photoID string
	if err := db.QueryRowContext(ctx, "SELECT id FROM photos WHERE scan_status='indexed'").Scan(&photoID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := photoService.LiveVideoPath(ctx, principal, photoID); err != nil {
		t.Fatalf("paired motion missing: %v", err)
	}
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM photos WHERE filename='orphan.MOV'").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("orphan MOV rows = %d, want 0", count)
	}
	if err := os.Remove(motionPath); err != nil {
		t.Fatal(err)
	}
	job, err = service.Start(ctx, principal)
	if err != nil {
		t.Fatal(err)
	}
	waitForJob(t, service, principal, job.ID)
	if _, _, err := photoService.LiveVideoPath(ctx, principal, photoID); !errors.Is(err, photos.ErrLiveMotionNotFound) {
		t.Fatalf("deleted companion error = %v, want motion not found", err)
	}
}

func TestRescanPromotesSameBasenameMP4ToLivePhotoAndRetiresVideoIndex(t *testing.T) {
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

	motionPath, err := store.ResolvePath(filepath.Join(folder.StoragePath, "MVIMG_200.mp4"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(motionPath, heicBytesForIndexer("isom"), 0o640); err != nil {
		t.Fatal(err)
	}

	tools := &media.Tools{FFprobe: "ffprobe", Runner: scannerMediaRunner{}, Timeout: time.Second, MaxOutputBytes: 1 << 20}
	photoService := photos.NewService(db, store, 1<<20)
	photoService.SetMediaTools(tools)
	service := NewService(db, store, photoService)
	service.SetMediaTools(tools)

	// With no matching still yet, the MP4 remains a normal standalone video.
	job, err := service.Start(ctx, principal)
	if err != nil {
		t.Fatal(err)
	}
	waitForJob(t, service, principal, job.ID)
	var status string
	if err := db.QueryRowContext(ctx, "SELECT scan_status FROM photos WHERE filename='MVIMG_200.mp4'").Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "indexed" {
		t.Fatalf("standalone MP4 status = %q, want indexed", status)
	}

	stillPath, err := store.ResolvePath(filepath.Join(folder.StoragePath, "MVIMG_200.jpg"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stillPath, jpegBytesForIndexer(t, 3, 2), 0o640); err != nil {
		t.Fatal(err)
	}

	// Once the same-basename still appears, rescan should merge the pair into
	// one logical Live Photo and retire the old standalone MP4 index row.
	job, err = service.Start(ctx, principal)
	if err != nil {
		t.Fatal(err)
	}
	waitForJob(t, service, principal, job.ID)

	var indexedCount int
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM photos WHERE scan_status='indexed'").Scan(&indexedCount); err != nil {
		t.Fatal(err)
	}
	if indexedCount != 1 {
		t.Fatalf("indexed photo count = %d, want one logical live photo", indexedCount)
	}
	if err := db.QueryRowContext(ctx, "SELECT scan_status FROM photos WHERE filename='MVIMG_200.mp4'").Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "paired" {
		t.Fatalf("paired MP4 status = %q, want paired", status)
	}
	var stillID string
	if err := db.QueryRowContext(ctx, "SELECT id FROM photos WHERE filename='MVIMG_200.jpg' AND scan_status='indexed'").Scan(&stillID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := photoService.LiveVideoPath(ctx, principal, stillID); err != nil {
		t.Fatalf("paired MP4 motion missing: %v", err)
	}
	if _, err := os.Stat(motionPath); err != nil {
		t.Fatalf("original MP4 companion must remain on disk: %v", err)
	}

	// If the still later disappears, the MP4 becomes a standalone video again.
	if err := os.Remove(stillPath); err != nil {
		t.Fatal(err)
	}
	job, err = service.Start(ctx, principal)
	if err != nil {
		t.Fatal(err)
	}
	waitForJob(t, service, principal, job.ID)
	if err := db.QueryRowContext(ctx, "SELECT scan_status FROM photos WHERE filename='MVIMG_200.mp4'").Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "indexed" {
		t.Fatalf("unpaired MP4 status = %q, want indexed", status)
	}
}

func TestRescanRemovesStaleMVIMGMotionAfterSourceChange(t *testing.T) {
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
	path, err := store.ResolvePath(filepath.Join(folder.StoragePath, "MVIMG_1.jpg"))
	if err != nil {
		t.Fatal(err)
	}
	video := heicBytesForIndexer("isom")
	if err := os.WriteFile(path, append(jpegBytesForIndexer(t, 2, 2), video...), 0o640); err != nil {
		t.Fatal(err)
	}
	photoService := photos.NewService(db, store, 1<<20)
	photoService.SetMediaTools(&media.Tools{FFprobe: "ffprobe", Runner: scannerMediaRunner{}, Timeout: time.Second, MaxOutputBytes: 1 << 20})
	service := NewService(db, store, photoService)
	service.SetMediaTools(&media.Tools{FFprobe: "ffprobe", Runner: scannerMediaRunner{}, Timeout: time.Second, MaxOutputBytes: 1 << 20})
	job, err := service.Start(ctx, principal)
	if err != nil {
		t.Fatal(err)
	}
	waitForJob(t, service, principal, job.ID)
	var photoID string
	if err := db.QueryRowContext(ctx, "SELECT id FROM photos WHERE filename='MVIMG_1.jpg'").Scan(&photoID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := photoService.LiveVideoPath(ctx, principal, photoID); err != nil {
		t.Fatalf("embedded motion missing = %v", err)
	}
	if err := os.WriteFile(path, jpegBytesForIndexer(t, 3, 3), 0o640); err != nil {
		t.Fatal(err)
	}
	job, err = service.Start(ctx, principal)
	if err != nil {
		t.Fatal(err)
	}
	waitForJob(t, service, principal, job.ID)
	if _, _, err := photoService.LiveVideoPath(ctx, principal, photoID); !errors.Is(err, photos.ErrLiveMotionNotFound) {
		t.Fatalf("changed MVIMG error = %v, want motion not found", err)
	}
}

func heicBytesForIndexer(brand string) []byte {
	data := make([]byte, 24)
	binary.BigEndian.PutUint32(data[:4], uint32(len(data)))
	copy(data[4:8], "ftyp")
	copy(data[8:12], brand)
	copy(data[16:20], brand)
	return data
}

func jpegBytesForIndexer(t *testing.T, width, height int) []byte {
	t.Helper()
	var body bytes.Buffer
	if err := jpeg.Encode(&body, image.NewRGBA(image.Rect(0, 0, width, height)), nil); err != nil {
		t.Fatal(err)
	}
	return body.Bytes()
}

func quickTimeBytesForIndexer() []byte {
	return []byte{0, 0, 0, 24, 'f', 't', 'y', 'p', 'q', 't', ' ', ' ', 0, 0, 0, 0, 'q', 't', ' ', ' ', 'm', 'p', '4', '2'}
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
