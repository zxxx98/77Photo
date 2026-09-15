package indexer

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/photos"
	"github.com/zxxx98/77Photo/internal/storage"
)

type Status string

const (
	StatusQueued    Status = "queued"
	StatusRunning   Status = "running"
	StatusCompleted Status = "completed"
	StatusFailed    Status = "failed"
)

var (
	ErrForbidden = errors.New("rescan requires administrator access")
	ErrConflict  = errors.New("a rescan is already queued or running")
	ErrNotFound  = errors.New("rescan job not found")
)

type Counts struct {
	Scanned int `json:"scanned"`
	Added   int `json:"added"`
	Updated int `json:"updated"`
	Missing int `json:"missing"`
	Failed  int `json:"failed"`
}

type Job struct {
	ID         string     `json:"id"`
	Status     Status     `json:"status"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
	Counts     Counts     `json:"counts"`
	Error      *string    `json:"error,omitempty"`
}

type folderRecord struct{ id, owner, path string }
type scanRoot struct {
	path     string
	owner    string
	folderID string
}

type Service struct {
	db        *sql.DB
	storage   storage.Store
	photos    *photos.Service
	lifecycle context.Context
	mu        sync.RWMutex
	job       *Job
	done      chan struct{}
}

func NewService(db *sql.DB, store storage.Store, photoService *photos.Service) *Service {
	return &Service{db: db, storage: store, photos: photoService}
}

// NewServiceWithContext ties asynchronous scans to the process lifecycle. The
// HTTP request context is still ignored for the scan itself, so returning a
// 202 response cannot cancel the job.
func NewServiceWithContext(ctx context.Context, db *sql.DB, store storage.Store, photoService *photos.Service) *Service {
	service := NewService(db, store, photoService)
	service.lifecycle = ctx
	return service
}

func (s *Service) Start(ctx context.Context, principal acl.Principal) (Job, error) {
	if principal.Role != acl.RoleAdmin {
		return Job{}, ErrForbidden
	}
	s.mu.Lock()
	if s.job != nil && (s.job.Status == StatusQueued || s.job.Status == StatusRunning) {
		s.mu.Unlock()
		return Job{}, ErrConflict
	}
	now := time.Now().UTC()
	job := &Job{ID: newJobID(), Status: StatusQueued, StartedAt: now}
	s.job = job
	done := make(chan struct{})
	s.done = done
	snapshot := *job
	s.mu.Unlock()
	scanContext := s.lifecycle
	if scanContext == nil {
		// HTTP request contexts are canceled as soon as the 202 response is
		// sent. A queued rescan must outlive that request.
		scanContext = context.WithoutCancel(ctx)
	}
	go s.run(scanContext, job, done)
	return snapshot, nil
}

// Wait blocks until the current scan has stopped. It is used during graceful
// shutdown so the database is not closed while a scanner is still indexing.
func (s *Service) Wait() {
	s.mu.RLock()
	done := s.done
	s.mu.RUnlock()
	if done != nil {
		<-done
	}
}

func (s *Service) Get(_ context.Context, principal acl.Principal, id string) (Job, error) {
	if principal.Role != acl.RoleAdmin {
		return Job{}, ErrForbidden
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.job == nil || s.job.ID != id {
		return Job{}, ErrNotFound
	}
	return *s.job, nil
}

func (s *Service) run(ctx context.Context, job *Job, done chan struct{}) {
	defer close(done)
	s.mu.Lock()
	job.Status = StatusRunning
	s.mu.Unlock()
	err := s.scan(ctx, job)
	s.mu.Lock()
	if err != nil {
		job.Status = StatusFailed
		message := err.Error()
		job.Error = &message
	} else {
		job.Status = StatusCompleted
	}
	finished := time.Now().UTC()
	job.FinishedAt = &finished
	s.mu.Unlock()
}

func (s *Service) scan(ctx context.Context, job *Job) error {
	if s.photos == nil {
		return errors.New("photo service is required")
	}
	folders, err := s.loadFolders(ctx)
	if err != nil {
		return err
	}
	roots, err := s.scanRoots(ctx, folders)
	if err != nil {
		return err
	}
	seen := make(map[string]struct{})
	walkedRoots := make(map[string]bool)
	for _, rootRecord := range roots {
		root, err := s.storage.ResolvePath(rootRecord.path)
		if err != nil {
			continue
		}
		if _, err := os.Stat(root); err != nil {
			continue
		}
		walkedRoots[rootRecord.path] = true
		walkErr := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				s.increment(job, func(counts *Counts) { counts.Failed++ })
				return nil
			}
			if entry.Type()&os.ModeSymlink != 0 {
				return nil
			}
			if entry.IsDir() {
				if path == root {
					return nil
				}
				if strings.HasPrefix(entry.Name(), ".") {
					return filepath.SkipDir
				}
				relative, relErr := filepath.Rel(s.storage.Root(), path)
				if relErr != nil {
					s.increment(job, func(counts *Counts) { counts.Failed++ })
					return filepath.SkipDir
				}
				if _, ensureErr := s.ensureFolder(ctx, folders, rootRecord, filepath.Clean(relative)); ensureErr != nil {
					s.increment(job, func(counts *Counts) { counts.Failed++ })
					return filepath.SkipDir
				}
				return nil
			}
			if strings.HasPrefix(entry.Name(), ".") || strings.HasSuffix(entry.Name(), ".tmp") {
				return nil
			}
			relative, relErr := filepath.Rel(s.storage.Root(), path)
			if relErr != nil {
				s.increment(job, func(counts *Counts) { counts.Failed++ })
				return nil
			}
			relative = filepath.Clean(relative)
			parent := filepath.Dir(relative)
			record, ok := folders[parent]
			if !ok {
				return nil
			}
			storagePath := filepath.ToSlash(relative)
			s.increment(job, func(counts *Counts) { counts.Scanned++ })
			added, indexErr := s.photos.IndexScannedFile(ctx, record.owner, record.id, storagePath)
			if indexErr != nil {
				s.increment(job, func(counts *Counts) { counts.Failed++ })
				return nil
			}
			if added {
				s.increment(job, func(counts *Counts) { counts.Added++ })
			} else {
				s.increment(job, func(counts *Counts) { counts.Updated++ })
			}
			seen[storagePath] = struct{}{}
			return nil
		})
		if walkErr != nil {
			return walkErr
		}
	}

	// SQLite is intentionally configured with a single pooled connection. Do
	// not hold a query cursor open while calling MarkMissing, which performs a
	// write through the same *sql.DB and would otherwise wait forever for the
	// connection currently owned by rows.
	indexedPaths, err := s.loadIndexedPhotoPaths(ctx)
	if err != nil {
		return err
	}
	for _, path := range indexedPaths {
		root := managedRoot(filepath.ToSlash(path))
		if root == "" || !walkedRoots[root] {
			continue
		}
		if _, ok := seen[path]; ok {
			continue
		}
		if _, statErr := os.Stat(filepath.Join(s.storage.Root(), filepath.FromSlash(path))); os.IsNotExist(statErr) {
			if err := s.photos.MarkMissing(ctx, path); err == nil {
				s.increment(job, func(counts *Counts) { counts.Missing++ })
			}
		}
	}
	return nil
}

func (s *Service) loadFolders(ctx context.Context) (map[string]folderRecord, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT id, owner_id, storage_path FROM folders")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	folders := make(map[string]folderRecord)
	for rows.Next() {
		var record folderRecord
		if err := rows.Scan(&record.id, &record.owner, &record.path); err != nil {
			return nil, err
		}
		folders[filepath.Clean(filepath.FromSlash(record.path))] = record
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return folders, nil
}

func (s *Service) loadIndexedPhotoPaths(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT storage_path FROM photos WHERE deleted_at IS NULL AND scan_status='indexed'")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	paths := make([]string, 0)
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			return nil, err
		}
		paths = append(paths, path)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return paths, nil
}

func (s *Service) scanRoots(ctx context.Context, folders map[string]folderRecord) ([]scanRoot, error) {
	roots := make(map[string]scanRoot)
	rows, err := s.db.QueryContext(ctx, "SELECT id FROM users")
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var owner string
		if err := rows.Scan(&owner); err != nil {
			_ = rows.Close()
			return nil, err
		}
		path := filepath.ToSlash(filepath.Join("users", owner))
		roots[path] = scanRoot{path: path, owner: owner}
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for _, folder := range folders {
		root := managedRoot(folder.path)
		if !strings.HasPrefix(root, "shared/") || filepath.ToSlash(filepath.Clean(filepath.FromSlash(folder.path))) != root {
			continue
		}
		roots[root] = scanRoot{path: root, owner: folder.owner, folderID: folder.id}
	}
	result := make([]scanRoot, 0, len(roots))
	for _, root := range roots {
		result = append(result, root)
	}
	return result, nil
}

func (s *Service) ensureFolder(ctx context.Context, folders map[string]folderRecord, root scanRoot, storagePath string) (folderRecord, error) {
	storagePath = filepath.Clean(storagePath)
	if record, ok := folders[storagePath]; ok {
		return record, nil
	}
	name := filepath.Base(storagePath)
	if err := storage.ValidateName(name); err != nil {
		return folderRecord{}, err
	}
	rootPath := filepath.Clean(filepath.FromSlash(root.path))
	parentPath := filepath.Dir(storagePath)
	var parentID any
	if parentPath == rootPath {
		if root.folderID != "" {
			parentID = root.folderID
		}
	} else {
		parent, ok := folders[parentPath]
		if !ok {
			return folderRecord{}, fmt.Errorf("scan parent folder is not indexed: %s", filepath.ToSlash(parentPath))
		}
		parentID = parent.id
	}
	record := folderRecord{id: newFolderID(), owner: root.owner, path: filepath.ToSlash(storagePath)}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.ExecContext(ctx, `INSERT INTO folders (id, owner_id, parent_id, storage_path, name, is_shared, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, 0, ?, ?)`, record.id, record.owner, parentID, record.path, name, now, now)
	if err != nil {
		var existing folderRecord
		queryErr := s.db.QueryRowContext(ctx, "SELECT id, owner_id, storage_path FROM folders WHERE storage_path=?", record.path).Scan(&existing.id, &existing.owner, &existing.path)
		if queryErr == nil {
			if existing.owner != root.owner {
				return folderRecord{}, fmt.Errorf("scan folder owner mismatch for %s", record.path)
			}
			folders[storagePath] = existing
			return existing, nil
		}
		return folderRecord{}, fmt.Errorf("index scanned folder %s: %w", record.path, err)
	}
	folders[storagePath] = record
	return record, nil
}

func (s *Service) increment(job *Job, update func(*Counts)) {
	s.mu.Lock()
	update(&job.Counts)
	s.mu.Unlock()
}

func managedRoot(storagePath string) string {
	clean := filepath.ToSlash(filepath.Clean(storagePath))
	parts := strings.Split(clean, "/")
	if len(parts) < 2 || (parts[0] != "users" && parts[0] != "shared") || parts[1] == "" {
		return ""
	}
	return parts[0] + "/" + parts[1]
}

func newFolderID() string {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		panic("crypto/rand unavailable")
	}
	return "f_" + hex.EncodeToString(raw)
}

func newJobID() string { return fmt.Sprintf("scan_%d", time.Now().UnixNano()) }
