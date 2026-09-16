package media

import (
	"errors"
	"path/filepath"
	"strings"
)

func MIMEForExtension(filename string) string {
	switch strings.ToLower(filepath.Ext(strings.TrimSpace(filename))) {
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".heic":
		return "image/heic"
	case ".heif":
		return "image/heif"
	case ".mp4":
		return "video/mp4"
	case ".webm":
		return "video/webm"
	default:
		return ""
	}
}

type Kind string

const (
	KindStill Kind = "still"
	KindVideo Kind = "video"
)

type Inspection struct {
	MIME     string
	Kind     Kind
	Embedded bool
}

var ErrUnsupported = errors.New("unsupported media")

func InspectBytes(filename, declared string, head []byte) (Inspection, error) {
	extension := strings.ToLower(filepath.Ext(strings.TrimSpace(filename)))
	declared = strings.ToLower(strings.TrimSpace(declared))
	if declared == "image/jpg" {
		declared = "image/jpeg"
	}

	switch extension {
	case ".jpg", ".jpeg":
		if declared != "image/jpeg" || !looksLikeJPEG(head) {
			return Inspection{}, ErrUnsupported
		}
		return Inspection{MIME: "image/jpeg", Kind: KindStill}, nil
	case ".png":
		if declared != "image/png" || !looksLikePNG(head) {
			return Inspection{}, ErrUnsupported
		}
		return Inspection{MIME: "image/png", Kind: KindStill}, nil
	case ".heic":
		if declared != "image/heic" || !looksLikeHEIC(head) {
			return Inspection{}, ErrUnsupported
		}
		return Inspection{MIME: "image/heic", Kind: KindStill}, nil
	case ".heif":
		if declared != "image/heif" || !looksLikeHEIF(head) {
			return Inspection{}, ErrUnsupported
		}
		return Inspection{MIME: "image/heif", Kind: KindStill}, nil
	case ".mp4":
		if declared != "video/mp4" || !looksLikeMP4(head) {
			return Inspection{}, ErrUnsupported
		}
		return Inspection{MIME: "video/mp4", Kind: KindVideo}, nil
	case ".webm":
		if declared != "video/webm" || !looksLikeWebM(head) {
			return Inspection{}, ErrUnsupported
		}
		return Inspection{MIME: "video/webm", Kind: KindVideo}, nil
	default:
		return Inspection{}, ErrUnsupported
	}
}

func looksLikeJPEG(head []byte) bool {
	return len(head) >= 3 && head[0] == 0xff && head[1] == 0xd8 && head[2] == 0xff
}

func looksLikePNG(head []byte) bool {
	return len(head) >= 8 && string(head[:8]) == "\x89PNG\r\n\x1a\n"
}

func looksLikeWebM(head []byte) bool {
	return len(head) >= 4 && string(head[:4]) == "\x1a\x45\xdf\xa3"
}

func looksLikeHEIF(head []byte) bool {
	major, compatible, ok := parseFTYP(head)
	if !ok {
		return false
	}
	return isHEIFBrand(major) || containsBrand(compatible, isHEIFBrand)
}

func looksLikeHEIC(head []byte) bool {
	major, compatible, ok := parseFTYP(head)
	if !ok {
		return false
	}
	return isHEICBrand(major) || containsBrand(compatible, isHEICBrand)
}

func looksLikeMP4(head []byte) bool {
	major, compatible, ok := parseFTYP(head)
	if !ok || isHEIFBrand(major) {
		return false
	}
	return isMP4Brand(major) || containsBrand(compatible, isMP4Brand)
}

func parseFTYP(head []byte) (string, []string, bool) {
	if len(head) < 16 || string(head[4:8]) != "ftyp" {
		return "", nil, false
	}
	boxSize := int(readUint32(head[:4]))
	if boxSize != 0 && boxSize < 16 {
		return "", nil, false
	}
	limit := len(head)
	if boxSize > 0 && boxSize < limit {
		limit = boxSize
	}
	if limit < 16 {
		return "", nil, false
	}
	major := string(head[8:12])
	compatible := make([]string, 0, (limit-16)/4)
	for offset := 16; offset+4 <= limit; offset += 4 {
		compatible = append(compatible, string(head[offset:offset+4]))
	}
	return major, compatible, true
}

func readUint32(value []byte) uint32 {
	return uint32(value[0])<<24 | uint32(value[1])<<16 | uint32(value[2])<<8 | uint32(value[3])
}

func containsBrand(brands []string, match func(string) bool) bool {
	for _, brand := range brands {
		if match(brand) {
			return true
		}
	}
	return false
}

func isHEIFBrand(brand string) bool {
	switch brand {
	case "mif1", "msf1":
		return true
	default:
		return false
	}
}

func isHEICBrand(brand string) bool {
	switch brand {
	case "heic", "heix", "hevc", "hevx":
		return true
	default:
		return false
	}
}

func isMP4Brand(brand string) bool {
	switch brand {
	case "isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ":
		return true
	default:
		return false
	}
}
