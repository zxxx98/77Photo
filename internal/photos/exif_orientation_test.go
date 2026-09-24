package photos

import (
	"bytes"
	"context"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

// jpegWithEXIFOrientation returns a JPEG whose EXIF APP1 segment carries the
// supplied Orientation tag value.
//
// Cameras and editors routinely write 0 ("undefined") — Meitu exports
// (MTXX_*), Meitu-processed files (*_mh*) and Android motion photos
// (MVIMG_*) all do. The photos.orientation CHECK constraint only allows
// NULL or 1..8, so storing 0 used to fail the whole INSERT and silently drop
// the photo from the library.
func jpegWithEXIFOrientation(t *testing.T, orientation uint16) []byte {
	t.Helper()
	base := jpegBytes(t, 4, 4)

	tiff := &bytes.Buffer{}
	tiff.WriteString("II")
	_ = binary.Write(tiff, binary.LittleEndian, uint16(0x002a))
	_ = binary.Write(tiff, binary.LittleEndian, uint32(8)) // IFD0 offset
	_ = binary.Write(tiff, binary.LittleEndian, uint16(1)) // one entry
	_ = binary.Write(tiff, binary.LittleEndian, uint16(0x0112))
	_ = binary.Write(tiff, binary.LittleEndian, uint16(3)) // SHORT
	_ = binary.Write(tiff, binary.LittleEndian, uint32(1)) // count
	_ = binary.Write(tiff, binary.LittleEndian, orientation)
	_ = binary.Write(tiff, binary.LittleEndian, uint16(0)) // pad value to 4 bytes
	_ = binary.Write(tiff, binary.LittleEndian, uint32(0)) // next IFD

	payload := append([]byte("Exif\x00\x00"), tiff.Bytes()...)
	segment := &bytes.Buffer{}
	segment.Write([]byte{0xff, 0xe1})
	_ = binary.Write(segment, binary.BigEndian, uint16(len(payload)+2))
	segment.Write(payload)

	out := &bytes.Buffer{}
	out.Write(base[:2]) // SOI
	out.Write(segment.Bytes())
	out.Write(base[2:])
	return out.Bytes()
}

func writeTempJPEG(t *testing.T, data []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "photo.jpg")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestExtractMetadataDropsUndefinedEXIFOrientation(t *testing.T) {
	// 0 is what Meitu and Android motion photos write for "undefined";
	// 9 is simply out of range. Neither may reach the database, because
	// photos.orientation only allows NULL or 1..8.
	for _, orientation := range []uint16{0, 9} {
		path := writeTempJPEG(t, jpegWithEXIFOrientation(t, orientation))
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		metadata, err := extractMetadata(path, "image/jpeg", info.Size())
		if err != nil {
			t.Fatalf("orientation %d: extractMetadata() error = %v", orientation, err)
		}
		if metadata.orientation != nil {
			t.Fatalf("orientation %d: metadata.orientation = %d, want nil", orientation, *metadata.orientation)
		}
	}
}

func TestExtractMetadataKeepsValidEXIFOrientation(t *testing.T) {
	path := writeTempJPEG(t, jpegWithEXIFOrientation(t, 6))
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	metadata, err := extractMetadata(path, "image/jpeg", info.Size())
	if err != nil {
		t.Fatal(err)
	}
	if metadata.orientation == nil || *metadata.orientation != 6 {
		t.Fatalf("metadata.orientation = %v, want 6", metadata.orientation)
	}
}

func TestUploadAcceptsUndefinedEXIFOrientation(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	photo, err := fixture.service.Upload(context.Background(), fixture.principal, UploadInput{
		FolderID:     fixture.folderID,
		Filename:     "MVIMG_20260221_080650.jpg",
		DeclaredMIME: "image/jpeg",
		Body:         bytes.NewReader(jpegWithEXIFOrientation(t, 0)),
	})
	if err != nil {
		t.Fatalf("Upload() with EXIF orientation 0 error = %v", err)
	}
	if photo.Orientation != nil {
		t.Fatalf("orientation = %d, want nil for undefined EXIF orientation", *photo.Orientation)
	}
	// The row must be visible to the timeline, not merely inserted.
	page, err := fixture.service.List(context.Background(), fixture.principal, ListFilter{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != photo.ID {
		t.Fatalf("timeline items = %+v, want the uploaded photo", page.Items)
	}
}
