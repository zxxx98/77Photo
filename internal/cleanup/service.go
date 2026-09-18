package cleanup

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/photos"
	"github.com/zxxx98/77Photo/internal/storage"
)

var (
	ErrForbidden            = errors.New("broken photo cleanup requires administrator access")
	ErrConfirmationRequired = errors.New("explicit confirmation is required before cleaning broken photos")
)

type BrokenPhoto struct {
	ID       string `json:"id"`
	Filename string `json:"filename"`
	Reason   string `json:"reason"`
}

type ScanResult struct {
	Scanned int           `json:"scanned"`
	Broken  int           `json:"broken"`
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
	db       *sql.DB
	storage  storage.Store
	photos   *photos.Service
}

func NewService(db *sql.DB, store storage.Store, photoService *photos.Service) *Service {
	return &Service{db: db, storage: store, photos: photoService}
}

func (s *Service) Scan(ctx context.Context, principal acl.Principal) (ScanResult, error) {
	if principal.Role != acl.RoleAdmin {
		return ScanResult{}, ErrForbidden
	}
	if s.db == nil || s.photos == nil {
		return ScanResult{}, errors.New("broken photo cleanup service is not initialized")
	}

	rows, err := s.db.QueryContext(ctx, "SELECT id, storage_path, filename FROM photos WHERE deleted_at IS NULL ORDER BY id")
	if err != nil {
		return ScanResult{}, fmt.Errorf("list photos for cleanup: %w", err)
	}
	defer rows.Close()

	result := ScanResult{Items: make([]BrokenPhoto, 0)}
	for rows.Next() {
		if err := ctx.Err(); err != nil {
			return ScanResult{}, err
		}
		var id, storagePath, filename string
		if err := rows.Scan(&id, &storagePath, &filename); err != nil {
			return ScanResult{}, fmt.Errorf("read cleanup candidate: %w", err)
		}
		result.Scanned++

		path, err := s.storage.ResolvePath(storagePath)
		if err != nil {
			return ScanResult{}, fmt.Errorf("resolve %q: %w", filename, err)
		}
		info, err := os.Stat(path)
		if err != nil {
			if os.IsNotExist(err) {
				result.Items = append(result.Items, BrokenPhoto{ID: id, Filename: filename, Reason: "missing"})
				continue
			}
			return ScanResult{}, fmt.Errorf("inspect %q: %w", filename, err)
		}
		if !info.Mode().IsRegular() {
			return ScanResult{}, fmt.Errorf("inspect %q: original path is not a regular file", filename)
		}
		if info.Size() == 0 {
			result.Items = append(result.Items, BrokenPhoto{ID: id, Filename: filename, Reason: "empty"})
			continue
		}

		file, err := os.Open(path)
		if err != nil {
			return ScanResult{}, fmt.Errorf("open %q: %w", filename, err)
		}
		var probe [1]byte
		n, readErr := file.Read(probe[:])
		closeErr := file.Close()
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return ScanResult{}, fmt.Errorf("read %q: %w", filename, readErr)
		}
		if closeErr != nil {
			return ScanResult{}, fmt.Errorf("close %q: %w", filename, closeErr)
		}
		if n == 0 {
			return ScanResult{}, fmt.Errorf("read %q: file became empty during scan", filename)
		}
	}
	if err := rows.Err(); err != nil {
		return ScanResult{}, fmt.Errorf("iterate photos for cleanup: %w", err)
	}
	result.Broken = len(result.Items)
	return result, nil
}

func (s *Service) Cleanup(ctx context.Context, principal acl.Principal, confirmed bool) (CleanupResult, error) {
	if principal.Role != acl.RoleAdmin {
		return CleanupResult{}, ErrForbidden
	}
	if !confirmed {
		return CleanupResult{}, ErrConfirmationRequired
	}
	scan, err := s.Scan(ctx, principal)
	if err != nil {
		return CleanupResult{}, err
	}
	result := CleanupResult{
		Scanned: scan.Scanned,
		Found: len(scan.Items),
		Failures: make([]CleanupFailure, 0),
	}
	for _, item := range scan.Items {
		if err := s.photos.Delete(ctx, principal, item.ID, true); err != nil {
			result.Failures = append(result.Failures, CleanupFailure{ID: item.ID, Code: cleanupErrorCode(err)})
			continue
		}
		result.Deleted++
	}
	result.Failed = len(result.Failures)
	return result, nil
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
