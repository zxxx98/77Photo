package importer

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
	"github.com/zxxx98/77Photo/internal/indexer"
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
	ErrForbidden     = errors.New("import requires administrator access")
	ErrConflict      = errors.New("an import is already queued or running")
	ErrNotFound      = errors.New("import job not found")
	ErrInvalidSource = errors.New("invalid import source")
	ErrUserNotFound  = errors.New("target user not found")
)

type Counts struct {
	Scanned int `json:"scanned"`
	Moved   int `json:"moved"`
	Skipped int `json:"skipped"`
	Failed  int `json:"failed"`
}

type Job struct {
	ID         string     `json:"id"`
	Status     Status     `json:"status"`
	SourcePath string     `json:"source_path"`
	UserID     string     `json:"user_id"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
	Counts     Counts     `json:"counts"`
	Error      *string    `json:"error,omitempty"`
}

type fileMove struct {
	source      string
	destination string
}

type Service struct {
	db        *sql.DB
	storage   storage.Store
	indexer   *indexer.Service
	lifecycle context.Context
	mu        sync.RWMutex
	job       *Job
	done      chan struct{}
}

func NewService(db *sql.DB, store storage.Store, indexerService *indexer.Service) *Service {
	return &Service{db: db, storage: store, indexer: indexerService}
}

func NewServiceWithContext(ctx context.Context, db *sql.DB, store storage.Store, indexerService *indexer.Service) *Service {
	service := NewService(db, store, indexerService)
	service.lifecycle = ctx
	return service
}

func (s *Service) Start(ctx context.Context, principal acl.Principal, sourcePath, userID string) (Job, error) {
	if principal.Role != acl.RoleAdmin {
		return Job{}, ErrForbidden
	}
	sourcePath, err := normalizeSource(sourcePath)
	if err != nil {
		return Job{}, err
	}
	if err := s.validateUser(ctx, userID); err != nil {
		return Job{}, err
	}
	if err := s.validateSource(sourcePath); err != nil {
		return Job{}, err
	}

	s.mu.Lock()
	if s.job != nil && (s.job.Status == StatusQueued || s.job.Status == StatusRunning) {
		s.mu.Unlock()
		return Job{}, ErrConflict
	}
	now := time.Now().UTC()
	job := &Job{ID: fmt.Sprintf("import_%d", now.UnixNano()), Status: StatusQueued, SourcePath: filepath.ToSlash(sourcePath), UserID: userID, StartedAt: now}
	s.job = job
	done := make(chan struct{})
	s.done = done
	snapshot := *job
	s.mu.Unlock()

	runContext := s.lifecycle
	if runContext == nil {
		runContext = context.WithoutCancel(ctx)
	}
	go s.run(runContext, principal, job, done)
	return snapshot, nil
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

func (s *Service) Wait() {
	s.mu.RLock()
	done := s.done
	s.mu.RUnlock()
	if done != nil {
		<-done
	}
}

func (s *Service) run(ctx context.Context, principal acl.Principal, job *Job, done chan struct{}) {
	defer close(done)
	s.mu.Lock()
	job.Status = StatusRunning
	s.mu.Unlock()

	err := s.importFiles(ctx, principal, job)
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

func (s *Service) importFiles(ctx context.Context, principal acl.Principal, job *Job) error {
	moves, err := s.collectMoves(job.SourcePath, job.UserID, job)
	if err != nil {
		return err
	}
	if err := s.storage.EnsureUserRoot(job.UserID); err != nil {
		return fmt.Errorf("prepare target user directory: %w", err)
	}

	for _, move := range moves {
		if err := ctx.Err(); err != nil {
			return err
		}
		destination, err := s.storage.ResolvePath(move.destination)
		if err != nil {
			s.increment(job, func(c *Counts) { c.Failed++ })
			continue
		}
		if err := os.MkdirAll(filepath.Dir(destination), 0o750); err != nil {
			s.increment(job, func(c *Counts) { c.Failed++ })
			continue
		}
		if _, err := os.Lstat(destination); err == nil {
			s.increment(job, func(c *Counts) { c.Skipped++ })
			continue
		} else if !os.IsNotExist(err) {
			s.increment(job, func(c *Counts) { c.Failed++ })
			continue
		}
		if err := s.storage.Rename(move.source, move.destination); err != nil {
			s.increment(job, func(c *Counts) { c.Failed++ })
			continue
		}
		s.increment(job, func(c *Counts) { c.Moved++ })
	}

	if s.indexer == nil {
		return errors.New("indexer service is required")
	}
	return s.rescan(ctx, principal)
}

func (s *Service) collectMoves(sourcePath, userID string, job *Job) ([]fileMove, error) {
	root, err := s.storage.ResolvePath(sourcePath)
	if err != nil {
		return nil, ErrInvalidSource
	}
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return nil, ErrInvalidSource
	}

	moves := make([]fileMove, 0)
	err = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			s.increment(job, func(c *Counts) { c.Failed++ })
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			s.increment(job, func(c *Counts) { c.Skipped++ })
			return nil
		}
		if entry.IsDir() {
			if path == root {
				return nil
			}
			if strings.HasPrefix(entry.Name(), ".") {
				return filepath.SkipDir
			}
			if sourcePath == "." {
				rel, relErr := filepath.Rel(root, path)
				if relErr == nil {
					first := strings.Split(filepath.ToSlash(rel), "/")[0]
					if first == "users" || first == "shared" {
						return filepath.SkipDir
					}
				}
			}
			return nil
		}
		if strings.HasPrefix(entry.Name(), ".") || strings.HasSuffix(entry.Name(), ".tmp") {
			s.increment(job, func(c *Counts) { c.Skipped++ })
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil || rel == "." {
			s.increment(job, func(c *Counts) { c.Failed++ })
			return nil
		}
		sourceRelative, err := filepath.Rel(s.storage.Root(), path)
		if err != nil {
			s.increment(job, func(c *Counts) { c.Failed++ })
			return nil
		}
		destination := filepath.Join("users", userID, "Imported", rel)
		moves = append(moves, fileMove{source: filepath.ToSlash(sourceRelative), destination: filepath.ToSlash(destination)})
		s.increment(job, func(c *Counts) { c.Scanned++ })
		return nil
	})
	if err != nil {
		return nil, err
	}
	return moves, nil
}

func (s *Service) rescan(ctx context.Context, principal acl.Principal) error {
	for {
		job, err := s.indexer.Start(ctx, principal)
		if err == nil {
			for {
				status, getErr := s.indexer.Get(ctx, principal, job.ID)
				if getErr != nil {
					return getErr
				}
				switch status.Status {
				case indexer.StatusCompleted:
					return nil
				case indexer.StatusFailed:
					if status.Error != nil {
						return errors.New(*status.Error)
					}
					return errors.New("rescan failed after import")
				}
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(250 * time.Millisecond):
				}
			}
		}
		var conflict *indexer.ConflictError
		if !errors.As(err, &conflict) || conflict.JobID == "" {
			return err
		}
		for {
			status, getErr := s.indexer.Get(ctx, principal, conflict.JobID)
			if getErr != nil {
				break
			}
			if status.Status != indexer.StatusQueued && status.Status != indexer.StatusRunning {
				break
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(250 * time.Millisecond):
			}
		}
	}
}

func (s *Service) validateUser(ctx context.Context, userID string) error {
	if strings.TrimSpace(userID) == "" {
		return ErrUserNotFound
	}
	var exists int
	err := s.db.QueryRowContext(ctx, "SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL", userID).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrUserNotFound
	}
	return err
}

func (s *Service) validateSource(sourcePath string) error {
	if sourcePath != "." {
		first := strings.Split(filepath.ToSlash(sourcePath), "/")[0]
		if first == "users" || first == "shared" || strings.HasPrefix(first, ".") {
			return ErrInvalidSource
		}
	}
	path, err := s.storage.ResolvePath(sourcePath)
	if err != nil {
		return ErrInvalidSource
	}
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		return ErrInvalidSource
	}
	return nil
}

func normalizeSource(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || value == "." {
		return ".", nil
	}
	if filepath.IsAbs(value) || strings.Contains(value, "\\") || strings.ContainsRune(value, '\x00') {
		return "", ErrInvalidSource
	}
	clean := filepath.Clean(filepath.FromSlash(value))
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", ErrInvalidSource
	}
	return clean, nil
}

func (s *Service) increment(job *Job, update func(*Counts)) {
	s.mu.Lock()
	update(&job.Counts)
	s.mu.Unlock()
}
