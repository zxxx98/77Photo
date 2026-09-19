package thumbnails

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	nativewebp "github.com/HugoSmits86/nativewebp"
	"github.com/zxxx98/77Photo/internal/media"
	"github.com/zxxx98/77Photo/internal/storage"
	"golang.org/x/image/draw"
)

const (
	DefaultQueueCapacity = 128
	MaxAttempts          = 3
	maxSourceBytes       = 256 << 20
)

var (
	ErrInvalidSize   = errors.New("thumbnail size is invalid")
	ErrQueueFull     = errors.New("thumbnail queue is full")
	ErrUnsupported   = errors.New("thumbnail is not supported for this media")
	ErrSourceMissing = errors.New("thumbnail source is missing")
)

var supportedSizes = map[int]struct{}{256: {}, 512: {}, 1280: {}}

type State string

const (
	Pending State = "pending"
	Ready   State = "ready"
)

// Photo is the media subset required by the thumbnail worker. Photos.Service
// can implement PhotoLoader without coupling the storage and queue packages.
type Photo struct {
	ID             string
	StoragePath    string
	SourceRevision string
	MIMEType       string
	Orientation    *int
}

type PhotoLoader interface {
	LoadPhoto(context.Context, string) (Photo, error)
}

type MediaRenderer interface {
	DecodeStill(context.Context, string, string) (image.Image, error)
	ExtractVideoFrame(context.Context, string) (image.Image, error)
}

type Service struct {
	loader       PhotoLoader
	storage      storage.Store
	cacheRoot    string
	workers      int
	queue        chan string
	mu           sync.Mutex
	pending      map[string]struct{}
	startOnce    sync.Once
	closeOnce    sync.Once
	workerCtx    context.Context
	workerCancel context.CancelFunc
	wg           sync.WaitGroup
	renderer     MediaRenderer
}

func NewService(loader PhotoLoader, store storage.Store, cacheRoot string, workers, capacity int) (*Service, error) {
	if loader == nil {
		return nil, errors.New("thumbnail photo loader is required")
	}
	if workers < 1 {
		return nil, errors.New("thumbnail workers must be positive")
	}
	if capacity < 1 {
		capacity = DefaultQueueCapacity
	}
	if strings.TrimSpace(cacheRoot) == "" {
		return nil, errors.New("thumbnail cache root must not be empty")
	}
	if err := os.MkdirAll(cacheRoot, 0o750); err != nil {
		return nil, fmt.Errorf("create thumbnail cache: %w", err)
	}
	return &Service{loader: loader, storage: store, cacheRoot: cacheRoot, workers: workers, queue: make(chan string, capacity), pending: make(map[string]struct{})}, nil
}

func (s *Service) SetMediaRenderer(renderer MediaRenderer) { s.renderer = renderer }

func (s *Service) SetMediaTools(tools *media.Tools) {
	if tools == nil {
		s.renderer = nil
		return
	}
	s.renderer = &toolRenderer{tools: tools}
}

// Start launches the fixed worker set. Jobs enqueued before Start remain
// buffered and are processed after startup.
func (s *Service) Start(ctx context.Context) {
	s.startOnce.Do(func() {
		s.workerCtx, s.workerCancel = context.WithCancel(ctx)
		s.wg.Add(s.workers)
		for i := 0; i < s.workers; i++ {
			go s.worker()
		}
	})
}

func (s *Service) Close() {
	s.closeOnce.Do(func() {
		if s.workerCancel != nil {
			s.workerCancel()
		}
		s.wg.Wait()
	})
}

func (s *Service) PendingJobs() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.pending)
}

// Enqueue adds one deduplicated photo job. A full queue is reported to the
// caller so HTTP handlers can return a placeholder instead of decoding inline.
func (s *Service) Enqueue(photoID string) bool {
	if strings.TrimSpace(photoID) == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.pending[photoID]; exists {
		return true
	}
	select {
	case s.queue <- photoID:
		s.pending[photoID] = struct{}{}
		return true
	default:
		return false
	}
}

func (s *Service) Ensure(ctx context.Context, photoID string, size int) (State, string, error) {
	if _, ok := supportedSizes[size]; !ok {
		return "", "", ErrInvalidSize
	}
	photo, err := s.loader.LoadPhoto(ctx, photoID)
	if err != nil {
		return "", "", err
	}
	if !isThumbnailMIME(photo.MIMEType) {
		return "", "", ErrUnsupported
	}
	path := s.CachePath(photo.ID, photo.SourceRevision, size)
	if _, err := os.Stat(path); err == nil {
		return Ready, path, nil
	} else if !os.IsNotExist(err) {
		return "", "", fmt.Errorf("inspect thumbnail cache: %w", err)
	}
	if !s.Enqueue(photo.ID) {
		return Pending, "", ErrQueueFull
	}
	return Pending, "", nil
}

func (s *Service) CachePath(photoID, sourceRevision string, size int) string {
	revisionHash := sha256.Sum256([]byte(sourceRevision))
	return filepath.Join(s.cacheRoot, "thumbnails", fmt.Sprint(size), photoID, hex.EncodeToString(revisionHash[:])+".webp")
}

func (s *Service) Invalidate(_ context.Context, photoID string) error {
	if strings.TrimSpace(photoID) == "" {
		return nil
	}
	for _, size := range []int{256, 512, 1280} {
		path := filepath.Join(s.cacheRoot, "thumbnails", fmt.Sprint(size), photoID)
		if err := os.RemoveAll(path); err != nil {
			return fmt.Errorf("invalidate thumbnail cache: %w", err)
		}
	}
	return nil
}

// WaitIdle blocks until queued and in-flight thumbnail work has drained.
// Reset flows use this after removing photo rows so stale workers cannot
// recreate cache entries after the cache directory is cleared.
func (s *Service) WaitIdle(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		s.mu.Lock()
		pending := len(s.pending)
		s.mu.Unlock()
		if pending == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// ResetAll removes all generated thumbnail variants while preserving originals.
func (s *Service) ResetAll(_ context.Context) error {
	path := filepath.Join(s.cacheRoot, "thumbnails")
	if err := os.RemoveAll(path); err != nil {
		return fmt.Errorf("reset thumbnail cache: %w", err)
	}
	if err := os.MkdirAll(path, 0o750); err != nil {
		return fmt.Errorf("recreate thumbnail cache: %w", err)
	}
	return nil
}

func (s *Service) worker() {
	defer s.wg.Done()
	for {
		select {
		case <-s.workerCtx.Done():
			return
		case photoID := <-s.queue:
			s.process(photoID)
			s.mu.Lock()
			delete(s.pending, photoID)
			s.mu.Unlock()
		}
	}
}

func (s *Service) process(photoID string) {
	for attempt := 1; attempt <= MaxAttempts; attempt++ {
		if err := s.generate(photoID); err == nil {
			return
		}
		if attempt == MaxAttempts {
			return
		}
	}
}

func (s *Service) generate(photoID string) error {
	photo, err := s.loader.LoadPhoto(s.workerCtx, photoID)
	if err != nil {
		return err
	}
	if !isThumbnailMIME(photo.MIMEType) {
		return ErrUnsupported
	}
	sourcePath, err := s.storage.ResolvePath(photo.StoragePath)
	if err != nil {
		return err
	}
	var imageValue image.Image
	if photo.MIMEType == "image/jpeg" || photo.MIMEType == "image/png" {
		file, openErr := os.Open(sourcePath)
		if openErr != nil {
			return fmt.Errorf("open thumbnail source: %w", openErr)
		}
		var decodeErr error
		imageValue, _, decodeErr = image.Decode(io.LimitReader(file, maxSourceBytes))
		closeErr := file.Close()
		if decodeErr != nil {
			return fmt.Errorf("decode thumbnail source: %w", decodeErr)
		}
		if closeErr != nil {
			return fmt.Errorf("close thumbnail source: %w", closeErr)
		}
	} else {
		if s.renderer == nil {
			return ErrUnsupported
		}
		if strings.HasPrefix(photo.MIMEType, "video/") {
			imageValue, err = s.renderer.ExtractVideoFrame(s.workerCtx, sourcePath)
		} else {
			imageValue, err = s.renderer.DecodeStill(s.workerCtx, sourcePath, photo.MIMEType)
		}
		if err != nil {
			return fmt.Errorf("render thumbnail source: %w", err)
		}
	}
	imageValue = applyOrientation(imageValue, photo.Orientation)
	for _, size := range []int{256, 512, 1280} {
		path := s.CachePath(photo.ID, photo.SourceRevision, size)
		if _, statErr := os.Stat(path); statErr == nil {
			continue
		} else if !os.IsNotExist(statErr) {
			return statErr
		}
		if err := writeVariant(path, resize(imageValue, size)); err != nil {
			return err
		}
	}
	return nil
}

func isThumbnailMIME(mimeType string) bool {
	switch mimeType {
	case "image/jpeg", "image/png", "image/heic", "image/heif", "video/mp4", "video/webm", "video/quicktime":
		return true
	default:
		return false
	}
}

type toolRenderer struct {
	tools *media.Tools
}

func (r *toolRenderer) DecodeStill(ctx context.Context, input, _ string) (image.Image, error) {
	return r.renderToImage(ctx, input, r.tools.DecodeStill)
}

func (r *toolRenderer) ExtractVideoFrame(ctx context.Context, input string) (image.Image, error) {
	return r.renderToImage(ctx, input, r.tools.ExtractVideoFrame)
}

func (r *toolRenderer) renderToImage(ctx context.Context, input string, render func(context.Context, string, string) error) (image.Image, error) {
	temporary, err := os.CreateTemp(filepath.Dir(input), ".77photo-thumbnail-*.png")
	if err != nil {
		return nil, err
	}
	path := temporary.Name()
	if err := temporary.Close(); err != nil {
		_ = os.Remove(path)
		return nil, err
	}
	_ = os.Remove(path)
	defer os.Remove(path)
	if err := render(ctx, input, path); err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	imageValue, _, decodeErr := image.Decode(io.LimitReader(file, maxSourceBytes))
	closeErr := file.Close()
	if decodeErr != nil {
		return nil, decodeErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	return imageValue, nil
}

func writeVariant(path string, imageValue image.Image) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".thumbnail-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	keep := false
	defer func() {
		_ = temporary.Close()
		if !keep {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := nativewebp.Encode(temporary, imageValue, &nativewebp.Options{CompressionLevel: nativewebp.DefaultCompression}); err != nil {
		return err
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		if os.IsExist(err) {
			return nil
		}
		return err
	}
	keep = true
	return nil
}

func resize(src image.Image, maxSide int) image.Image {
	bounds := src.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width <= maxSide && height <= maxSide {
		return src
	}
	newWidth, newHeight := width, height
	if width >= height {
		newWidth = maxSide
		newHeight = max(1, height*maxSide/width)
	} else {
		newHeight = maxSide
		newWidth = max(1, width*maxSide/height)
	}
	destination := image.NewRGBA(image.Rect(0, 0, newWidth, newHeight))
	draw.CatmullRom.Scale(destination, destination.Bounds(), src, bounds, draw.Over, nil)
	return destination
}

func applyOrientation(src image.Image, orientation *int) image.Image {
	if orientation == nil || *orientation < 2 || *orientation > 8 {
		return src
	}
	bounds := src.Bounds()
	sw, sh := bounds.Dx(), bounds.Dy()
	dw, dh := sw, sh
	if *orientation >= 5 {
		dw, dh = sh, sw
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < dh; y++ {
		for x := 0; x < dw; x++ {
			sx, sy := orientationSource(*orientation, x, y, sw, sh)
			dst.Set(x, y, src.At(bounds.Min.X+sx, bounds.Min.Y+sy))
		}
	}
	return dst
}

func orientationSource(orientation, x, y, width, height int) (int, int) {
	switch orientation {
	case 2:
		return width - 1 - x, y
	case 3:
		return width - 1 - x, height - 1 - y
	case 4:
		return x, height - 1 - y
	case 5:
		return y, x
	case 6:
		return y, height - 1 - x
	case 7:
		return width - 1 - y, height - 1 - x
	case 8:
		return width - 1 - y, x
	default:
		return x, y
	}
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
