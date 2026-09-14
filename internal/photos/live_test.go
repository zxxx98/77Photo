package photos

import (
	"bytes"
	"context"
	"errors"
	"os"
	"testing"
)

func quickTimeBytes() []byte {
	return []byte{
		0x00, 0x00, 0x00, 0x18,
		'f', 't', 'y', 'p',
		'q', 't', ' ', ' ',
		0x00, 0x00, 0x00, 0x00,
		'q', 't', ' ', ' ',
		'm', 'p', '4', '2',
	}
}

func TestLivePhotoMotionCanBeAttachedDetectedAndRemoved(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	ctx := context.Background()
	photo, err := fixture.service.Upload(ctx, fixture.principal, UploadInput{
		FolderID: fixture.folderID, Filename: "IMG_0001.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(jpegBytes(t, 3, 2)),
	})
	if err != nil {
		t.Fatal(err)
	}
	motion := quickTimeBytes()
	if err := fixture.service.AttachLiveVideo(ctx, fixture.principal, photo.ID, LiveVideoInput{
		Filename: "IMG_0001.MOV", DeclaredMIME: "video/quicktime", Body: bytes.NewReader(motion),
	}); err != nil {
		t.Fatalf("AttachLiveVideo() error = %v", err)
	}
	_, path, err := fixture.service.LiveVideoPath(ctx, fixture.principal, photo.ID)
	if err != nil {
		t.Fatalf("LiveVideoPath() error = %v", err)
	}
	stored, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(stored, motion) {
		t.Fatal("stored live motion differs from upload")
	}
	ids := fixture.service.LivePhotoIDs(ctx, fixture.principal, []string{photo.ID, "missing"})
	if len(ids) != 1 || ids[0] != photo.ID {
		t.Fatalf("LivePhotoIDs() = %v, want [%s]", ids, photo.ID)
	}
	if err := fixture.service.RemoveLiveVideo(ctx, fixture.principal, photo.ID); err != nil {
		t.Fatalf("RemoveLiveVideo() error = %v", err)
	}
	if _, _, err := fixture.service.LiveVideoPath(ctx, fixture.principal, photo.ID); !errors.Is(err, ErrLiveMotionNotFound) {
		t.Fatalf("LiveVideoPath() after removal error = %v, want ErrLiveMotionNotFound", err)
	}
}

func TestLivePhotoMotionRejectsInvalidMedia(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	ctx := context.Background()
	photo, err := fixture.service.Upload(ctx, fixture.principal, UploadInput{
		FolderID: fixture.folderID, Filename: "IMG_0002.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(jpegBytes(t, 2, 2)),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := fixture.service.AttachLiveVideo(ctx, fixture.principal, photo.ID, LiveVideoInput{
		Filename: "IMG_0002.mov", DeclaredMIME: "video/quicktime", Body: bytes.NewReader([]byte("not a movie")),
	}); !errors.Is(err, ErrInvalidMedia) {
		t.Fatalf("AttachLiveVideo(invalid) error = %v, want ErrInvalidMedia", err)
	}
}

func TestLivePhotoMotionUsesUploadSizeLimit(t *testing.T) {
	fixture := newUploadFixture(t, 16)
	ctx := context.Background()
	photo, err := fixture.service.Upload(ctx, fixture.principal, UploadInput{
		FolderID: fixture.folderID, Filename: "IMG_0003.jpg", DeclaredMIME: "image/jpeg", Body: bytes.NewReader(jpegBytes(t, 1, 1)),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := fixture.service.AttachLiveVideo(ctx, fixture.principal, photo.ID, LiveVideoInput{
		Filename: "IMG_0003.mov", DeclaredMIME: "video/quicktime", Body: bytes.NewReader(quickTimeBytes()),
	}); !errors.Is(err, ErrUploadTooLarge) {
		t.Fatalf("AttachLiveVideo(oversize) error = %v, want ErrUploadTooLarge", err)
	}
}
