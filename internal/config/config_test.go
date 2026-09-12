package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func clearConfigEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"PHOTO_DATA_DIR", "PHOTO_CACHE_DIR", "PHOTO_DB_PATH", "PHOTO_LISTEN_ADDR",
		"PHOTO_THUMBNAIL_WORKERS", "PHOTO_MAX_UPLOAD_SIZE", "PHOTO_SESSION_TTL",
	} {
		t.Setenv(key, "")
		_ = os.Unsetenv(key)
	}
}

func TestLoadFromEnvParsesSupportedSettings(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("PHOTO_DATA_DIR", "/srv/photos")
	t.Setenv("PHOTO_CACHE_DIR", "/srv/cache")
	t.Setenv("PHOTO_DB_PATH", "/srv/db/77photo.db")
	t.Setenv("PHOTO_LISTEN_ADDR", "127.0.0.1:9090")
	t.Setenv("PHOTO_THUMBNAIL_WORKERS", "3")
	t.Setenv("PHOTO_MAX_UPLOAD_SIZE", "1048576")
	t.Setenv("PHOTO_SESSION_TTL", "48h")

	cfg, err := LoadFromEnv()
	if err != nil {
		t.Fatalf("LoadFromEnv() error = %v", err)
	}
	if cfg.DataDir != "/srv/photos" || cfg.CacheDir != "/srv/cache" || cfg.DBPath != "/srv/db/77photo.db" {
		t.Fatalf("unexpected paths: %+v", cfg)
	}
	if cfg.ListenAddr != "127.0.0.1:9090" || cfg.ThumbnailWorkers != 3 || cfg.MaxUploadSize != 1048576 {
		t.Fatalf("unexpected scalar settings: %+v", cfg)
	}
	if cfg.SessionTTL != 48*time.Hour {
		t.Fatalf("SessionTTL = %s, want 48h", cfg.SessionTTL)
	}
}

func TestLoadFromEnvRejectsInvalidWorkerCount(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("PHOTO_THUMBNAIL_WORKERS", "0")
	if _, err := LoadFromEnv(); err == nil {
		t.Fatal("LoadFromEnv() error = nil, want invalid worker count error")
	}
}

func TestLoadFromEnvRejectsInvalidDurationAndSize(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("PHOTO_MAX_UPLOAD_SIZE", "-1")
	if _, err := LoadFromEnv(); err == nil {
		t.Fatal("LoadFromEnv() error = nil, want invalid size error")
	}

	clearConfigEnv(t)
	t.Setenv("PHOTO_SESSION_TTL", "tomorrow")
	if _, err := LoadFromEnv(); err == nil {
		t.Fatal("LoadFromEnv() error = nil, want invalid duration error")
	}
}

func TestValidateFilesystemCreatesAndChecksConfiguredDirectories(t *testing.T) {
	root := t.TempDir()
	cfg := Config{
		DataDir:          filepath.Join(root, "photos"),
		CacheDir:         filepath.Join(root, "cache"),
		DBPath:           filepath.Join(root, "database", "77photo.db"),
		ListenAddr:       ":8080",
		ThumbnailWorkers: 1,
		MaxUploadSize:    1024,
		SessionTTL:       time.Hour,
	}
	if err := cfg.ValidateFilesystem(); err != nil {
		t.Fatalf("ValidateFilesystem() error = %v", err)
	}
	for _, path := range []string{cfg.DataDir, cfg.CacheDir, filepath.Dir(cfg.DBPath)} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat %s: %v", path, err)
		}
		if !info.IsDir() {
			t.Fatalf("%s is not a directory", path)
		}
	}
}

func TestValidateFilesystemRejectsFileAsDirectory(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "not-a-directory")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := Config{
		DataDir:          file,
		CacheDir:         filepath.Join(root, "cache"),
		DBPath:           filepath.Join(root, "db", "photo.db"),
		ListenAddr:       ":8080",
		ThumbnailWorkers: 1,
		MaxUploadSize:    1024,
		SessionTTL:       time.Hour,
	}
	if err := cfg.ValidateFilesystem(); err == nil {
		t.Fatalf("ValidateFilesystem() error = %v, want an existing-file error", err)
	}
}
