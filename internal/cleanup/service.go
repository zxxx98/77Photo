package cleanup

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/maintenance"
	"github.com/zxxx98/77Photo/internal/photos"
	"github.com/zxxx98/77Photo/internal/storage"
)

var (
	ErrForbidden            = errors.New("broken photo cleanup requires administrator access")
	ErrConfirmationRequired = errors.New("explicit confirmation is required before cleaning broken photos")
	ErrBatchTooLarge        = errors.New("too many photos in one cleanup request")
)

const maxCleanupBatch = 10000

type BrokenPhoto struct {
	ID       string `json:"id"`
	Filename string `json:"filename"`
	Reason   string `json:"reason"`
}

type ScanResult struct {
	Scanned int           `json:"scanned"`
	Broken  int           `json:"broken"`
	Skipped int           `json:"skipped"`
	Items   []BrokenPhoto `json:"items"`
}

type CleanupFailure struct {
	ID   string `json:"id"`
	Code string `json:"code"`
}

type CleanupResult struct {
	Scanned  int              `json:"scanned"`
	Found    int              `json:"found"`
	Deleted  int              `json:"deleted"`
	Failed   int              `json:"failed"`
	Failures []CleanupFailure `json:"failures"`
}

type Service struct {
	db          *sql.DB
	storage     storage.Store
	photos      *photos.Service
	maintenance *maintenance.Lock
}

func NewService(db *sql.DB, store storage.Store, photoService *photos.Service) *Service {
	return &Service{db: db, storage: store, photos: photoService}
}

func (s *Service) SetMaintenanceLock(lock *maintenance.Lock) { s.maintenance = lock }

func (s *Service) Scan(ctx context.Context, principal acl.Principal) (ScanResult, error) {
	if principal.Role != acl.RoleAdmin {
		return ScanResult{}, ErrForbidden
	}
	if s.db == nil || s.photos == nil {
		return ScanResult{}, errors.New("broken photo cleanup service is not initialized")
	}
	release, err := s.maintenance.Acquire(maintenance.KindCleanup, "")
	if err != nil {
		return ScanResult{}, err
	}
	defer release()

	// Buffer candidates and release the query before touching the filesystem:
	// the SQLite pool has a single connection, so holding the cursor open while
	// stat-ing a large library would block every other request.
	candidates, err := s.loadCandidates(ctx, "SELECT id, storage_path, filename FROM photos WHERE deleted_at IS NULL ORDER BY id")
	if err != nil {
		return ScanResult{}, err
	}

	result := ScanResult{Items: make([]BrokenPhoto, 0)}
	roots := make(map[string]bool)
	for _, candidate := range candidates {
		if err := ctx.Err(); err != nil {
			return ScanResult{}, err
		}
		result.Scanned++
		switch reason := s.inspect(candidate, roots); reason {
		case reasonHealthy:
		case reasonUnknown:
			result.Skipped++
		default:
			result.Items = append(result.Items, BrokenPhoto{ID: candidate.id, Filename: candidate.filename, Reason: reason})
		}
	}
	result.Broken = len(result.Items)
	return result, nil
}

// Cleanup deletes only the photos the administrator confirmed from a previous
// scan, and only if each of them is still clearly broken right now.
func (s *Service) Cleanup(ctx context.Context, principal acl.Principal, confirmed bool, ids []string) (CleanupResult, error) {
	if principal.Role != acl.RoleAdmin {
		return CleanupResult{}, ErrForbidden
	}
	if !confirmed || len(ids) == 0 {
		return CleanupResult{}, ErrConfirmationRequired
	}
	if len(ids) > maxCleanupBatch {
		return CleanupResult{}, ErrBatchTooLarge
	}
	if s.db == nil || s.photos == nil {
		return CleanupResult{}, errors.New("broken photo cleanup service is not initialized")
	}
	release, err := s.maintenance.Acquire(maintenance.KindCleanup, "")
	if err != nil {
		return CleanupResult{}, err
	}
	defer release()

	unique := make([]string, 0, len(ids))
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if _, ok := seen[id]; ok || id == "" {
			continue
		}
		seen[id] = struct{}{}
		unique = append(unique, id)
	}

	result := CleanupResult{Scanned: len(unique), Failures: make([]CleanupFailure, 0)}
	roots := make(map[string]bool)
	for _, id := range unique {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		candidates, err := s.loadCandidates(ctx, "SELECT id, storage_path, filename FROM photos WHERE id=? AND deleted_at IS NULL", id)
		if err != nil {
			return result, err
		}
		if len(candidates) == 0 {
			result.Failures = append(result.Failures, CleanupFailure{ID: id, Code: "NOT_FOUND"})
			continue
		}
		if reason := s.inspect(candidates[0], roots); reason != reasonMissing && reason != reasonEmpty {
			result.Failures = append(result.Failures, CleanupFailure{ID: id, Code: "NOT_BROKEN"})
			continue
		}
		result.Found++
		if err := s.photos.Delete(ctx, principal, id, true); err != nil {
			result.Failures = append(result.Failures, CleanupFailure{ID: id, Code: cleanupErrorCode(err)})
			continue
		}
		result.Deleted++
	}
	result.Failed = len(result.Failures)
	return result, nil
}

type candidate struct {
	id, storagePath, filename string
}

const (
	reasonHealthy = ""
	reasonUnknown = "unknown"
	reasonMissing = "missing"
	reasonEmpty   = "empty"
)

func (s *Service) loadCandidates(ctx context.Context, query string, args ...any) ([]candidate, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list photos for cleanup: %w", err)
	}
	defer rows.Close()
	var candidates []candidate
	for rows.Next() {
		var item candidate
		if err := rows.Scan(&item.id, &item.storagePath, &item.filename); err != nil {
			return nil, fmt.Errorf("read cleanup candidate: %w", err)
		}
		candidates = append(candidates, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate photos for cleanup: %w", err)
	}
	return candidates, nil
}

// inspect classifies one original. Anything that is not clearly missing or
// zero bytes, including an unreachable storage root, is reported as unknown so
// it is never deleted.
func (s *Service) inspect(item candidate, roots map[string]bool) string {
	path, err := s.storage.ResolvePath(item.storagePath)
	if err != nil {
		return reasonUnknown
	}
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) && s.rootAvailable(item.storagePath, roots) {
			return reasonMissing
		}
		return reasonUnknown
	}
	if !info.Mode().IsRegular() {
		return reasonUnknown
	}
	if info.Size() == 0 {
		return reasonEmpty
	}
	return reasonHealthy
}

// rootAvailable reports whether the library root holding storagePath
// (users/<id> or shared/<folder>) is present. A missing root usually means an
// unmounted volume, so its photos must not be treated as deleted.
func (s *Service) rootAvailable(storagePath string, roots map[string]bool) bool {
	parts := strings.Split(filepath.ToSlash(filepath.Clean(storagePath)), "/")
	if len(parts) < 3 {
		return false
	}
	root := parts[0] + "/" + parts[1]
	if available, ok := roots[root]; ok {
		return available
	}
	available := false
	if resolved, err := s.storage.ResolvePath(root); err == nil {
		if info, err := os.Stat(resolved); err == nil && info.IsDir() {
			available = true
		}
	}
	roots[root] = available
	return available
}

func cleanupErrorCode(err error) string {
	switch {
	case errors.Is(err, photos.ErrNotFound):
		return "NOT_FOUND"
	case errors.Is(err, photos.ErrForbidden):
		return "WRITE_FORBIDDEN"
	default:
		return "INTERNAL_ERROR"
	}
}
