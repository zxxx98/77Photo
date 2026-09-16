package media

import (
	"encoding/binary"
	"errors"
	"testing"
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
