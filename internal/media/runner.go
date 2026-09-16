package media

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

var (
	ErrOutputTooLarge = errors.New("media tool output exceeds configured limit")
	ErrEmptyOutput    = errors.New("media tool produced empty output")
	ErrNoVideoStream  = errors.New("media has no video stream")
)

const (
	defaultMaxOutputBytes = 256 << 20
	defaultMaxInputBytes  = 512 << 20
)

// Runner is the only process boundary used by media processing. Implementations
// must pass executable arguments directly and must not invoke a shell.
type Runner interface {
	Run(context.Context, string, ...string) ([]byte, error)
	RunToFile(context.Context, string, string, ...string) error
}

// Tools contains the external media capabilities used by the application.
// Paths are intentionally explicit so deployments can report unavailable
// optional capabilities without making the Go binary depend on CGO.
type Tools struct {
	FFmpeg         string
	FFprobe        string
	HeifConvert    string
	Runner         Runner
	Timeout        time.Duration
	MaxOutputBytes int64
	MaxInputBytes  int64
}

// EmbeddedMotion identifies a validated ISO-BMFF segment appended to a still.
// Offset and Size refer to the original source file and are zero when no
// validated motion segment is present.
type EmbeddedMotion struct {
	Offset int64
	Size   int64
	MIME   string
}

// NewRunner returns the production direct-process runner.
func NewRunner(maxOutputBytes int64) Runner {
	if maxOutputBytes < 1 {
		maxOutputBytes = defaultMaxOutputBytes
	}
	return &commandRunner{maxOutputBytes: maxOutputBytes}
}

type commandRunner struct {
	maxOutputBytes int64
}

var errBoundedWriterLimit = errors.New("bounded writer limit reached")

type boundedBuffer struct {
	bytes.Buffer
	limit int64
}

func (b *boundedBuffer) Write(value []byte) (int, error) {
	if int64(b.Len())+int64(len(value)) > b.limit {
		return 0, errBoundedWriterLimit
	}
	return b.Buffer.Write(value)
}

func (r *commandRunner) Run(ctx context.Context, executable string, args ...string) ([]byte, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	output := &boundedBuffer{limit: r.maxOutputBytes}
	command := exec.CommandContext(ctx, executable, args...)
	command.Stdout = output
	command.Stderr = io.Discard
	if err := command.Run(); err != nil {
		if errors.Is(outputErr(err), errBoundedWriterLimit) {
			return nil, ErrOutputTooLarge
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("run %s: %w", executable, err)
	}
	return output.Bytes(), nil
}

// outputErr unwraps the error returned by os/exec while preserving the
// bounded-writer sentinel from the command's stdout copy goroutine.
func outputErr(err error) error {
	if errors.Is(err, errBoundedWriterLimit) {
		return errBoundedWriterLimit
	}
	return err
}

func (r *commandRunner) RunToFile(ctx context.Context, executable, output string, args ...string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if strings.TrimSpace(output) == "" {
		return errors.New("media output path is required")
	}
	if _, err := os.Stat(output); err == nil {
		return fmt.Errorf("media output already exists: %w", os.ErrExist)
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect media output: %w", err)
	}

	command := exec.CommandContext(ctx, executable, args...)
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	done := make(chan error, 1)
	go func() { done <- command.Run() }()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case err := <-done:
			if err != nil {
				_ = os.Remove(output)
				if ctx.Err() != nil {
					return ctx.Err()
				}
				return fmt.Errorf("run %s: %w", executable, err)
			}
			if err := validateToolOutput(output, r.maxOutputBytes); err != nil {
				_ = os.Remove(output)
				return err
			}
			return nil
		case <-ctx.Done():
			if command.Process != nil {
				_ = command.Process.Kill()
			}
			<-done
			_ = os.Remove(output)
			return ctx.Err()
		case <-ticker.C:
			info, err := os.Stat(output)
			if err == nil && info.Size() > r.maxOutputBytes {
				_ = command.Process.Kill()
				<-done
				_ = os.Remove(output)
				return ErrOutputTooLarge
			}
		}
	}
}

func validateToolOutput(path string, maxBytes int64) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("inspect media output: %w", err)
	}
	if !info.Mode().IsRegular() {
		return errors.New("media output is not a regular file")
	}
	if info.Size() < 1 {
		return ErrEmptyOutput
	}
	if info.Size() > maxBytes {
		return ErrOutputTooLarge
	}
	return nil
}

func (t *Tools) runner() Runner {
	if t.Runner != nil {
		return t.Runner
	}
	return NewRunner(t.outputLimit())
}

func (t *Tools) outputLimit() int64 {
	if t.MaxOutputBytes > 0 {
		return t.MaxOutputBytes
	}
	return defaultMaxOutputBytes
}

func (t *Tools) inputLimit() int64 {
	if t.MaxInputBytes > 0 {
		return t.MaxInputBytes
	}
	return defaultMaxInputBytes
}

func (t *Tools) timedContext(ctx context.Context) (context.Context, context.CancelFunc) {
	if ctx == nil {
		ctx = context.Background()
	}
	if t.Timeout <= 0 {
		return ctx, func() {}
	}
	return context.WithTimeout(ctx, t.Timeout)
}

func (t *Tools) ProbeVideo(ctx context.Context, input string) (bool, error) {
	if strings.TrimSpace(input) == "" {
		return false, errors.New("media input path is required")
	}
	ctx, cancel := t.timedContext(ctx)
	defer cancel()
	path := t.FFprobe
	if strings.TrimSpace(path) == "" {
		path = "ffprobe"
	}
	output, err := t.runner().Run(ctx, path,
		"-v", "error",
		"-select_streams", "v:0",
		"-show_entries", "stream=codec_type",
		"-of", "default=nw=1:nk=1",
		input,
	)
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(string(output)) == "video", nil
}

// DecodeStill converts an HEIC/HEIF still to a bounded intermediate image.
// The intermediate path must be temporary and managed by the caller.
func (t *Tools) DecodeStill(ctx context.Context, input, output string) error {
	if strings.TrimSpace(input) == "" || strings.TrimSpace(output) == "" {
		return errors.New("media input and output paths are required")
	}
	ctx, cancel := t.timedContext(ctx)
	defer cancel()
	path := t.HeifConvert
	if strings.TrimSpace(path) == "" {
		path = "heif-convert"
	}
	if err := t.runner().RunToFile(ctx, path, output, input, output); err != nil {
		return err
	}
	return validateToolOutput(output, t.outputLimit())
}

// ExtractVideoFrame renders a poster frame near the beginning of a video. A
// second attempt at timestamp zero handles clips shorter than the seek point.
func (t *Tools) ExtractVideoFrame(ctx context.Context, input, output string) error {
	if strings.TrimSpace(input) == "" || strings.TrimSpace(output) == "" {
		return errors.New("media input and output paths are required")
	}
	ctx, cancel := t.timedContext(ctx)
	defer cancel()
	path := t.FFmpeg
	if strings.TrimSpace(path) == "" {
		path = "ffmpeg"
	}
	if err := t.runFrame(ctx, path, input, output, true); err == nil {
		return nil
	} else if ctx.Err() != nil {
		return ctx.Err()
	}
	_ = os.Remove(output)
	return t.runFrame(ctx, path, input, output, false)
}

func (t *Tools) runFrame(ctx context.Context, executable, input, output string, seek bool) error {
	args := []string{"-v", "error", "-nostdin"}
	if seek {
		args = append(args, "-ss", "0.5")
	}
	args = append(args, "-i", input, "-frames:v", "1", "-vf", "scale=min(1280,iw):-2", "-f", "image2", output)
	return t.runner().RunToFile(ctx, executable, output, args...)
}

// FindEmbeddedMotion validates the bounded trailing ISO-BMFF segment used by
// JPEG MVIMG files. A segment is returned only after FFprobe sees a video
// stream in a temporary copy of that segment.
func (t *Tools) FindEmbeddedMotion(ctx context.Context, input string) (EmbeddedMotion, error) {
	data, err := os.ReadFile(input)
	if err != nil {
		return EmbeddedMotion{}, fmt.Errorf("read embedded motion source: %w", err)
	}
	if int64(len(data)) > t.inputLimit() {
		return EmbeddedMotion{}, ErrOutputTooLarge
	}
	extension := strings.ToLower(filepath.Ext(input))
	if extension == ".heic" || extension == ".heif" {
		video, probeErr := t.ProbeVideo(ctx, input)
		if probeErr != nil {
			return EmbeddedMotion{}, probeErr
		}
		if video {
			return EmbeddedMotion{Size: int64(len(data)), MIME: "video/mp4"}, nil
		}
		return EmbeddedMotion{}, nil
	}
	if !looksLikeJPEG(data) {
		return EmbeddedMotion{}, nil
	}
	offset, ok := locateJPEGMotion(data)
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
	if _, err := temporary.Write(data[offset:]); err != nil {
		cleanup()
		return EmbeddedMotion{}, fmt.Errorf("write embedded motion input: %w", err)
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
	return EmbeddedMotion{Offset: int64(offset), Size: int64(len(data) - offset), MIME: "video/mp4"}, nil
}

func locateJPEGMotion(data []byte) (int, bool) {
	for offset := 2; offset+1 < len(data); offset++ {
		if data[offset] != 0xff || data[offset+1] != 0xd9 {
			continue
		}
		segment := data[offset+2:]
		if validFTYPBox(segment) {
			return offset + 2, true
		}
		return 0, false
	}
	return 0, false
}

func validFTYPBox(data []byte) bool {
	if len(data) < 16 || string(data[4:8]) != "ftyp" {
		return false
	}
	boxSize := uint64(readUint32(data[:4]))
	headerSize := uint64(8)
	if boxSize == 1 {
		if len(data) < 16 {
			return false
		}
		boxSize = uint64(readUint64(data[8:16]))
		headerSize = 16
	}
	if boxSize < headerSize+8 || boxSize > uint64(len(data)) {
		return false
	}
	return true
}

func readUint64(value []byte) uint64 {
	return uint64(value[0])<<56 | uint64(value[1])<<48 | uint64(value[2])<<40 | uint64(value[3])<<32 |
		uint64(value[4])<<24 | uint64(value[5])<<16 | uint64(value[6])<<8 | uint64(value[7])
}

// ExtractMotion validates an input video and atomically writes a derived
// motion artifact. JPEG MVIMG data is copied byte-for-byte after its validated
// JPEG portion; container inputs are stream-copied by FFmpeg.
func (t *Tools) ExtractMotion(ctx context.Context, input, destination string) error {
	if strings.TrimSpace(input) == "" || strings.TrimSpace(destination) == "" {
		return errors.New("media input and destination paths are required")
	}
	if embedded, err := t.FindEmbeddedMotion(ctx, input); err != nil {
		return err
	} else if embedded.Offset > 0 {
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

func (t *Tools) atomicCopyMotion(input, destination string, offset int64) error {
	dir := filepath.Dir(destination)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return fmt.Errorf("create motion destination: %w", err)
	}
	temporaryPath, cleanup, err := newTemporaryOutput(dir, strings.ToLower(filepath.Ext(input)))
	if err != nil {
		return err
	}
	defer cleanup()
	source, err := os.Open(input)
	if err != nil {
		return fmt.Errorf("open embedded motion source: %w", err)
	}
	defer source.Close()
	if _, err := source.Seek(offset, io.SeekStart); err != nil {
		return fmt.Errorf("seek embedded motion source: %w", err)
	}
	output, err := os.OpenFile(temporaryPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o640)
	if err != nil {
		return fmt.Errorf("create motion artifact: %w", err)
	}
	limited := io.LimitReader(source, t.outputLimit()+1)
	written, copyErr := io.Copy(output, limited)
	if copyErr == nil && written > t.outputLimit() {
		copyErr = ErrOutputTooLarge
	}
	if copyErr == nil {
		copyErr = output.Sync()
	}
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(temporaryPath, destination)
}

func (t *Tools) atomicFFmpegCopy(ctx context.Context, input, destination string) error {
	dir := filepath.Dir(destination)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return fmt.Errorf("create motion destination: %w", err)
	}
	extension := strings.ToLower(filepath.Ext(input))
	if extension == ".heic" || extension == ".heif" {
		extension = ".mp4"
	}
	temporaryPath, cleanup, err := newTemporaryOutput(dir, extension)
	if err != nil {
		return err
	}
	defer cleanup()
	ctx, cancel := t.timedContext(ctx)
	defer cancel()
	path := t.FFmpeg
	if strings.TrimSpace(path) == "" {
		path = "ffmpeg"
	}
	if err := t.runner().RunToFile(ctx, path, temporaryPath,
		"-v", "error", "-nostdin", "-i", input, "-map", "0:v:0", "-c", "copy", temporaryPath,
	); err != nil {
		return err
	}
	if err := validateToolOutput(temporaryPath, t.outputLimit()); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, destination); err != nil {
		return fmt.Errorf("commit motion artifact: %w", err)
	}
	return nil
}

func newTemporaryOutput(dir, extension string) (string, func(), error) {
	pattern := ".77photo-motion-*.tmp"
	if extension != "" {
		pattern += extension
	}
	file, err := os.CreateTemp(dir, pattern)
	if err != nil {
		return "", func() {}, fmt.Errorf("create media temporary output: %w", err)
	}
	path := file.Name()
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return "", func() {}, fmt.Errorf("close media temporary output: %w", err)
	}
	if err := os.Remove(path); err != nil {
		return "", func() {}, fmt.Errorf("prepare media temporary output: %w", err)
	}
	return path, func() { _ = os.Remove(path) }, nil
}
