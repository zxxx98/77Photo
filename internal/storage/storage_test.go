package storage

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestUserRootAndSafePathStayInsideConfiguredRoot(t *testing.T) {
	root := t.TempDir()
	store, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	userRoot, err := store.UserRoot("u_immutable_123")
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(root, "users", "u_immutable_123")
	if userRoot != want {
		t.Fatalf("UserRoot() = %q, want %q", userRoot, want)
	}
	if err := store.EnsureUserRoot("u_immutable_123"); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(userRoot); err != nil || !info.IsDir() {
		t.Fatalf("user root stat = %v/%v", info, err)
	}
	for _, relative := range []string{"../outside.jpg", "/etc/passwd", `nested\\escape.jpg`, "nested/../../escape.jpg"} {
		if _, err := store.ResolveUserPath("u_immutable_123", relative); err == nil {
			t.Errorf("ResolveUserPath(%q) succeeded, want boundary error", relative)
		}
	}
}

func TestResolveRejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	store, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.EnsureUserRoot("u1"); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "users", "u1", "link")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if _, err := store.ResolveUserPath("u1", "link/secret.jpg"); err == nil {
		t.Fatal("symlink path resolved outside root")
	}
}

func TestValidateNameRejectsUnsafeNames(t *testing.T) {
	for _, name := range []string{"", ".", "..", "a/b", `a\\b`, "a\x00b", "  ", "a\n"} {
		if err := ValidateName(name); err == nil {
			t.Errorf("ValidateName(%q) succeeded, want error", name)
		}
	}
	if err := ValidateName("宝宝 2026"); err != nil {
		t.Fatalf("valid Unicode name rejected: %v", err)
	}
}

func TestCopyAndRemovePreservesTimelineFallbackTime(t *testing.T) {
	root := t.TempDir()
	source, destination := filepath.Join(root, "source.jpg"), filepath.Join(root, "destination.jpg")
	if err := os.WriteFile(source, []byte("original"), 0640); err != nil {
		t.Fatal(err)
	}
	stamp := time.Date(2020, 5, 6, 12, 0, 0, 0, time.UTC)
	if err := os.Chtimes(source, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	if err := copyAndRemove(source, destination); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(destination)
	if err != nil {
		t.Fatal(err)
	}
	if !info.ModTime().Equal(stamp) {
		t.Fatalf("mtime = %v, want %v", info.ModTime(), stamp)
	}
	data, err := os.ReadFile(destination)
	if err != nil || string(data) != "original" {
		t.Fatalf("copied content = %q, %v", data, err)
	}
	if _, err := os.Stat(source); !os.IsNotExist(err) {
		t.Fatalf("source still present: %v", err)
	}
}
