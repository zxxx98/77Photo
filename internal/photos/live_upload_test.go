package photos

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"image"
	"image/color"
	"image/png"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/zxxx98/77Photo/internal/media"
)

type uploadMediaRunner struct {
	probeOutput []byte
	fileErr     error
}

func (r *uploadMediaRunner) Run(_ context.Context, _ string, _ ...string) ([]byte, error) {
	return append([]byte(nil), r.probeOutput...), nil
}

func (r *uploadMediaRunner) RunToFile(_ context.Context, executable, output string, _ ...string) error {
	if r.fileErr != nil {
		return r.fileErr
	}
	if strings.Contains(filepath.Base(executable), "heif-convert") {
		return writeDecodedPNG(output)
	}
	return os.WriteFile(output, quickTimeBytes(), 0o640)
}

func TestUploadAcceptsHEICAndHEIF(t *testing.T) {
	for _, test := range []struct {
		name  string
		ext   string
		mime  string
		brand string
	}{
		{name: "HEIC", ext: ".heic", mime: "image/heic", brand: "heic"},
		{name: "HEIF", ext: ".heif", mime: "image/heif", brand: "mif1"},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newUploadFixture(t, 1<<20)
			fixture.service.SetMediaTools(&media.Tools{
				HeifConvert:    "heif-convert",
				Runner:         &uploadMediaRunner{},
				Timeout:        time.Second,
				MaxOutputBytes: 1 << 20,
			})
			data := heifBytes(test.brand)
			photo, err := fixture.service.Upload(context.Background(), fixture.principal, UploadInput{
				FolderID: fixture.folderID, Filename: "photo" + test.ext, DeclaredMIME: test.mime, Body: bytes.NewReader(data),
			})
			if err != nil {
				t.Fatalf("Upload() error = %v", err)
			}
			if photo.MIMEType != test.mime || photo.Width != 2 || photo.Height != 1 {
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
				t.Fatal("HEIF original was modified")
			}
		})
	}
}

func TestUploadExtractsEmbeddedMVIMGMotion(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	runner := &uploadMediaRunner{probeOutput: []byte("video\n")}
	fixture.service.SetMediaTools(&media.Tools{FFprobe: "ffprobe", Runner: runner, Timeout: time.Second, MaxOutputBytes: 1 << 20})
	jpeg := jpegBytes(t, 2, 2)
	video := ftypBytesForPhoto("isom")
	data := append(append([]byte(nil), jpeg...), video...)
	photo, err := fixture.service.Upload(context.Background(), fixture.principal, UploadInput{
		FolderID: fixture.folderID, Filename: "MVIMG_0001.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(data),
	})
	if err != nil {
		t.Fatal(err)
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
		t.Fatal("MVIMG original was modified")
	}
	_, motionPath, err := fixture.service.LiveVideoPath(context.Background(), fixture.principal, photo.ID)
	if err != nil {
		t.Fatalf("LiveVideoPath() error = %v", err)
	}
	motion, err := os.ReadFile(motionPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(motion, video) {
		t.Fatalf("motion = %x, want %x", motion, video)
	}
}

func TestUploadExtractsEmbeddedHEICMotion(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	runner := &uploadMediaRunner{probeOutput: []byte("video\n")}
	fixture.service.SetMediaTools(&media.Tools{
		HeifConvert: "heif-convert", FFmpeg: "ffmpeg", FFprobe: "ffprobe", Runner: runner, Timeout: time.Second, MaxOutputBytes: 1 << 20,
	})
	photo, err := fixture.service.Upload(context.Background(), fixture.principal, UploadInput{
		FolderID: fixture.folderID, Filename: "photo.heic", DeclaredMIME: "image/heic", Body: bytes.NewReader(heifBytes("heic")),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := fixture.service.LiveVideoPath(context.Background(), fixture.principal, photo.ID); err != nil {
		t.Fatalf("LiveVideoPath() error = %v, want embedded HEIC motion", err)
	}
}

func TestUploadLogsEmbeddedMotionExtractionFailureWithoutDroppingStill(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	var logs bytes.Buffer
	fixture.service.SetLogger(slog.New(slog.NewTextHandler(&logs, nil)))
	fixture.service.SetMediaTools(&media.Tools{
		HeifConvert: "heif-convert", FFmpeg: "ffmpeg", FFprobe: "ffprobe", Runner: &motionExtractionFailureRunner{}, Timeout: time.Second, MaxOutputBytes: 1 << 20,
	})

	photo, err := fixture.service.Upload(context.Background(), fixture.principal, UploadInput{
		FolderID: fixture.folderID, Filename: "photo.heic", DeclaredMIME: "image/heic", Body: bytes.NewReader(heifBytes("heic")),
	})
	if err != nil {
		t.Fatalf("Upload() error = %v, want still upload to remain best-effort", err)
	}
	if !strings.Contains(logs.String(), "embedded motion extraction failed") || !strings.Contains(logs.String(), photo.ID) {
		t.Fatalf("logs = %q, want embedded motion extraction warning for %s", logs.String(), photo.ID)
	}
}

type motionExtractionFailureRunner struct{}

func (r *motionExtractionFailureRunner) Run(_ context.Context, _ string, _ ...string) ([]byte, error) {
	return []byte("video\n"), nil
}

func (r *motionExtractionFailureRunner) RunToFile(_ context.Context, executable, output string, _ ...string) error {
	if strings.Contains(filepath.Base(executable), "heif-convert") {
		return writeDecodedPNG(output)
	}
	return errors.New("ffmpeg failed")
}

func TestAttachLiveVideoAcceptsHEICStill(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	runner := &uploadMediaRunner{probeOutput: []byte("video\n")}
	fixture.service.SetMediaTools(&media.Tools{HeifConvert: "heif-convert", FFprobe: "ffprobe", Runner: runner, Timeout: time.Second, MaxOutputBytes: 1 << 20})
	photo, err := fixture.service.Upload(context.Background(), fixture.principal, UploadInput{
		FolderID: fixture.folderID, Filename: "photo.heic", DeclaredMIME: "image/heic", Body: bytes.NewReader(heifBytes("heic")),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := fixture.service.AttachLiveVideo(context.Background(), fixture.principal, photo.ID, LiveVideoInput{
		Filename: "photo.mov", DeclaredMIME: "video/quicktime", Body: bytes.NewReader(quickTimeBytes()),
	}); err != nil {
		t.Fatalf("AttachLiveVideo() error = %v", err)
	}
}

func TestLogicalLiveUploadRemovesPartialFilesWhenMotionIsInvalid(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	fixture.service.SetMediaTools(&media.Tools{FFprobe: "ffprobe", Runner: &uploadMediaRunner{probeOutput: []byte("audio\n")}, Timeout: time.Second, MaxOutputBytes: 1 << 20})
	_, err := fixture.service.UploadLivePhoto(context.Background(), fixture.principal, LivePhotoUploadInput{
		Still:  UploadInput{FolderID: fixture.folderID, Filename: "pair.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(jpegBytes(t, 2, 2))},
		Motion: &LiveVideoInput{Filename: "pair.mov", DeclaredMIME: "video/quicktime", Body: bytes.NewReader(quickTimeBytes())},
	})
	if !errors.Is(err, ErrInvalidMedia) {
		t.Fatalf("UploadLivePhoto() error = %v, want ErrInvalidMedia", err)
	}
	var count int
	if err := fixture.service.db.QueryRow("SELECT COUNT(*) FROM photos").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("photo rows = %d, want 0 after rollback", count)
	}
	entries, err := os.ReadDir(fixture.store.Root())
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".77photo-") {
			t.Fatalf("temporary artifact remains: %s", entry.Name())
		}
	}
}

func TestUploadLivePhotoCleansUpAfterRequestCancellation(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	fixture.service.SetThumbnailEnqueuer(cancelingThumbnailEnqueuer{cancel: cancel})

	_, err := fixture.service.UploadLivePhoto(ctx, fixture.principal, LivePhotoUploadInput{
		Still:  UploadInput{FolderID: fixture.folderID, Filename: "pair.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(jpegBytes(t, 2, 2))},
		Motion: &LiveVideoInput{Filename: "pair.mov", DeclaredMIME: "video/quicktime", Body: bytes.NewReader(quickTimeBytes())},
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("UploadLivePhoto() error = %v, want context.Canceled", err)
	}
	var count int
	if err := fixture.service.db.QueryRow("SELECT COUNT(*) FROM photos").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("photo rows = %d, want 0 after canceled request cleanup", count)
	}
}

func TestUploadLivePhotoLogsRollbackFailure(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	var logs bytes.Buffer
	fixture.service.SetLogger(slog.New(slog.NewTextHandler(&logs, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	fixture.service.SetThumbnailEnqueuer(failingCleanupThumbnailEnqueuer{service: fixture.service, cancel: cancel})

	_, err := fixture.service.UploadLivePhoto(ctx, fixture.principal, LivePhotoUploadInput{
		Still:  UploadInput{FolderID: fixture.folderID, Filename: "pair.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(jpegBytes(t, 2, 2))},
		Motion: &LiveVideoInput{Filename: "pair.mov", DeclaredMIME: "video/quicktime", Body: bytes.NewReader(quickTimeBytes())},
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("UploadLivePhoto() error = %v, want context.Canceled", err)
	}
	if !strings.Contains(logs.String(), "live photo rollback failed") {
		t.Fatalf("logs = %q, want rollback failure record", logs.String())
	}
}

type cancelingThumbnailEnqueuer struct {
	cancel context.CancelFunc
}

func (e cancelingThumbnailEnqueuer) Enqueue(string) bool {
	e.cancel()
	return true
}

type failingCleanupThumbnailEnqueuer struct {
	service *Service
	cancel  context.CancelFunc
}

func (e failingCleanupThumbnailEnqueuer) Enqueue(photoID string) bool {
	photo, err := e.service.getRaw(context.Background(), photoID)
	if err == nil {
		path, resolveErr := e.service.storage.ResolvePath(photo.StoragePath)
		if resolveErr == nil {
			_ = os.Remove(path)
			_ = os.Mkdir(path, 0o750)
			_ = os.WriteFile(filepath.Join(path, "keep"), []byte("keep"), 0o640)
		}
	}
	e.cancel()
	return true
}

func TestLiveVideoPathReturnsActualMotionMIME(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	photo, err := fixture.service.Upload(context.Background(), fixture.principal, UploadInput{
		FolderID: fixture.folderID, Filename: "photo.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(jpegBytes(t, 2, 2)),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := fixture.service.AttachLiveVideo(context.Background(), fixture.principal, photo.ID, LiveVideoInput{
		Filename: "photo.mov", DeclaredMIME: "video/quicktime", Body: bytes.NewReader(quickTimeBytes()),
	}); err != nil {
		t.Fatal(err)
	}
	_, path, err := fixture.service.LiveVideoPath(context.Background(), fixture.principal, photo.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := motionMIME(path); got != "video/quicktime" {
		t.Fatalf("motionMIME() = %q, want video/quicktime", got)
	}
}

func heifBytes(brand string) []byte {
	return ftypBytesForPhoto(brand)
}

func ftypBytesForPhoto(brand string) []byte {
	data := make([]byte, 24)
	binary.BigEndian.PutUint32(data[:4], uint32(len(data)))
	copy(data[4:8], "ftyp")
	copy(data[8:12], brand)
	copy(data[16:20], brand)
	return data
}

func writeDecodedPNG(path string) error {
	imageValue := image.NewRGBA(image.Rect(0, 0, 2, 1))
	imageValue.Set(0, 0, color.RGBA{255, 0, 0, 255})
	imageValue.Set(1, 0, color.RGBA{0, 0, 255, 255})
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	if err := png.Encode(file, imageValue); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}
