package media

import (
	"context"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestInspectBytesRecognizesSupportedMedia(t *testing.T) {
	checks := []struct {
		name     string
		filename string
		declared string
		data     []byte
		wantMIME string
		wantKind Kind
	}{
		{"jpeg", "photo.jpg", "image/jpeg", []byte{0xff, 0xd8, 0xff, 0xe0}, "image/jpeg", KindStill},
		{"jpeg alternate extension", "photo.jpeg", "image/jpg", []byte{0xff, 0xd8, 0xff, 0xe0}, "image/jpeg", KindStill},
		{"png", "photo.png", "image/png", []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}, "image/png", KindStill},
		{"heic major brand", "photo.heic", "image/heic", ftypBytes("heic"), "image/heic", KindStill},
		{"heic compatible brand", "photo.heic", "image/heic", ftypBytes("hevx"), "image/heic", KindStill},
		{"heif major brand", "photo.heif", "image/heif", ftypBytes("mif1"), "image/heif", KindStill},
		{"heif sequence brand", "photo.heif", "image/heif", ftypBytes("msf1"), "image/heif", KindStill},
		{"mp4", "clip.mp4", "video/mp4", ftypBytes("isom"), "video/mp4", KindVideo},
		{"webm", "clip.webm", "video/webm", []byte{0x1a, 0x45, 0xdf, 0xa3}, "video/webm", KindVideo},
	}
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			got, err := InspectBytes(check.filename, check.declared, check.data)
			if err != nil {
				t.Fatal(err)
			}
			if got.MIME != check.wantMIME {
				t.Fatalf("MIME = %q, want %q", got.MIME, check.wantMIME)
			}
			if got.Kind != check.wantKind {
				t.Fatalf("kind = %q, want %q", got.Kind, check.wantKind)
			}
			if got.Embedded {
				t.Fatal("plain media must not be marked embedded")
			}
		})
	}
}

func TestInspectBytesRejectsMismatchedExtensionAndSignature(t *testing.T) {
	checks := []struct {
		name     string
		filename string
		declared string
		data     []byte
	}{
		{"jpeg named heic", "photo.heic", "image/heic", []byte{0xff, 0xd8, 0xff, 0xe0}},
		{"unknown heif brand", "photo.heic", "image/heic", ftypBytes("zzzz")},
		{"heif named jpeg", "photo.jpg", "image/jpeg", ftypBytes("mif1")},
		{"wrong declared MIME", "photo.png", "image/jpeg", []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}},
	}
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			if _, err := InspectBytes(check.filename, check.declared, check.data); !errors.Is(err, ErrUnsupported) {
				t.Fatalf("error = %v, want ErrUnsupported", err)
			}
		})
	}
}

func ftypBytes(brand string) []byte {
	data := make([]byte, 24)
	binary.BigEndian.PutUint32(data[:4], uint32(len(data)))
	copy(data[4:8], "ftyp")
	copy(data[8:12], brand)
	copy(data[16:20], brand)
	return data
}

type fakeRunner struct {
	mu       sync.Mutex
	runArgs  [][]string
	fileArgs [][]string
	runOut   []byte
	exifOut  []byte
	runErr   error
	fileErr  error
}

func (r *fakeRunner) Run(_ context.Context, executable string, args ...string) ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.runArgs = append(r.runArgs, append([]string{executable}, args...))
	return append([]byte(nil), r.runOut...), r.runErr
}

func (r *fakeRunner) RunToFile(_ context.Context, executable, output string, args ...string) error {
	r.mu.Lock()
	r.fileArgs = append(r.fileArgs, append([]string{executable, output}, args...))
	r.mu.Unlock()
	if r.fileErr != nil {
		return r.fileErr
	}
	if err := os.WriteFile(output, []byte("extracted-video"), 0o640); err != nil {
		return err
	}
	if len(r.exifOut) > 0 {
		if err := os.WriteFile(output+".exif", r.exifOut, 0o640); err != nil {
			return err
		}
	}
	return nil
}

func TestProbeCapturedAtPrefersQuickTimeCreationDate(t *testing.T) {
	runner := &fakeRunner{runOut: []byte(`{
		"format":{"tags":{"creation_time":"2026-09-18T12:00:00Z","com.apple.quicktime.creationdate":"2024-05-20T10:30:00-07:00"}},
		"streams":[{"tags":{"creation_time":"2025-01-01T00:00:00Z"}}]
	}`)}
	tools := Tools{FFprobe: "/usr/bin/ffprobe", Runner: runner, Timeout: time.Second}

	captured, ok, err := tools.ProbeCapturedAt(context.Background(), "/tmp/photo.heic")
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("ProbeCapturedAt() ok = false, want true")
	}
	want := time.Date(2024, 5, 20, 17, 30, 0, 0, time.UTC)
	if !captured.Equal(want) {
		t.Fatalf("captured = %v, want %v", captured, want)
	}
	if len(runner.runArgs) != 1 {
		t.Fatalf("Run calls = %d, want 1", len(runner.runArgs))
	}
	args := strings.Join(runner.runArgs[0], "\x00")
	if !strings.Contains(args, "com.apple.quicktime.creationdate") || !strings.Contains(args, "creation_time") {
		t.Fatalf("ffprobe args = %#v, want capture metadata tags", runner.runArgs[0])
	}
}

func TestProbeCapturedAtFallsBackToStreamCreationTime(t *testing.T) {
	runner := &fakeRunner{runOut: []byte(`{"format":{"tags":{}},"streams":[{"tags":{"creation_time":"2023-02-03T04:05:06.123456Z"}}]}`)}
	tools := Tools{Runner: runner, Timeout: time.Second}

	captured, ok, err := tools.ProbeCapturedAt(context.Background(), "/tmp/clip.mp4")
	if err != nil {
		t.Fatal(err)
	}
	if !ok || captured.UTC().Format(time.RFC3339Nano) != "2023-02-03T04:05:06.123456Z" {
		t.Fatalf("ProbeCapturedAt() = %v, %v", captured, ok)
	}
}

func TestProbeCapturedAtMissingMetadataIsNotAnError(t *testing.T) {
	runner := &fakeRunner{runOut: []byte(`{"format":{"tags":{}},"streams":[]}`)}
	tools := Tools{Runner: runner, Timeout: time.Second}

	captured, ok, err := tools.ProbeCapturedAt(context.Background(), "/tmp/photo.heic")
	if err != nil {
		t.Fatal(err)
	}
	if ok || !captured.IsZero() {
		t.Fatalf("ProbeCapturedAt() = %v, %v; want zero,false", captured, ok)
	}
}

func TestToolsPassArgumentsSeparately(t *testing.T) {
	runner := &fakeRunner{runOut: []byte("video\n")}
	tools := Tools{FFprobe: "/usr/bin/ffprobe", Runner: runner, Timeout: time.Second}

	video, err := tools.ProbeVideo(context.Background(), "/tmp/input with spaces.mov")
	if err != nil {
		t.Fatal(err)
	}
	if !video {
		t.Fatal("ProbeVideo() = false, want true")
	}
	if len(runner.runArgs) != 1 {
		t.Fatalf("Run calls = %d, want 1", len(runner.runArgs))
	}
	want := []string{"/usr/bin/ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type", "-of", "default=nw=1:nk=1", "/tmp/input with spaces.mov"}
	if strings.Join(runner.runArgs[0], "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("Run args = %#v, want %#v", runner.runArgs[0], want)
	}
}

func TestDecodeStillWithEXIFRequestsSidecar(t *testing.T) {
	runner := &fakeRunner{exifOut: []byte("II*\x00test-exif")}
	tools := Tools{HeifConvert: "/usr/bin/heif-convert", Runner: runner, Timeout: time.Second}
	output := filepath.Join(t.TempDir(), "decoded.png")

	exifPath, err := tools.DecodeStillWithEXIF(context.Background(), "/tmp/photo.heic", output)
	if err != nil {
		t.Fatal(err)
	}
	if exifPath != output+".exif" {
		t.Fatalf("EXIF path = %q, want %q", exifPath, output+".exif")
	}
	if len(runner.fileArgs) != 1 {
		t.Fatalf("RunToFile calls = %d, want 1", len(runner.fileArgs))
	}
	args := strings.Join(runner.fileArgs[0], "\x00")
	if !strings.Contains(args, "--with-exif") || !strings.Contains(args, "--skip-exif-offset") {
		t.Fatalf("heif-convert args = %#v, want EXIF export flags", runner.fileArgs[0])
	}
}

func TestCommandRunnerContextCancellationStopsCommand(t *testing.T) {
	runner := NewRunner(1024)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := runner.Run(ctx, "sleep", "10")
		done <- err
	}()
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Run() error = %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Run() did not stop after context cancellation")
	}
}

func TestCommandRunnerRemovesOutputAboveLimit(t *testing.T) {
	destination := filepath.Join(t.TempDir(), "oversized.mp4")
	runner := NewRunner(4)
	err := runner.RunToFile(context.Background(), "dd", destination, "if=/dev/zero", "of="+destination, "bs=8", "count=1", "status=none")
	if !errors.Is(err, ErrOutputTooLarge) {
		t.Fatalf("RunToFile() error = %v, want ErrOutputTooLarge", err)
	}
	if _, statErr := os.Stat(destination); !os.IsNotExist(statErr) {
		t.Fatalf("oversized output stat error = %v, want not exists", statErr)
	}
}

func TestCommandRunnerRunToFileHandlesPreCanceledContext(t *testing.T) {
	destination := filepath.Join(t.TempDir(), "canceled.mp4")
	runner := NewRunner(1024)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := runner.RunToFile(ctx, "sleep", destination, "1")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("RunToFile() error = %v, want context.Canceled", err)
	}
	if _, statErr := os.Stat(destination); !os.IsNotExist(statErr) {
		t.Fatalf("canceled output stat error = %v, want not exists", statErr)
	}
}

func TestFindEmbeddedMotionRequiresVideoStream(t *testing.T) {
	input := filepath.Join(t.TempDir(), "MVIMG_0001.JPG")
	jpeg := []byte{0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0xff, 0xd9}
	video := ftypBytes("isom")
	if err := os.WriteFile(input, append(jpeg, video...), 0o640); err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{runOut: []byte("video\n")}
	tools := Tools{FFprobe: "ffprobe", Runner: runner, Timeout: time.Second, MaxOutputBytes: 1 << 20}
	motion, err := tools.FindEmbeddedMotion(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if motion.Offset != int64(len(jpeg)) || motion.Size != int64(len(video)) {
		t.Fatalf("motion = %#v, want offset %d size %d", motion, len(jpeg), len(video))
	}

	runner.runOut = []byte("audio\n")
	motion, err = tools.FindEmbeddedMotion(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if motion.Offset != 0 || motion.Size != 0 {
		t.Fatalf("audio-only motion = %#v, want empty", motion)
	}
}

func TestFindEmbeddedMotionDetectsHEICVideoContainer(t *testing.T) {
	input := filepath.Join(t.TempDir(), "photo.heic")
	data := ftypBytes("heic")
	if err := os.WriteFile(input, data, 0o640); err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{runOut: []byte("video\n")}
	tools := Tools{FFprobe: "ffprobe", Runner: runner, Timeout: time.Second, MaxOutputBytes: 1 << 20}

	motion, err := tools.FindEmbeddedMotion(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if motion.Size != int64(len(data)) || motion.MIME != "video/mp4" {
		t.Fatalf("motion = %#v, want container motion of %d bytes", motion, len(data))
	}
	if len(runner.runArgs) != 1 || runner.runArgs[0][len(runner.runArgs[0])-1] != input {
		t.Fatalf("probe args = %#v, want direct HEIC input", runner.runArgs)
	}
}

func TestFindEmbeddedMotionBoundedChecksSizeBeforeReading(t *testing.T) {
	input := filepath.Join(t.TempDir(), "photo.heic")
	if err := os.Mkdir(input, 0o750); err != nil {
		t.Fatal(err)
	}
	tools := Tools{MaxInputBytes: 1}

	_, err := tools.FindEmbeddedMotionBounded(context.Background(), input)
	if !errors.Is(err, ErrOutputTooLarge) {
		t.Fatalf("FindEmbeddedMotionBounded() error = %v, want ErrOutputTooLarge", err)
	}
}

func TestFindEmbeddedMotionRejectsForgedBoxBounds(t *testing.T) {
	input := filepath.Join(t.TempDir(), "MVIMG_0002.jpg")
	jpeg := []byte{0xff, 0xd8, 0xff, 0xd9}
	forged := make([]byte, 16)
	binary.BigEndian.PutUint32(forged[:4], 0xfffffff0)
	copy(forged[4:8], "ftyp")
	copy(forged[8:12], "isom")
	if err := os.WriteFile(input, append(jpeg, forged...), 0o640); err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{runOut: []byte("video\n")}
	tools := Tools{FFprobe: "ffprobe", Runner: runner, Timeout: time.Second, MaxOutputBytes: 1 << 20}
	motion, err := tools.FindEmbeddedMotion(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if motion.Offset != 0 || motion.Size != 0 {
		t.Fatalf("forged motion = %#v, want empty", motion)
	}
	if len(runner.runArgs) != 0 {
		t.Fatalf("Run calls = %d, want 0 for forged box", len(runner.runArgs))
	}
}

func TestExtractMotionIsAtomic(t *testing.T) {
	input := filepath.Join(t.TempDir(), "motion.mov")
	if err := os.WriteFile(input, []byte("source"), 0o640); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(t.TempDir(), "live", "photo.motion")
	runner := &fakeRunner{runOut: []byte("video\n")}
	tools := Tools{FFmpeg: "ffmpeg", FFprobe: "ffprobe", Runner: runner, Timeout: time.Second, MaxOutputBytes: 1 << 20}
	if err := tools.ExtractMotion(context.Background(), input, destination); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "extracted-video" {
		t.Fatalf("destination = %q, want extracted video", data)
	}
	if len(runner.fileArgs) != 1 || runner.fileArgs[0][1] == destination {
		t.Fatalf("RunToFile args = %#v, want a temporary output", runner.fileArgs)
	}
	if _, err := os.Stat(runner.fileArgs[0][1]); !os.IsNotExist(err) {
		t.Fatalf("temporary output stat error = %v, want not exists", err)
	}

	failing := &fakeRunner{runOut: []byte("video\n"), fileErr: errors.New("ffmpeg failed")}
	failingTools := Tools{FFmpeg: "ffmpeg", FFprobe: "ffprobe", Runner: failing, Timeout: time.Second, MaxOutputBytes: 1 << 20}
	failedDestination := filepath.Join(t.TempDir(), "live", "failed.motion")
	if err := failingTools.ExtractMotion(context.Background(), input, failedDestination); err == nil {
		t.Fatal("ExtractMotion() error = nil, want failure")
	}
	if _, err := os.Stat(failedDestination); !os.IsNotExist(err) {
		t.Fatalf("failed destination stat error = %v, want not exists", err)
	}
}

func TestExtractMotionUsesVideoContainerForHEIC(t *testing.T) {
	input := filepath.Join(t.TempDir(), "photo.heic")
	if err := os.WriteFile(input, ftypBytes("heic"), 0o640); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(t.TempDir(), "live", "photo.motion")
	runner := &fakeRunner{runOut: []byte("video\n")}
	tools := Tools{FFmpeg: "ffmpeg", FFprobe: "ffprobe", Runner: runner, Timeout: time.Second, MaxOutputBytes: 1 << 20}

	if err := tools.ExtractMotion(context.Background(), input, destination); err != nil {
		t.Fatal(err)
	}
	if len(runner.fileArgs) != 1 {
		t.Fatalf("RunToFile calls = %d, want one", len(runner.fileArgs))
	}
	if extension := strings.ToLower(filepath.Ext(runner.fileArgs[0][1])); extension != ".mp4" {
		t.Fatalf("temporary video output extension = %q, want .mp4", extension)
	}
}
