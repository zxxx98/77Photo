package photos

import (
	"bytes"
	"context"
	"encoding/binary"
	"math"
	"os"
	"sort"
	"testing"
	"time"

	"github.com/zxxx98/77Photo/internal/media"
)

type tiffEntry struct {
	tag   uint16
	kind  uint16 // 2 ASCII, 3 SHORT, 4 LONG, 5 RATIONAL
	count uint32
	value []byte
}

func asciiEntry(tag uint16, value string) tiffEntry {
	data := append([]byte(value), 0)
	return tiffEntry{tag: tag, kind: 2, count: uint32(len(data)), value: data}
}

func shortEntry(tag, value uint16) tiffEntry {
	return tiffEntry{tag: tag, kind: 3, count: 1, value: binary.LittleEndian.AppendUint16(nil, value)}
}

func rationalEntry(tag uint16, values ...[2]uint32) tiffEntry {
	data := make([]byte, 0, 8*len(values))
	for _, value := range values {
		data = binary.LittleEndian.AppendUint32(data, value[0])
		data = binary.LittleEndian.AppendUint32(data, value[1])
	}
	return tiffEntry{tag: tag, kind: 5, count: uint32(len(values)), value: data}
}

// degrees encodes an absolute coordinate the way cameras usually do: whole
// degrees, whole minutes and seconds in hundredths.
func degrees(value float64) [][2]uint32 {
	value = math.Abs(value)
	whole := math.Floor(value)
	minutes := math.Floor((value - whole) * 60)
	seconds := ((value-whole)*60 - minutes) * 60
	return [][2]uint32{{uint32(whole), 1}, {uint32(minutes), 1}, {uint32(math.Round(seconds * 100)), 100}}
}

func gpsEntries(latitudeRef string, latitude float64, longitudeRef string, longitude float64) []tiffEntry {
	return []tiffEntry{
		asciiEntry(0x0001, latitudeRef),
		rationalEntry(0x0002, degrees(latitude)...),
		asciiEntry(0x0003, longitudeRef),
		rationalEntry(0x0004, degrees(longitude)...),
	}
}

// exifTIFF lays out IFD0 with optional Exif and GPS sub-IFDs. Values longer
// than four bytes follow their IFD; sub-IFD pointers are patched once every
// offset is known.
func exifTIFF(exifIFD, gpsIFD []tiffEntry) []byte {
	var ifd0 []tiffEntry
	if len(exifIFD) > 0 {
		ifd0 = append(ifd0, tiffEntry{tag: 0x8769, kind: 4, count: 1, value: make([]byte, 4)})
	}
	if len(gpsIFD) > 0 {
		ifd0 = append(ifd0, tiffEntry{tag: 0x8825, kind: 4, count: 1, value: make([]byte, 4)})
	}
	size := func(entries []tiffEntry) int {
		total := 2 + 12*len(entries) + 4
		for _, entry := range entries {
			if len(entry.value) > 4 {
				total += len(entry.value) + len(entry.value)%2
			}
		}
		return total
	}
	offset := 8 + size(ifd0)
	pointers := map[uint16]int{}
	if len(exifIFD) > 0 {
		pointers[0x8769] = offset
		offset += size(exifIFD)
	}
	if len(gpsIFD) > 0 {
		pointers[0x8825] = offset
	}
	for _, entry := range ifd0 {
		binary.LittleEndian.PutUint32(entry.value, uint32(pointers[entry.tag]))
	}

	out := &bytes.Buffer{}
	out.WriteString("II")
	_ = binary.Write(out, binary.LittleEndian, uint16(42))
	_ = binary.Write(out, binary.LittleEndian, uint32(8))
	for _, entries := range [][]tiffEntry{ifd0, exifIFD, gpsIFD} {
		if len(entries) == 0 {
			continue
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].tag < entries[j].tag })
		valueOffset := out.Len() + 2 + 12*len(entries) + 4
		_ = binary.Write(out, binary.LittleEndian, uint16(len(entries)))
		for _, entry := range entries {
			_ = binary.Write(out, binary.LittleEndian, entry.tag)
			_ = binary.Write(out, binary.LittleEndian, entry.kind)
			_ = binary.Write(out, binary.LittleEndian, entry.count)
			if len(entry.value) <= 4 {
				inline := make([]byte, 4)
				copy(inline, entry.value)
				out.Write(inline)
				continue
			}
			_ = binary.Write(out, binary.LittleEndian, uint32(valueOffset))
			valueOffset += len(entry.value) + len(entry.value)%2
		}
		_ = binary.Write(out, binary.LittleEndian, uint32(0))
		for _, entry := range entries {
			if len(entry.value) > 4 {
				out.Write(entry.value)
				if len(entry.value)%2 == 1 {
					out.WriteByte(0)
				}
			}
		}
	}
	return out.Bytes()
}

func jpegWithEXIF(t *testing.T, exifIFD, gpsIFD []tiffEntry) []byte {
	t.Helper()
	base := jpegBytes(t, 4, 4)
	payload := append([]byte("Exif\x00\x00"), exifTIFF(exifIFD, gpsIFD)...)
	segment := &bytes.Buffer{}
	segment.Write([]byte{0xff, 0xe1})
	_ = binary.Write(segment, binary.BigEndian, uint16(len(payload)+2))
	segment.Write(payload)
	out := &bytes.Buffer{}
	out.Write(base[:2])
	out.Write(segment.Bytes())
	out.Write(base[2:])
	return out.Bytes()
}

func metadataFor(t *testing.T, data []byte) imageMetadata {
	t.Helper()
	path := writeTempJPEG(t, data)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	metadata, err := extractMetadata(path, "image/jpeg", info.Size())
	if err != nil {
		t.Fatal(err)
	}
	return metadata
}

func assertLocation(t *testing.T, latitude, longitude *float64, wantLatitude, wantLongitude float64) {
	t.Helper()
	if latitude == nil || longitude == nil {
		t.Fatalf("location = %v, %v; want %v, %v", latitude, longitude, wantLatitude, wantLongitude)
	}
	if math.Abs(*latitude-wantLatitude) > 1e-6 || math.Abs(*longitude-wantLongitude) > 1e-6 {
		t.Fatalf("location = %v, %v; want %v, %v", *latitude, *longitude, wantLatitude, wantLongitude)
	}
}

func TestExtractMetadataReadsEXIFLocation(t *testing.T) {
	checks := []struct {
		name                        string
		latitudeRef, longitudeRef   string
		latitude, longitude         float64
		wantLatitude, wantLongitude float64
	}{
		{"north east", "N", "E", 31.2304, 121.4737, 31.2304, 121.4737},
		{"south west", "S", "W", 22.9068, 43.1729, -22.9068, -43.1729},
	}
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			metadata := metadataFor(t, jpegWithEXIF(t, nil, gpsEntries(check.latitudeRef, check.latitude, check.longitudeRef, check.longitude)))
			assertLocation(t, metadata.gpsLatitude, metadata.gpsLongitude, check.wantLatitude, check.wantLongitude)
		})
	}
}

func TestExtractMetadataIgnoresUnusableEXIFLocation(t *testing.T) {
	checks := []struct {
		name string
		gps  []tiffEntry
	}{
		{"null island", gpsEntries("N", 0, "E", 0)},
		{"latitude out of range", gpsEntries("N", 95, "E", 121.4737)},
		{"missing references", []tiffEntry{rationalEntry(0x0002, degrees(31.2304)...), rationalEntry(0x0004, degrees(121.4737)...)}},
		// goexif indexes the rationals without checking the count and would
		// panic on this tag; indexing must survive it.
		{"empty latitude", []tiffEntry{asciiEntry(0x0001, "N"), {tag: 0x0002, kind: 5, count: 0}, asciiEntry(0x0003, "E"), rationalEntry(0x0004, degrees(121.4737)...)}},
	}
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			metadata := metadataFor(t, jpegWithEXIF(t, nil, check.gps))
			if metadata.gpsLatitude != nil || metadata.gpsLongitude != nil {
				t.Fatalf("location = %v, %v; want none", metadata.gpsLatitude, metadata.gpsLongitude)
			}
		})
	}
}

func TestExtractMetadataReadsExposureFields(t *testing.T) {
	metadata := metadataFor(t, jpegWithEXIF(t, []tiffEntry{
		rationalEntry(0x829D, [2]uint32{18, 10}),
		shortEntry(0x8827, 100),
		rationalEntry(0x920A, [2]uint32{425, 100}),
	}, nil))
	if metadata.aperture == nil || *metadata.aperture != 1.8 {
		t.Fatalf("aperture = %v, want 1.8", metadata.aperture)
	}
	if metadata.focalLength == nil || *metadata.focalLength != 4.25 {
		t.Fatalf("focal length = %v, want 4.25", metadata.focalLength)
	}
	if metadata.iso == nil || *metadata.iso != 100 {
		t.Fatalf("ISO = %v, want 100", metadata.iso)
	}
}

func TestExtractMetadataDropsUnknownExposureFields(t *testing.T) {
	metadata := metadataFor(t, jpegWithEXIF(t, []tiffEntry{
		rationalEntry(0x829D, [2]uint32{18, 0}),
		shortEntry(0x8827, 0),
		rationalEntry(0x920A, [2]uint32{0, 1}),
	}, nil))
	if metadata.aperture != nil || metadata.focalLength != nil || metadata.iso != nil {
		t.Fatalf("exposure = %v/%v/%v, want all unknown", metadata.aperture, metadata.focalLength, metadata.iso)
	}
}

func TestUploadStoresVideoContainerLocation(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	fixture.service.SetMediaTools(&media.Tools{
		Runner:  &captureMetadataRunner{output: []byte(`{"format":{"tags":{"creation_time":"2021-03-04T05:06:07Z","location":"+37.4219-122.0840/"}},"streams":[]}`)},
		Timeout: time.Second,
	})
	photo, err := fixture.service.Upload(context.Background(), fixture.principal, UploadInput{
		FolderID: fixture.folderID, Filename: "clip.mp4", DeclaredMIME: "video/mp4", Body: bytes.NewReader(testMP4Header()),
	})
	if err != nil {
		t.Fatal(err)
	}
	assertLocation(t, photo.GPSLatitude, photo.GPSLongitude, 37.4219, -122.0840)
}

func TestRescanBackfillsLocationForUnchangedFile(t *testing.T) {
	fixture := newUploadFixture(t, 1<<20)
	ctx := context.Background()
	photo, err := fixture.service.Upload(ctx, fixture.principal, UploadInput{
		FolderID: fixture.folderID, Filename: "trip.jpg", DeclaredMIME: "image/jpeg",
		Body: bytes.NewReader(jpegWithEXIF(t, nil, gpsEntries("N", 31.2304, "E", 121.4737))),
	})
	if err != nil {
		t.Fatal(err)
	}
	// Rows indexed before location extraction existed have no position.
	if _, err := fixture.service.db.ExecContext(ctx, "UPDATE photos SET gps_latitude=NULL, gps_longitude=NULL WHERE id=?", photo.ID); err != nil {
		t.Fatal(err)
	}
	added, err := fixture.service.IndexScannedFile(ctx, photo.OwnerID, photo.FolderID, photo.StoragePath)
	if err != nil {
		t.Fatal(err)
	}
	if added {
		t.Fatal("IndexScannedFile() added = true, want update of existing row")
	}
	reloaded, err := fixture.service.Get(ctx, fixture.principal, photo.ID)
	if err != nil {
		t.Fatal(err)
	}
	assertLocation(t, reloaded.GPSLatitude, reloaded.GPSLongitude, 31.2304, 121.4737)
}
