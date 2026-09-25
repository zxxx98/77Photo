package media

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const embeddedMotionScanChunk = 64 * 1024

// FindEmbeddedMotionBounded discovers embedded motion without loading the
// source image into memory. HEIC/HEIF files are handed directly to ffprobe;
// JPEG files are scanned in fixed-size chunks and only the candidate motion
// segment is copied to a temporary file for probing.
func (t *Tools) FindEmbeddedMotionBounded(ctx context.Context, input string) (EmbeddedMotion, error) {
	info, err := os.Stat(input)
	if err != nil {
		return EmbeddedMotion{}, fmt.Errorf("stat embedded motion source: %w", err)
	}
	if info.Size() > t.inputLimit() {
		return EmbeddedMotion{}, ErrOutputTooLarge
	}
	if !info.Mode().IsRegular() {
		return EmbeddedMotion{}, errors.New("embedded motion source is not a regular file")
	}

	extension := strings.ToLower(filepath.Ext(input))
	if extension == ".heic" || extension == ".heif" {
		video, probeErr := t.ProbeVideo(ctx, input)
		if probeErr != nil {
			return EmbeddedMotion{}, probeErr
		}
		if video {
			return EmbeddedMotion{Size: info.Size(), MIME: "video/mp4"}, nil
		}
		return EmbeddedMotion{}, nil
	}
	if extension != ".jpg" && extension != ".jpeg" {
		return EmbeddedMotion{}, nil
	}

	file, err := os.Open(input)
	if err != nil {
		return EmbeddedMotion{}, fmt.Errorf("open embedded motion source: %w", err)
	}
	defer file.Close()
	head := make([]byte, 512)
	n, readErr := file.Read(head)
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		return EmbeddedMotion{}, fmt.Errorf("read embedded motion header: %w", readErr)
	}
	if !looksLikeJPEG(head[:n]) {
		return EmbeddedMotion{}, nil
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return EmbeddedMotion{}, fmt.Errorf("rewind embedded motion source: %w", err)
	}
	offset, ok, err := locateJPEGMotionFile(file, info.Size())
	if err != nil {
		return EmbeddedMotion{}, err
	}
	if !ok {
		return EmbeddedMotion{}, nil
	}

	temporary, err := os.CreateTemp(filepath.Dir(input), ".77photo-motion-input-*.mp4")
	if err != nil {
		return EmbeddedMotion{}, fmt.Errorf("create embedded motion input: %w", err)
	}
	temporaryPath := temporary.Name()
	cleanup := func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		cleanup()
		return EmbeddedMotion{}, fmt.Errorf("seek embedded motion segment: %w", err)
	}
	written, copyErr := io.Copy(temporary, io.LimitReader(file, t.inputLimit()+1))
	if copyErr != nil {
		cleanup()
		return EmbeddedMotion{}, fmt.Errorf("copy embedded motion segment: %w", copyErr)
	}
	if written > t.inputLimit() {
		cleanup()
		return EmbeddedMotion{}, ErrOutputTooLarge
	}
	if err := temporary.Sync(); err != nil {
		cleanup()
		return EmbeddedMotion{}, fmt.Errorf("sync embedded motion input: %w", err)
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(temporaryPath)
		return EmbeddedMotion{}, fmt.Errorf("close embedded motion input: %w", err)
	}
	video, probeErr := t.ProbeVideo(ctx, temporaryPath)
	_ = os.Remove(temporaryPath)
	if probeErr != nil {
		return EmbeddedMotion{}, probeErr
	}
	if !video {
		return EmbeddedMotion{}, nil
	}
	return EmbeddedMotion{Offset: offset, Size: written, MIME: "video/mp4"}, nil
}

// ExtractMotionBounded is the bounded counterpart of ExtractMotion for
// photo-indexing paths. It preserves the same atomic artifact semantics while
// avoiding a whole-file in-memory read during embedded motion detection.
func (t *Tools) ExtractMotionBounded(ctx context.Context, input, destination string) error {
	if strings.TrimSpace(input) == "" || strings.TrimSpace(destination) == "" {
		return errors.New("media input and destination paths are required")
	}
	embedded, err := t.FindEmbeddedMotionBounded(ctx, input)
	if err != nil {
		return err
	}
	if embedded.Offset > 0 {
		return t.atomicCopyMotion(input, destination, embedded.Offset)
	}
	video, err := t.ProbeVideo(ctx, input)
	if err != nil {
		return err
	}
	if !video {
		return ErrNoVideoStream
	}
	return t.atomicFFmpegCopy(ctx, input, destination)
}

// locateJPEGMotionFile returns the offset of the ISO-BMFF segment appended to
// a still. Every JPEG EOI marker is examined: camera apps embed an EXIF
// thumbnail that ends with its own EOI long before the primary image does, so
// stopping at the first marker reports "no motion" for most vendor files.
func locateJPEGMotionFile(file *os.File, fileSize int64) (int64, bool, error) {
	buffer := make([]byte, embeddedMotionScanChunk)
	var previous byte
	var offset int64
	for {
		n, readErr := file.Read(buffer)
		for index := 0; index < n; index++ {
			current := buffer[index]
			currentOffset := offset + int64(index)
			if previous == 0xff && current == 0xd9 {
				motionOffset, ok, err := motionBoxAt(file, currentOffset+1, fileSize)
				if err != nil {
					return 0, false, err
				}
				if ok {
					return motionOffset, true, nil
				}
				// Thumbnail or padding EOI: keep scanning for the primary image.
			}
			previous = current
		}
		offset += int64(n)
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return 0, false, nil
			}
			return 0, false, fmt.Errorf("scan embedded motion source: %w", readErr)
		}
	}
}

// motionBoxAt reports whether a valid ISO-BMFF box starts at offset. Filler
// between the EOI marker and the box is not tolerated: an ISO-BMFF header
// starts with NUL bytes, so skipping filler would shift into the box payload.
func motionBoxAt(file *os.File, offset, fileSize int64) (int64, bool, error) {
	if offset < 0 || offset > fileSize || fileSize-offset < 16 {
		return 0, false, nil
	}
	header := make([]byte, 16)
	n, err := file.ReadAt(header, offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return 0, false, fmt.Errorf("read embedded motion header: %w", err)
	}
	if n < 16 {
		return 0, false, nil
	}
	if !validFTYPBox(header, fileSize-offset) {
		return 0, false, nil
	}
	return offset, true, nil
}
