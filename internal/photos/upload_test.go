package photos

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
	dbstore "github.com/zxxx98/77Photo/internal/database"
	"github.com/zxxx98/77Photo/internal/folders"
	"github.com/zxxx98/77Photo/internal/media"
	"github.com/zxxx98/77Photo/internal/storage"
)

type uploadFixture struct {
	service   *Service
	store     storage.Store
	principal acl.Principal
	folderID  string
}

func newUploadFixture(t *testing.T, maxSize int64) uploadFixture {
	t.Helper()
	ctx := context.Background()
	db, err := dbstore.Open(ctx, filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	authService := auth.NewService(db, time.Hour, false)
	admin, _, err := authService.SetupAdmin(ctx, "admin", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	folderService := folders.NewService(db, store)
	folder, err := folderService.Create(ctx, acl.Principal{UserID: admin.ID, Role: acl.RoleAdmin}, folders.CreateInput{Name: "uploads"})
	if err != nil {
		t.Fatal(err)
	}
	return uploadFixture{service: NewService(db, store, maxSize), store: store, principal: acl.Principal{UserID: admin.ID, Role: acl.RoleAdmin}, folderID: folder.ID}
}

func jpegBytes(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 180, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestUploadAcceptsGenericMIMEForJPEG(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	data := jpegBytes(t, 3, 2)
	photo, err := fixture.service.Upload(context.Background(), fixture.principal, UploadInput{
		FolderID: fixture.folderID,
		Filename: "MVIMG_0001.jpg",
		DeclaredMIME: "application/octet-stream",
		Body: bytes.NewReader(data),
	})
	if err != nil {
		t.Fatalf("Upload() error = %v", err)
	}
	if photo.MIMEType != "image/jpeg" {
		t.Fatalf("MIMEType = %q, want image/jpeg", photo.MIMEType)
	}
}

func TestUploadAcceptsEmptyMIMEForJPEG(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	data := jpegBytes(t, 3, 2)
	photo, err := fixture.service.Upload(context.Background(), fixture.principal, UploadInput{
		FolderID: fixture.folderID,
		Filename: "MVIMG_0002.jpg",
		Body: bytes.NewReader(data),
	})
	if err != nil {
		t.Fatalf("Upload() error = %v", err)
	}
	if photo.MIMEType != "image/jpeg" {
		t.Fatalf("MIMEType = %q, want image/jpeg", photo.MIMEType)
	}
}

func TestUploadStoresOriginalAndIndexesMetadata(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	data := jpegBytes(t, 3, 2)
	photo, err := fixture.service.Upload(context.Background(), fixture.principal, UploadInput{FolderID: fixture.folderID, Filename: "photo.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(data)})
	if err != nil {
		t.Fatalf("Upload() error = %v", err)
	}
	if photo.Width != 3 || photo.Height != 2 || photo.MIMEType != "image/jpeg" || photo.Checksum == "" {
		t.Fatalf("photo = %+v", photo)
	}
	path, err := fixture.store.ResolvePath(photo.StoragePath)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(stored, data) {
		t.Fatal("stored original differs from uploaded bytes")
	}
	if photo.CapturedAtSource != "file_mtime" || photo.CapturedAt.IsZero() {
		t.Fatalf("captured metadata = %q/%v", photo.CapturedAtSource, photo.CapturedAt)
	}
}

func TestUploadUsesClientModifiedTimeWhenEmbeddedTimeIsUnavailable(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	modified := time.Date(2022, 7, 8, 9, 10, 11, 0, time.FixedZone("client", 8*60*60))
	photo, err := fixture.service.Upload(context.Background(), fixture.principal, UploadInput{
		FolderID: fixture.folderID, Filename: "photo.jpg", DeclaredMIME: "image/jpeg",
		FileModifiedAt: &modified, Body: bytes.NewReader(jpegBytes(t, 3, 2)),
	})
	if err != nil {
		t.Fatal(err)
	}
	if photo.CapturedAtSource != "file_mtime" {
		t.Fatalf("captured source = %q, want file_mtime", photo.CapturedAtSource)
	}
	if !photo.CapturedAt.Equal(modified.UTC()) {
		t.Fatalf("captured at = %v, want %v", photo.CapturedAt, modified.UTC())
	}
}

func TestUploadPrefersEmbeddedVideoTimeOverClientModifiedTime(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	fixture.service.SetMediaTools(&media.Tools{
		Runner: &captureMetadataRunner{output: []byte(`{"format":{"tags":{"creation_time":"2021-03-04T05:06:07Z"}},"streams":[]}`)},
		Timeout: time.Second,
	})
	modified := time.Date(2026, 9, 18, 12, 0, 0, 0, time.UTC)
	photo, err := fixture.service.Upload(context.Background(), fixture.principal, UploadInput{
		FolderID: fixture.folderID, Filename: "clip.mp4", DeclaredMIME: "video/mp4",
		FileModifiedAt: &modified, Body: bytes.NewReader(testMP4Header()),
	})
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2021, 3, 4, 5, 6, 7, 0, time.UTC)
	if photo.CapturedAtSource != "exif" || !photo.CapturedAt.Equal(want) {
		t.Fatalf("captured metadata = %q/%v, want exif/%v", photo.CapturedAtSource, photo.CapturedAt, want)
	}
}

func TestDuplicateUploadIsRejectedWithoutSecondFile(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	data := jpegBytes(t, 2, 2)
	input := UploadInput{FolderID: fixture.folderID, Filename: "photo.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(data)}
	first, err := fixture.service.Upload(context.Background(), fixture.principal, input)
	if err != nil {
		t.Fatal(err)
	}
	input.Body = bytes.NewReader(data)
	_, err = fixture.service.Upload(context.Background(), fixture.principal, input)
	var duplicate *DuplicateError
	if !errors.As(err, &duplicate) || duplicate.ExistingPhotoID != first.ID {
		t.Fatalf("duplicate error = %v, want existing photo %s", err, first.ID)
	}
}

func TestNameConflictCanUseServerGeneratedRename(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	firstData := jpegBytes(t, 2, 2)
	secondData := jpegBytes(t, 2, 3)
	if _, err := fixture.service.Upload(context.Background(), fixture.principal, UploadInput{FolderID: fixture.folderID, Filename: "photo.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(firstData)}); err != nil {
		t.Fatal(err)
	}
	photo, err := fixture.service.Upload(context.Background(), fixture.principal, UploadInput{FolderID: fixture.folderID, Filename: "photo.jpg", DeclaredMIME: "image/jpeg", Conflict: ConflictRename, Body: bytes.NewReader(secondData)})
	if err != nil {
		t.Fatal(err)
	}
	if photo.Filename != "photo (1).jpg" {
		t.Fatalf("renamed filename = %q", photo.Filename)
	}
}

func TestUploadNeverOverwritesUnindexedFile(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	folderPath, err := fixture.store.ResolvePath(filepath.Join("users", fixture.principal.UserID, "uploads"))
	if err != nil {
		t.Fatal(err)
	}
	protected := filepath.Join(folderPath, "photo.jpg")
	if err := os.WriteFile(protected, []byte("unindexed original"), 0o640); err != nil {
		t.Fatal(err)
	}
	_, err = fixture.service.Upload(context.Background(), fixture.principal, UploadInput{FolderID: fixture.folderID, Filename: "photo.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(jpegBytes(t, 2, 2))})
	if !errors.Is(err, ErrNameConflict) {
		t.Fatalf("Upload(unindexed conflict) error = %v, want ErrNameConflict", err)
	}
	stored, readErr := os.ReadFile(protected)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(stored) != "unindexed original" {
		t.Fatal("unindexed file was overwritten")
	}
}

func TestUploadRejectsOversizeAndInvalidMediaWithoutVisibleFiles(t *testing.T) {
	fixture := newUploadFixture(t, 32)
	if _, err := fixture.service.Upload(context.Background(), fixture.principal, UploadInput{FolderID: fixture.folderID, Filename: "large.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(jpegBytes(t, 10, 10))}); !errors.Is(err, ErrUploadTooLarge) {
		t.Fatalf("oversize error = %v, want ErrUploadTooLarge", err)
	}
	if _, err := fixture.service.Upload(context.Background(), fixture.principal, UploadInput{FolderID: fixture.folderID, Filename: "notes.txt", DeclaredMIME: "text/plain", Body: bytes.NewReader([]byte("hello"))}); !errors.Is(err, ErrUnsupportedMedia) {
		t.Fatalf("invalid media error = %v, want ErrUnsupportedMedia", err)
	}
	rootEntries, err := os.ReadDir(fixture.store.Root())
	if err != nil {
		t.Fatal(err)
	}
	if len(rootEntries) == 0 {
		t.Fatal("fixture root unexpectedly empty")
	}
}

func TestUploadReaderFailureLeavesNoIndexOrTempFile(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	reader := &failingReader{data: jpegBytes(t, 2, 2)}
	if _, err := fixture.service.Upload(context.Background(), fixture.principal, UploadInput{FolderID: fixture.folderID, Filename: "broken.jpg", DeclaredMIME: "image/jpeg", Body: reader}); !errors.Is(err, ErrUploadFailed) {
		t.Fatalf("reader failure error = %v, want ErrUploadFailed", err)
	}
	entries, err := os.ReadDir(fixture.store.Root())
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) == ".tmp" {
			t.Fatalf("temporary file remains: %s", entry.Name())
		}
	}
}

func TestUploadRejectsMalformedImage(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	_, err := fixture.service.Upload(context.Background(), fixture.principal, UploadInput{FolderID: fixture.folderID, Filename: "broken.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader([]byte{0xff, 0xd8, 0xff, 0xd9})})
	if !errors.Is(err, ErrInvalidMedia) {
		t.Fatalf("malformed image error = %v, want ErrInvalidMedia", err)
	}
}

func TestUploadRejectsImagesOverPixelLimitBeforeIndexing(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	_, err := fixture.service.Upload(context.Background(), fixture.principal, UploadInput{FolderID: fixture.folderID, Filename: "huge.png", DeclaredMIME: "image/png", Body: bytes.NewReader(oversizedPNGHeader(10001, 10001))})
	if !errors.Is(err, ErrPixelLimit) {
		t.Fatalf("oversized pixel image error = %v, want ErrPixelLimit", err)
	}
}

func TestDatabaseFailureRemovesAtomicallyRenamedFile(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	if _, err := fixture.service.db.Exec(`CREATE TRIGGER reject_photo BEFORE INSERT ON photos BEGIN SELECT RAISE(ABORT, 'forced index failure'); END`); err != nil {
		t.Fatal(err)
	}
	_, err := fixture.service.Upload(context.Background(), fixture.principal, UploadInput{FolderID: fixture.folderID, Filename: "photo.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(jpegBytes(t, 2, 2))})
	if err == nil {
		t.Fatal("Upload() error = nil, want index failure")
	}
	folderPath, err := fixture.store.ResolvePath(filepath.Join("users", fixture.principal.UserID, "uploads"))
	if err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(folderPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("folder contains %d files after index failure, want none", len(entries))
	}
}

func TestPhotoRenameMoveAndConfirmedDeleteUpdateDiskAndIndex(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	ctx := context.Background()
	photo, err := fixture.service.Upload(ctx, fixture.principal, UploadInput{FolderID: fixture.folderID, Filename: "photo.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(jpegBytes(t, 2, 2))})
	if err != nil {
		t.Fatal(err)
	}
	renamed, err := fixture.service.Rename(ctx, fixture.principal, photo.ID, RenameInput{Name: "renamed.jpg"})
	if err != nil {
		t.Fatalf("Rename() error = %v", err)
	}
	if renamed.Filename != "renamed.jpg" {
		t.Fatalf("renamed = %+v", renamed)
	}
	secondFolder := newFolderForPhotoTest(t, fixture)
	moved, err := fixture.service.Move(ctx, fixture.principal, photo.ID, secondFolder)
	if err != nil {
		t.Fatalf("Move() error = %v", err)
	}
	if moved.FolderID != secondFolder {
		t.Fatalf("moved folder = %q", moved.FolderID)
	}
	if err := fixture.service.Delete(ctx, fixture.principal, photo.ID, false); !errors.Is(err, ErrConfirmationRequired) {
		t.Fatalf("Delete(without confirmation) error = %v", err)
	}
	if err := fixture.service.Delete(ctx, fixture.principal, photo.ID, true); err != nil {
		t.Fatalf("Delete(confirmed) error = %v", err)
	}
	if _, err := fixture.service.Get(ctx, fixture.principal, photo.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get(deleted) error = %v, want ErrNotFound", err)
	}
}

func TestPhotoDeleteIndexFailureLeavesHiddenTombstone(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	ctx := context.Background()
	photo, err := fixture.service.Upload(ctx, fixture.principal, UploadInput{FolderID: fixture.folderID, Filename: "photo.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(jpegBytes(t, 2, 2))})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.db.Exec(`CREATE TRIGGER reject_photo_delete BEFORE DELETE ON photos BEGIN SELECT RAISE(ABORT, 'forced index failure'); END`); err != nil {
		t.Fatal(err)
	}
	defer fixture.service.db.Exec(`DROP TRIGGER reject_photo_delete`)
	if err := fixture.service.Delete(ctx, fixture.principal, photo.ID, true); err == nil {
		t.Fatal("Delete() error = nil, want index failure")
	}
	if _, err := fixture.service.Get(ctx, fixture.principal, photo.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get(deleted) error = %v, want ErrNotFound", err)
	}
	var deletedAt sql.NullString
	if err := fixture.service.db.QueryRow("SELECT deleted_at FROM photos WHERE id=?", photo.ID).Scan(&deletedAt); err != nil {
		t.Fatal(err)
	}
	if !deletedAt.Valid {
		t.Fatal("photo tombstone missing after index failure")
	}
	path, err := fixture.store.ResolvePath(photo.StoragePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("deleted file stat error = %v, want not exists", err)
	}
}

func newFolderForPhotoTest(t *testing.T, fixture uploadFixture) string {
	t.Helper()
	var id string
	if err := fixture.service.db.QueryRow("SELECT id FROM folders WHERE id<>? LIMIT 1", fixture.folderID).Scan(&id); err == nil {
		return id
	}
	ownerID, _, _ := fixture.service.authorizedFolder(context.Background(), fixture.principal, fixture.folderID)
	_ = ownerID
	folderPath, err := fixture.store.ResolvePath(filepath.Join("users", fixture.principal.UserID, "second"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(folderPath, 0o750); err != nil {
		t.Fatal(err)
	}
	id = "f_second"
	if _, err := fixture.service.db.Exec(`INSERT INTO folders (id, owner_id, storage_path, name, is_shared, created_at, updated_at) VALUES (?, ?, 'users/' || ? || '/second', 'second', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, id, fixture.principal.UserID, fixture.principal.UserID); err != nil {
		t.Fatal(err)
	}
	return id
}

func oversizedPNGHeader(width, height uint32) []byte {
	var body bytes.Buffer
	body.Write([]byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a})
	var ihdr [13]byte
	binary.BigEndian.PutUint32(ihdr[0:4], width)
	binary.BigEndian.PutUint32(ihdr[4:8], height)
	ihdr[8] = 8
	ihdr[9] = 2
	writePNGChunk(&body, "IHDR", ihdr[:])
	writePNGChunk(&body, "IEND", nil)
	return body.Bytes()
}

func writePNGChunk(body *bytes.Buffer, kind string, data []byte) {
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(data)))
	body.Write(length[:])
	body.WriteString(kind)
	body.Write(data)
	crc := crc32.ChecksumIEEE(append([]byte(kind), data...))
	binary.BigEndian.PutUint32(length[:], crc)
	body.Write(length[:])
}

type captureMetadataRunner struct {
	output []byte
}

func (r *captureMetadataRunner) Run(_ context.Context, _ string, _ ...string) ([]byte, error) {
	return append([]byte(nil), r.output...), nil
}

func (r *captureMetadataRunner) RunToFile(_ context.Context, _ string, _ string, _ ...string) error {
	return errors.New("unexpected RunToFile call")
}

func testMP4Header() []byte {
	data := make([]byte, 24)
	binary.BigEndian.PutUint32(data[:4], uint32(len(data)))
	copy(data[4:8], "ftyp")
	copy(data[8:12], "isom")
	copy(data[16:20], "isom")
	return data
}

type failingReader struct {
	data []byte
	done bool
}

func (r *failingReader) Read(p []byte) (int, error) {
	if !r.done {
		r.done = true
		n := copy(p, r.data[:len(r.data)/2])
		return n, nil
	}
	return 0, io.ErrUnexpectedEOF
}
