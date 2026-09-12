package photos

import (
	"bytes"
	"context"
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
