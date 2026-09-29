package storage

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDurableMoveReplaysWithoutOverwriting(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.Root(), "original"), []byte("photo"), 0o600); err != nil {
		t.Fatal(err)
	}
	hash, _, err := s.FileDigest("original")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.MoveFileDurable("original", ".trash/id/original", hash); err != nil {
		t.Fatal(err)
	}
	if err := s.MoveFileDurable("original", ".trash/id/original", hash); err != nil {
		t.Fatalf("replay: %v", err)
	}
	if err := os.WriteFile(filepath.Join(s.Root(), "original"), []byte("another photo"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.MoveFileDurable(".trash/id/original", "original", hash); err == nil {
		t.Fatal("overwrote a different destination")
	}
	if data, err := os.ReadFile(filepath.Join(s.Root(), "original")); err != nil || string(data) != "another photo" {
		t.Fatalf("destination changed: %q %v", data, err)
	}
	if _, _, err := s.FileDigest(".trash/id/original"); err != nil {
		t.Fatalf("source lost on conflict: %v", err)
	}
}

func TestDurableMoveAcrossDevices(t *testing.T) {
	sourceDir := t.TempDir()
	destinationDir, err := os.MkdirTemp("/dev/shm", "77photo-trash-test-")
	if err != nil {
		t.Skipf("second filesystem unavailable: %v", err)
	}
	defer os.RemoveAll(destinationDir)
	source := filepath.Join(sourceDir, "source")
	destination := filepath.Join(destinationDir, "restored")
	if err := os.WriteFile(source, []byte("original bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	// A legacy temporary-looking user file must not be overwritten.
	if err := os.WriteFile(destination+".77photo-moving", []byte("unrelated"), 0600); err != nil {
		t.Fatal(err)
	}
	store, err := New("/")
	if err != nil {
		t.Fatal(err)
	}
	from, to := source[1:], destination[1:]
	checksum, _, err := store.FileDigest(from)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.MoveFileDurable(from, to, checksum); err != nil {
		t.Fatal(err)
	}
	if err := store.MoveFileDurable(from, to, checksum); err != nil {
		t.Fatalf("replay: %v", err)
	}
	if data, err := os.ReadFile(destination); err != nil || string(data) != "original bytes" {
		t.Fatalf("copy: %q %v", data, err)
	}
	if data, err := os.ReadFile(destination + ".77photo-moving"); err != nil || string(data) != "unrelated" {
		t.Fatalf("unrelated file changed: %q %v", data, err)
	}
}
