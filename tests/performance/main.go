// Command perf builds a deterministic SQLite photo index and measures the
// same list path used by the HTTP API. It deliberately does not create media
// files, so the benchmark isolates index/query costs from image decoding.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	dbstore "github.com/zxxx98/77Photo/internal/database"
	"github.com/zxxx98/77Photo/internal/photos"
	"github.com/zxxx98/77Photo/internal/storage"
)

type report struct {
	GeneratedAt       time.Time `json:"generated_at"`
	PhotoCount        int       `json:"photo_count"`
	PageSize          int       `json:"page_size"`
	MeasuredPages     int       `json:"measured_pages"`
	ColdFirstPageMS   float64   `json:"cold_first_page_ms"`
	HotFirstPageMS    float64   `json:"hot_first_page_ms"`
	SequentialPagesMS float64   `json:"sequential_pages_ms"`
	AllocBeforeBytes  uint64    `json:"alloc_before_bytes"`
	AllocAfterBytes   uint64    `json:"alloc_after_bytes"`
	HighWaterRSSKB    int64     `json:"high_water_rss_kb,omitempty"`
}

func main() {
	count := flag.Int("count", envInt("PHOTO_PERF_COUNT", 10000), "number of indexed photos (10000 or 100000 recommended)")
	pages := flag.Int("pages", envInt("PHOTO_PERF_PAGES", 20), "number of sequential pages to measure")
	pageSize := flag.Int("page-size", 50, "photos requested per page")
	output := flag.String("output", "", "optional JSON report path")
	flag.Parse()
	if *count < 1 || *count > 1000000 {
		fatal("-count must be between 1 and 1000000")
	}
	if *pages < 1 || *pages > 10000 {
		fatal("-pages must be between 1 and 10000")
	}
	if *pageSize < 1 || *pageSize > 100 {
		fatal("-page-size must be between 1 and 100")
	}

	ctx := context.Background()
	root, err := os.MkdirTemp("", "77photo-perf-")
	if err != nil {
		fatal("create temp root: %v", err)
	}
	defer os.RemoveAll(root)
	db, err := dbstore.Open(ctx, filepath.Join(root, "index.db"))
	if err != nil {
		fatal("open database: %v", err)
	}
	defer db.Close()
	store, err := storage.New(filepath.Join(root, "photos"))
	if err != nil {
		fatal("create storage: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at)
VALUES ('perf-user', 'perf-user', 'benchmark', 'user', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`); err != nil {
		fatal("insert benchmark user: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO folders (id, owner_id, storage_path, name, is_shared, created_at, updated_at)
VALUES ('perf-folder', 'perf-user', 'users/perf-user/benchmark', 'benchmark', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`); err != nil {
		fatal("insert benchmark folder: %v", err)
	}
	if err := store.EnsureUserRoot("perf-user"); err != nil {
		fatal("create benchmark user root: %v", err)
	}
	if err := store.MakeUserDir("perf-user", "benchmark"); err != nil {
		fatal("create benchmark folder: %v", err)
	}
	insertPhotos(ctx, db, *count)

	service := photos.NewService(db, store, 1<<20)
	principal := acl.Principal{UserID: "perf-user", Role: acl.RoleUser}
	filter := photos.ListFilter{Limit: *pageSize}
	var before runtime.MemStats
	runtime.ReadMemStats(&before)
	start := time.Now()
	if _, err := service.List(ctx, principal, filter); err != nil {
		fatal("cold list: %v", err)
	}
	coldMS := elapsedMS(start)
	start = time.Now()
	if _, err := service.List(ctx, principal, filter); err != nil {
		fatal("hot list: %v", err)
	}
	hotMS := elapsedMS(start)
	start = time.Now()
	page := filter
	measured := 0
	for measured < *pages {
		result, err := service.List(ctx, principal, page)
		if err != nil {
			fatal("sequential list page %d: %v", measured+1, err)
		}
		measured++
		if result.NextCursor == nil {
			break
		}
		page.Cursor = *result.NextCursor
	}
	sequentialMS := elapsedMS(start)
	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	result := report{GeneratedAt: time.Now().UTC(), PhotoCount: *count, PageSize: *pageSize, MeasuredPages: measured, ColdFirstPageMS: coldMS, HotFirstPageMS: hotMS, SequentialPagesMS: sequentialMS, AllocBeforeBytes: before.Alloc, AllocAfterBytes: after.Alloc, HighWaterRSSKB: highWaterRSSKB()}
	encoded, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		fatal("encode report: %v", err)
	}
	if *output != "" {
		if err := os.WriteFile(*output, append(encoded, '\n'), 0o640); err != nil {
			fatal("write report: %v", err)
		}
	}
	fmt.Println(string(encoded))
}

func insertPhotos(ctx context.Context, db interface {
	BeginTx(context.Context, *sql.TxOptions) (*sql.Tx, error)
}, count int) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		fatal("begin photo insert: %v", err)
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(ctx, `INSERT INTO photos
(id, owner_id, folder_id, storage_path, filename, mime_type, size, width, height, checksum, captured_at, captured_at_source, file_created_at, indexed_at, source_revision, scan_status, created_at, updated_at)
VALUES (?, 'perf-user', 'perf-folder', ?, 'photo.jpg', 'image/jpeg', 1, 1, 1, ?, ?, 'file_mtime', ?, ?, ?, 'indexed', ?, ?)`)
	if err != nil {
		fatal("prepare photo insert: %v", err)
	}
	defer stmt.Close()
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < count; i++ {
		timestamp := base.Add(-time.Duration(i) * time.Second).Format(time.RFC3339Nano)
		checksum := fmt.Sprintf("%064x", i+1)
		if _, err := stmt.ExecContext(ctx, fmt.Sprintf("p_%08d", i), fmt.Sprintf("users/perf-user/benchmark/photo-%08d.jpg", i), checksum, timestamp, timestamp, timestamp, timestamp, timestamp, timestamp); err != nil {
			fatal("insert photo %d: %v", i, err)
		}
	}
	if err := tx.Commit(); err != nil {
		fatal("commit photo insert: %v", err)
	}
}

func elapsedMS(start time.Time) float64 { return float64(time.Since(start).Microseconds()) / 1000 }

func envInt(name string, fallback int) int {
	if value, ok := os.LookupEnv(name); ok {
		var parsed int
		if _, err := fmt.Sscanf(value, "%d", &parsed); err == nil {
			return parsed
		}
	}
	return fallback
}

func highWaterRSSKB() int64 {
	data, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0
	}
	var value int64
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "VmHWM:") {
			_, _ = fmt.Sscanf(strings.TrimSpace(strings.TrimPrefix(line, "VmHWM:")), "%d", &value)
			return value
		}
	}
	return 0
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
