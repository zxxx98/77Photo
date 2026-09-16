package config

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	defaultDataDir          = "./data/photos"
	defaultCacheDir         = "./data/cache"
	defaultDBPath           = "./data/database/77photo.db"
	defaultListenAddr       = ":8080"
	defaultThumbnailWorkers = 1
	defaultMaxUploadSize    = int64(10 * 1024 * 1024 * 1024)
	defaultSessionTTL       = 720 * time.Hour
	defaultFFmpegPath       = "ffmpeg"
	defaultFFprobePath      = "ffprobe"
	defaultHeifConvertPath  = "heif-convert"
	defaultMediaTimeout     = 30 * time.Second
	maxThumbnailWorkers     = 64
)

// Config contains process-wide settings. Paths are resolved relative to the
// process working directory when supplied as relative paths.
type Config struct {
	DataDir          string
	CacheDir         string
	DBPath           string
	ListenAddr       string
	ThumbnailWorkers int
	MaxUploadSize    int64
	SessionTTL       time.Duration
	FFmpegPath       string
	FFprobePath      string
	HeifConvertPath  string
	MediaTimeout     time.Duration
}

// LoadFromEnv reads the PHOTO_* settings and validates scalar values. It does
// not touch the filesystem; call ValidateFilesystem during startup.
func LoadFromEnv() (Config, error) {
	workers, err := envInt("PHOTO_THUMBNAIL_WORKERS", defaultThumbnailWorkers)
	if err != nil {
		return Config{}, fmt.Errorf("PHOTO_THUMBNAIL_WORKERS: %w", err)
	}
	maxUpload, err := envInt64("PHOTO_MAX_UPLOAD_SIZE", defaultMaxUploadSize)
	if err != nil {
		return Config{}, fmt.Errorf("PHOTO_MAX_UPLOAD_SIZE: %w", err)
	}
	ttl, err := envDuration("PHOTO_SESSION_TTL", defaultSessionTTL)
	if err != nil {
		return Config{}, fmt.Errorf("PHOTO_SESSION_TTL: %w", err)
	}
	mediaTimeout, err := envDuration("PHOTO_MEDIA_TIMEOUT", defaultMediaTimeout)
	if err != nil {
		return Config{}, fmt.Errorf("PHOTO_MEDIA_TIMEOUT: %w", err)
	}

	cfg := Config{
		DataDir:          envString("PHOTO_DATA_DIR", defaultDataDir),
		CacheDir:         envString("PHOTO_CACHE_DIR", defaultCacheDir),
		DBPath:           envString("PHOTO_DB_PATH", defaultDBPath),
		ListenAddr:       envString("PHOTO_LISTEN_ADDR", defaultListenAddr),
		ThumbnailWorkers: workers,
		MaxUploadSize:    maxUpload,
		SessionTTL:       ttl,
		FFmpegPath:       envString("PHOTO_FFMPEG_PATH", defaultFFmpegPath),
		FFprobePath:      envString("PHOTO_FFPROBE_PATH", defaultFFprobePath),
		HeifConvertPath:  envString("PHOTO_HEIF_CONVERT_PATH", defaultHeifConvertPath),
		MediaTimeout:     mediaTimeout,
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) Validate() error {
	if strings.TrimSpace(c.DataDir) == "" {
		return fmt.Errorf("PHOTO_DATA_DIR must not be empty")
	}
	if strings.TrimSpace(c.CacheDir) == "" {
		return fmt.Errorf("PHOTO_CACHE_DIR must not be empty")
	}
	if strings.TrimSpace(c.DBPath) == "" {
		return fmt.Errorf("PHOTO_DB_PATH must not be empty")
	}
	if c.ThumbnailWorkers < 1 || c.ThumbnailWorkers > maxThumbnailWorkers {
		return fmt.Errorf("thumbnail workers must be between 1 and %d", maxThumbnailWorkers)
	}
	if c.MaxUploadSize < 1 {
		return fmt.Errorf("max upload size must be positive")
	}
	if c.SessionTTL <= 0 {
		return fmt.Errorf("session TTL must be positive")
	}
	if strings.TrimSpace(c.FFmpegPath) == "" || strings.TrimSpace(c.FFprobePath) == "" || strings.TrimSpace(c.HeifConvertPath) == "" {
		return fmt.Errorf("media tool paths must not be empty")
	}
	if c.MediaTimeout <= 0 {
		return fmt.Errorf("media timeout must be positive")
	}
	if _, _, err := net.SplitHostPort(c.ListenAddr); err != nil {
		return fmt.Errorf("listen address %q is invalid: %w", c.ListenAddr, err)
	}
	return nil
}

// ValidateFilesystem creates configured directories when absent, then checks
// that each is a directory and supports a write probe. The database file may
// be absent on first startup, but its parent must be usable.
func (c Config) ValidateFilesystem() error {
	if err := c.Validate(); err != nil {
		return err
	}
	for _, dir := range []string{c.DataDir, c.CacheDir, filepath.Dir(c.DBPath)} {
		if err := ensureWritableDir(dir); err != nil {
			return fmt.Errorf("storage path %q: %w", dir, err)
		}
	}
	if info, err := os.Stat(c.DBPath); err == nil {
		if info.IsDir() {
			return fmt.Errorf("database path %q is a directory", c.DBPath)
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("database path %q: %w", c.DBPath, err)
	}
	return nil
}

func ensureWritableDir(path string) error {
	if err := os.MkdirAll(path, 0o750); err != nil {
		return err
	}
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return os.ErrExist
	}
	probe, err := os.CreateTemp(path, ".77photo-write-probe-")
	if err != nil {
		return err
	}
	name := probe.Name()
	if err := probe.Close(); err != nil {
		_ = os.Remove(name)
		return err
	}
	return os.Remove(name)
}

func envString(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) (int, error) {
	value := envString(key, strconv.Itoa(fallback))
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("must be an integer: %q", value)
	}
	return parsed, nil
}

func envInt64(key string, fallback int64) (int64, error) {
	value := envString(key, strconv.FormatInt(fallback, 10))
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("must be an integer: %q", value)
	}
	return parsed, nil
}

func envDuration(key string, fallback time.Duration) (time.Duration, error) {
	value := envString(key, fallback.String())
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return 0, fmt.Errorf("must be a duration: %q", value)
	}
	return parsed, nil
}
