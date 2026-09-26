package media

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestParseISO6709AcceptsDecimalDegrees(t *testing.T) {
	checks := []struct {
		value         string
		wantLatitude  float64
		wantLongitude float64
	}{
		{"+31.2304+121.4737+012.345/", 31.2304, 121.4737},
		{"+37.4219-122.0840/", 37.4219, -122.0840},
		{"-33.8568+151.2153/", -33.8568, 151.2153},
		{"+05.1234+005.1234/", 5.1234, 5.1234},
		{" -22.9068-043.1729 ", -22.9068, -43.1729},
		{"+48.8577+002.2950+035.000CRSWGS_84/", 48.8577, 2.2950},
	}
	for _, check := range checks {
		latitude, longitude, ok := ParseISO6709(check.value)
		if !ok || latitude != check.wantLatitude || longitude != check.wantLongitude {
			t.Fatalf("ParseISO6709(%q) = %v, %v, %v; want %v, %v, true", check.value, latitude, longitude, ok, check.wantLatitude, check.wantLongitude)
		}
	}
}

func TestParseISO6709RejectsOtherForms(t *testing.T) {
	for _, value := range []string{"", "garbage", "+37.4219", "+3723.45-12201.23/", "37.4219,-122.0840", "+37.4219-122.0840x"} {
		if latitude, longitude, ok := ParseISO6709(value); ok {
			t.Fatalf("ParseISO6709(%q) = %v, %v, true; want false", value, latitude, longitude)
		}
	}
}

func TestProbeMetadataPrefersQuickTimeLocation(t *testing.T) {
	runner := &fakeRunner{runOut: []byte(`{
		"format":{"tags":{"location":"+10.0000+020.0000/","com.apple.quicktime.location.ISO6709":"+31.2304+121.4737+012.345/"}},
		"streams":[]
	}`)}
	tools := Tools{FFprobe: "/usr/bin/ffprobe", Runner: runner, Timeout: time.Second}

	metadata, err := tools.ProbeMetadata(context.Background(), "/tmp/clip.mov")
	if err != nil {
		t.Fatal(err)
	}
	if !metadata.HasLocation || metadata.Latitude != 31.2304 || metadata.Longitude != 121.4737 {
		t.Fatalf("location = %v, %v, %v; want QuickTime location", metadata.Latitude, metadata.Longitude, metadata.HasLocation)
	}
	args := strings.Join(runner.runArgs[0], "\x00")
	if !strings.Contains(args, "com.apple.quicktime.location.ISO6709") || !strings.Contains(args, "location") {
		t.Fatalf("ffprobe args = %#v, want location tags", runner.runArgs[0])
	}
}

func TestProbeMetadataFallsBackToStreamLocation(t *testing.T) {
	runner := &fakeRunner{runOut: []byte(`{"format":{"tags":{"location":"not a location"}},"streams":[{"tags":{"location":"+37.4219-122.0840/"}}]}`)}
	tools := Tools{Runner: runner, Timeout: time.Second}

	metadata, err := tools.ProbeMetadata(context.Background(), "/tmp/clip.mp4")
	if err != nil {
		t.Fatal(err)
	}
	if !metadata.HasLocation || metadata.Latitude != 37.4219 || metadata.Longitude != -122.0840 {
		t.Fatalf("location = %v, %v, %v; want stream location", metadata.Latitude, metadata.Longitude, metadata.HasLocation)
	}
}

func TestProbeMetadataWithoutLocationIsNotAnError(t *testing.T) {
	runner := &fakeRunner{runOut: []byte(`{"format":{"tags":{"creation_time":"2023-02-03T04:05:06Z"}},"streams":[]}`)}
	tools := Tools{Runner: runner, Timeout: time.Second}

	metadata, err := tools.ProbeMetadata(context.Background(), "/tmp/clip.mp4")
	if err != nil {
		t.Fatal(err)
	}
	if metadata.HasLocation {
		t.Fatalf("location = %v, %v; want none", metadata.Latitude, metadata.Longitude)
	}
	if !metadata.HasCapturedAt || !metadata.CapturedAt.Equal(time.Date(2023, 2, 3, 4, 5, 6, 0, time.UTC)) {
		t.Fatalf("captured = %v, %v; want container time", metadata.CapturedAt, metadata.HasCapturedAt)
	}
}
