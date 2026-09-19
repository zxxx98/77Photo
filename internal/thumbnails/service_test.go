package thumbnails

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/zxxx98/77Photo/internal/media"
	"github.com/zxxx98/77Photo/internal/storage"
)

type testPhoto struct {
	ID             string
	StoragePath    string
	SourceRevision string
	MIMEType       string
	Orientation    int
}

type testLoader struct {
	mu     sync.Mutex
	photos map[string]testPhoto
}

type testRenderer struct {
	err error
}

type frameToolRunner struct {
	args [][]string
}

func (r *frameToolRunner) Run(context.Context, string, ...string) ([]byte, error) {
	return nil, nil
}

func (r *frameToolRunner) RunToFile(_ context.Context, executable, output string, args ...string) error {
	r.args = append(r.args, append([]string{executable}, args...))
	return os.WriteFile(output, []byte("frame"), 0o640)
}

func (r *testRenderer) DecodeStill(context.Context, string, string) (image.Image, error) {
	if r.err != nil {
		return nil, r.err
	}
	return image.NewRGBA(image.Rect(0, 0, 3, 2)), nil
}

func (r *testRenderer) ExtractVideoFrame(context.Context, string) (image.Image, error) {
	if r.err != nil {
		return nil, r.err
	}
	return image.NewRGBA(image.Rect(0, 0, 4, 2)), nil
}

func (l *testLoader) LoadPhoto(_ context.Context, id string) (Photo, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	p, ok := l.photos[id]
	if !ok {
		return Photo{}, os.ErrNotExist
	}
	orientation := p.Orientation
	return Photo{ID: p.ID, StoragePath: p.StoragePath, SourceRevision: p.SourceRevision, MIMEType: p.MIMEType, Orientation: &orientation}, nil
}

func TestResetAllRemovesGeneratedThumbnailCache(t *testing.T) {
	store, loader, _ := newThumbnailFixture(t, "p_reset", "rev-1")
	cacheRoot := filepath.Join(t.TempDir(), "cache")
	service, err := NewService(loader, store, cacheRoot, 1, 4)
	if err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(cacheRoot, "thumbnails", "256", "p_reset", "stale.webp")
	if err := os.MkdirAll(filepath.Dir(stale), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stale, []byte("stale"), 0o640); err != nil {
		t.Fatal(err)
	}

	if err := service.ResetAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale thumbnail still exists: %v", err)
	}
	if info, err := os.Stat(filepath.Join(cacheRoot, "thumbnails")); err != nil || !info.IsDir() {
		t.Fatalf("thumbnail cache root was not recreated: info=%v err=%v", info, err)
	}
}

func TestEnsureQueuesMissingThumbnailAndDeduplicates(t *testing.T) {
	store, loader, photo := newThumbnailFixture(t, "p_one", "rev-1")
	service, err := NewService(loader, store, filepath.Join(t.TempDir(), "cache"), 1, 4)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	service.Start(ctx)
	defer service.Close()

	if state, _, err := service.Ensure(context.Background(), photo.ID, 256); err != nil || state != Pending {
		t.Fatalf("first Ensure() = (%v, %v), want pending", state, err)
	}
	if state, _, err := service.Ensure(context.Background(), photo.ID, 256); err != nil || state != Pending {
		t.Fatalf("second Ensure() = (%v, %v), want pending", state, err)
	}
	waitFor(t, func() bool {
		state, _, _ := service.Ensure(context.Background(), photo.ID, 256)
		return state == Ready
	})
	waitFor(t, func() bool { return service.PendingJobs() == 0 })
}

func TestWorkerWritesWebPVariants(t *testing.T) {
	store, loader, photo := newThumbnailFixture(t, "p_variants", "rev-1")
	service, err := NewService(loader, store, filepath.Join(t.TempDir(), "cache"), 1, 4)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	service.Start(ctx)
	defer service.Close()
	if _, _, err := service.Ensure(context.Background(), photo.ID, 512); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		for _, size := range []int{256, 512, 1280} {
			if _, err := os.Stat(service.CachePath(photo.ID, photo.SourceRevision, size)); err != nil {
				return false
			}
		}
		return true
	})
	for _, size := range []int{256, 512, 1280} {
		path := service.CachePath(photo.ID, photo.SourceRevision, size)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("variant %d: %v", size, err)
		}
		if !bytes.HasPrefix(data, []byte("RIFF")) || !bytes.Contains(data[:min(len(data), 32)], []byte("WEBP")) {
			t.Fatalf("variant %d is not WebP", size)
		}
	}
}

func TestEnsureAcceptsHEICHEIFAndVideoAndWritesWebP(t *testing.T) {
	store, loader, photo := newThumbnailFixture(t, "p_media", "rev-1")
	service, err := NewService(loader, store, filepath.Join(t.TempDir(), "cache"), 1, 8)
	if err != nil {
		t.Fatal(err)
	}
	service.SetMediaRenderer(&testRenderer{})
	loader.mu.Lock()
	for _, mimeType := range []string{"image/heic", "image/heif", "video/mp4", "video/webm"} {
		copyPhoto := photo
		copyPhoto.ID = "p_" + strings.ReplaceAll(mimeType, "/", "_")
		copyPhoto.MIMEType = mimeType
		loader.photos[copyPhoto.ID] = copyPhoto
	}
	loader.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	service.Start(ctx)
	defer service.Close()
	for _, mimeType := range []string{"image/heic", "image/heif", "video/mp4", "video/webm"} {
		id := "p_" + strings.ReplaceAll(mimeType, "/", "_")
		if state, _, err := service.Ensure(ctx, id, 256); err != nil || state != Pending {
			t.Fatalf("Ensure(%s) = %v/%v, want pending", mimeType, state, err)
		}
	}
	waitFor(t, func() bool {
		for _, mimeType := range []string{"image/heic", "image/heif", "video/mp4", "video/webm"} {
			id := "p_" + strings.ReplaceAll(mimeType, "/", "_")
			if _, err := os.Stat(service.CachePath(id, photo.SourceRevision, 256)); err != nil {
				return false
			}
		}
		return true
	})
}

func TestFailedMediaRenderLeavesNoWebPVariants(t *testing.T) {
	store, loader, photo := newThumbnailFixture(t, "p_media_failure", "rev-1")
	photo.MIMEType = "video/mp4"
	loader.mu.Lock()
	loader.photos[photo.ID] = photo
	loader.mu.Unlock()
	service, err := NewService(loader, store, filepath.Join(t.TempDir(), "cache"), 1, 4)
	if err != nil {
		t.Fatal(err)
	}
	service.SetMediaRenderer(&testRenderer{err: errors.New("frame extraction failed")})
	service.Start(context.Background())
	defer service.Close()
	if !service.Enqueue(photo.ID) {
		t.Fatal("Enqueue() = false, want true")
	}
	waitFor(t, func() bool { return service.PendingJobs() == 0 })
	for _, size := range []int{256, 512, 1280} {
		if _, err := os.Stat(service.CachePath(photo.ID, photo.SourceRevision, size)); !os.IsNotExist(err) {
			t.Fatalf("variant %d stat error = %v, want not exists", size, err)
		}
	}
}

func TestVideoFrameToolUsesBoundedSeekAndScale(t *testing.T) {
	runner := &frameToolRunner{}
	tools := &media.Tools{FFmpeg: "ffmpeg", Runner: runner, Timeout: time.Second, MaxOutputBytes: 1 << 20}
	output := filepath.Join(t.TempDir(), "frame.png")
	if err := tools.ExtractVideoFrame(context.Background(), "input clip.mp4", output); err != nil {
		t.Fatal(err)
	}
	if len(runner.args) != 1 {
		t.Fatalf("ffmpeg calls = %d, want 1", len(runner.args))
	}
	joined := strings.Join(runner.args[0], "\x00")
	for _, needle := range []string{"-ss\x000.5", "-frames:v\x001", "-vf\x00scale=min(1280\\,iw):-2", "-f\x00image2"} {
		if !strings.Contains(joined, needle) {
			t.Fatalf("ffmpeg args = %#v, missing %q", runner.args[0], strings.ReplaceAll(needle, "\x00", " "))
		}
	}
}

func TestQueueReportsFullWithoutBlocking(t *testing.T) {
	store, loader, first := newThumbnailFixture(t, "p_first", "rev-1")
	second := first
	second.ID = "p_second"
	loader.mu.Lock()
	loader.photos[second.ID] = second
	loader.mu.Unlock()
	service, err := NewService(loader, store, filepath.Join(t.TempDir(), "cache"), 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if ok := service.Enqueue(first.ID); !ok {
		t.Fatal("first Enqueue() = false, want true")
	}
	if ok := service.Enqueue(second.ID); ok {
		t.Fatal("second Enqueue() = true, want queue full")
	}
}

func TestCorruptSourceDoesNotStopWorker(t *testing.T) {
	store, loader, corrupt := newThumbnailFixture(t, "p_corrupt", "rev-1")
	corruptPath, err := store.ResolvePath(corrupt.StoragePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(corruptPath, []byte("not an image"), 0o640); err != nil {
		t.Fatal(err)
	}
	valid := corrupt
	valid.ID = "p_valid"
	valid.StoragePath = filepath.Join("users", "u_test", "album", "p_valid.jpg")
	validPath, err := store.ResolvePath(valid.StoragePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(validPath, mustJPEG(t), 0o640); err != nil {
		t.Fatal(err)
	}
	loader.mu.Lock()
	loader.photos[valid.ID] = valid
	loader.mu.Unlock()
	service, err := NewService(loader, store, filepath.Join(t.TempDir(), "cache"), 1, 4)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	service.Start(ctx)
	defer service.Close()
	if !service.Enqueue(corrupt.ID) || !service.Enqueue(valid.ID) {
		t.Fatal("failed to enqueue worker jobs")
	}
	waitFor(t, func() bool {
		_, err := os.Stat(service.CachePath(valid.ID, valid.SourceRevision, 256))
		return err == nil
	})
}

func TestInvalidateRemovesAllSourceVersions(t *testing.T) {
	store, loader, photo := newThumbnailFixture(t, "p_invalidate", "rev-1")
	service, err := NewService(loader, store, filepath.Join(t.TempDir(), "cache"), 1, 4)
	if err != nil {
		t.Fatal(err)
	}
	for _, revision := range []string{"rev-1", "rev-2"} {
		path := service.CachePath(photo.ID, revision, 256)
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("cache"), 0o640); err != nil {
			t.Fatal(err)
		}
	}
	if err := service.Invalidate(context.Background(), photo.ID); err != nil {
		t.Fatal(err)
	}
	for _, revision := range []string{"rev-1", "rev-2"} {
		if _, err := os.Stat(service.CachePath(photo.ID, revision, 256)); !os.IsNotExist(err) {
			t.Fatalf("cache %s still exists: %v", revision, err)
		}
	}
}

func newThumbnailFixture(t *testing.T, id, revision string) (storage.Store, *testLoader, testPhoto) {
	t.Helper()
	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.MakeDir(filepath.Join("users", "u_test", "album")); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join("users", "u_test", "album", id+".jpg")
	abs, err := store.ResolvePath(path)
	if err != nil {
		t.Fatal(err)
	}
	img := image.NewRGBA(image.Rect(0, 0, 4, 2))
	img.Set(0, 0, color.RGBA{255, 0, 0, 255})
	file, err := os.Create(abs)
	if err != nil {
		t.Fatal(err)
	}
	if err := jpeg.Encode(file, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	p := testPhoto{ID: id, StoragePath: path, SourceRevision: revision, MIMEType: "image/jpeg", Orientation: 1}
	return store, &testLoader{photos: map[string]testPhoto{id: p}}, p
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition did not become true")
}

func mustJPEG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	var body bytes.Buffer
	if err := jpeg.Encode(&body, img, &jpeg.Options{Quality: 80}); err != nil {
		t.Fatal(err)
	}
	return body.Bytes()
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
