package indexer

import (
	"context"
	"database/sql"
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
type scanRoot struct{ path string }

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
	rows, err := s.db.QueryContext(ctx, "SELECT id, owner_id, storage_path FROM folders")
	if err != nil {
		return err
	}
	folders := make(map[string]folderRecord)
	for rows.Next() {
		var record folderRecord
		if err := rows.Scan(&record.id, &record.owner, &record.path); err != nil {
			_ = rows.Close()
			return err
		}
		folders[filepath.Clean(filepath.FromSlash(record.path))] = record
	}
	if err := rows.Close(); err != nil {
		return err
	}
	seen := make(map[string]struct{})
	walkedRoots := make(map[string]bool)
	for _, rootRecord := range uniqueScanRoots(folders) {
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
			if entry.IsDir() {
				return nil
			}
			if entry.Type()&os.ModeSymlink != 0 || strings.HasPrefix(entry.Name(), ".") || strings.HasSuffix(entry.Name(), ".tmp") {
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
	rows, err = s.db.QueryContext(ctx, "SELECT owner_id, storage_path FROM photos WHERE deleted_at IS NULL AND scan_status='indexed'")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var owner, path string
		if err := rows.Scan(&owner, &path); err != nil {
			return err
		}
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
	return rows.Err()
}

func (s *Service) increment(job *Job, update func(*Counts)) {
	s.mu.Lock()
	update(&job.Counts)
	s.mu.Unlock()
}

func uniqueScanRoots(folders map[string]folderRecord) []scanRoot {
	roots := make(map[string]scanRoot)
	for _, folder := range folders {
		root := managedRoot(folder.path)
		if root == "" {
			continue
		}
		if _, exists := roots[root]; !exists {
			roots[root] = scanRoot{path: root}
		}
	}
	result := make([]scanRoot, 0, len(roots))
	for _, root := range roots {
		result = append(result, root)
	}
	return result
}

func managedRoot(storagePath string) string {
	clean := filepath.ToSlash(filepath.Clean(storagePath))
	parts := strings.Split(clean, "/")
	if len(parts) < 2 || (parts[0] != "users" && parts[0] != "shared") || parts[1] == "" {
		return ""
	}
	return parts[0] + "/" + parts[1]
}

func newJobID() string { return fmt.Sprintf("scan_%d", time.Now().UnixNano()) }
