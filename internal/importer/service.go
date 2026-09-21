package importer

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/indexer"
	"github.com/zxxx98/77Photo/internal/media"
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
	OrganizeByDate bool       `json:"organize_by_date"`
	ID             string     `json:"id"`
	Status         Status     `json:"status"`
	SourcePath     string     `json:"source_path"`
	UserID         string     `json:"user_id"`
	StartedAt      time.Time  `json:"started_at"`
	FinishedAt     *time.Time `json:"finished_at,omitempty"`
	Counts         Counts     `json:"counts"`
	Error          *string    `json:"error,omitempty"`
}

type fileMove struct {
	source      string
	destination string
	pairKey     string
}

type importCandidate struct {
	source      string
	relative    string
	storagePath string
	still       bool
	MOV         bool
	MP4         bool
}

type Service struct {
	db         *sql.DB
	storage    storage.Store
	indexer    *indexer.Service
	mediaTools *media.Tools
	lifecycle  context.Context
	mu         sync.RWMutex
	job        *Job
	done       chan struct{}
}

func NewService(db *sql.DB, store storage.Store, indexerService *indexer.Service) *Service {
	return &Service{db: db, storage: store, indexer: indexerService}
}

func (s *Service) SetMediaTools(tools *media.Tools) { s.mediaTools = tools }

func NewServiceWithContext(ctx context.Context, db *sql.DB, store storage.Store, indexerService *indexer.Service) *Service {
	service := NewService(db, store, indexerService)
	service.lifecycle = ctx
	return service
}

func (s *Service) Start(ctx context.Context, principal acl.Principal, sourcePath, userID string) (Job, error) {
	return s.StartWithOptions(ctx, principal, sourcePath, userID, false)
}

func (s *Service) StartWithOptions(ctx context.Context, principal acl.Principal, sourcePath, userID string, organizeByDate bool) (Job, error) {
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
	job := &Job{ID: fmt.Sprintf("import_%d", now.UnixNano()), Status: StatusQueued, SourcePath: filepath.ToSlash(sourcePath), UserID: userID, StartedAt: now, OrganizeByDate: organizeByDate}
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

	reserved := make(map[string]map[string]bool)
	for _, group := range groupMoves(moves) {
		if err := ctx.Err(); err != nil {
			return err
		}
		if job.OrganizeByDate {
			if err := s.organizeGroup(ctx, job.UserID, group, reserved); err != nil {
				s.increment(job, func(c *Counts) { c.Failed += len(group) })
				continue
			}
		}
		s.moveGroup(job, group)
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

	candidates := make([]importCandidate, 0)
	err = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			s.increment(job, func(c *Counts) { c.Failed++ })
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
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
		s.increment(job, func(c *Counts) { c.Scanned++ })
		isMOV := strings.EqualFold(filepath.Ext(entry.Name()), ".mov")
		if isMOV {
			sourceRelative, relErr := filepath.Rel(s.storage.Root(), path)
			rel, relativeErr := filepath.Rel(root, path)
			if relErr != nil || relativeErr != nil || rel == "." {
				s.increment(job, func(c *Counts) { c.Failed++ })
				return nil
			}
			candidates = append(candidates, importCandidate{source: filepath.ToSlash(sourceRelative), relative: filepath.ToSlash(rel), storagePath: filepath.ToSlash(sourceRelative), MOV: true})
			return nil
		}
		inspection, inspectErr := inspectImportMedia(path)
		if inspectErr != nil {
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
		candidates = append(candidates, importCandidate{source: filepath.ToSlash(sourceRelative), relative: filepath.ToSlash(rel), storagePath: filepath.ToSlash(sourceRelative), still: inspection.Kind == media.KindStill, MP4: inspection.Kind == media.KindVideo && inspection.MIME == "video/mp4"})
		return nil
	})
	if err != nil {
		return nil, err
	}
	stillKeys := make(map[string]struct{})
	motionKeys := make(map[string]struct{})
	for _, candidate := range candidates {
		if candidate.still {
			stillKeys[mediaPairKey(candidate.relative)] = struct{}{}
		} else if candidate.MOV || candidate.MP4 {
			motionKeys[mediaPairKey(candidate.relative)] = struct{}{}
		}
	}
	moves := make([]fileMove, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate.MOV {
			if _, ok := stillKeys[mediaPairKey(candidate.relative)]; !ok {
				s.increment(job, func(c *Counts) { c.Skipped++ })
				continue
			}
		}
		destination := filepath.Join("users", userID, "Imported", candidate.relative)
		pairKey := ""
		key := mediaPairKey(candidate.relative)
		if _, hasStill := stillKeys[key]; hasStill {
			if candidate.MOV || candidate.MP4 {
				pairKey = key
			} else if _, hasMotion := motionKeys[key]; hasMotion {
				pairKey = key
			}
		}
		moves = append(moves, fileMove{source: candidate.source, destination: filepath.ToSlash(destination), pairKey: pairKey})
	}
	return moves, nil
}

func groupMoves(moves []fileMove) [][]fileMove {
	groups := make([][]fileMove, 0, len(moves))
	paired := make(map[string]int)
	for _, move := range moves {
		if move.pairKey == "" {
			groups = append(groups, []fileMove{move})
			continue
		}
		if index, ok := paired[move.pairKey]; ok {
			groups[index] = append(groups[index], move)
			continue
		}
		paired[move.pairKey] = len(groups)
		groups = append(groups, []fileMove{move})
	}
	return groups
}

func (s *Service) moveGroup(job *Job, group []fileMove) {
	conflict := false
	for _, move := range group {
		destination, err := s.storage.ResolvePath(move.destination)
		if err != nil {
			s.increment(job, func(c *Counts) { c.Failed += len(group) })
			return
		}
		if err := os.MkdirAll(filepath.Dir(destination), 0o750); err != nil {
			s.increment(job, func(c *Counts) { c.Failed += len(group) })
			return
		}
		if _, err := os.Lstat(destination); err == nil {
			conflict = true
		} else if !os.IsNotExist(err) {
			s.increment(job, func(c *Counts) { c.Failed += len(group) })
			return
		}
	}
	if conflict {
		s.increment(job, func(c *Counts) { c.Skipped += len(group) })
		return
	}

	moved := 0
	for _, move := range group {
		if err := s.storage.Rename(move.source, move.destination); err != nil {
			for rollback := moved - 1; rollback >= 0; rollback-- {
				_ = s.storage.Rename(group[rollback].destination, group[rollback].source)
			}
			s.increment(job, func(c *Counts) { c.Failed += len(group) })
			return
		}
		moved++
	}
	s.increment(job, func(c *Counts) { c.Moved += len(group) })
}

func isImportableMedia(path string) bool {
	_, err := inspectImportMedia(path)
	return err == nil
}

func inspectImportMedia(path string) (media.Inspection, error) {
	file, err := os.Open(path)
	if err != nil {
		return media.Inspection{}, err
	}
	defer file.Close()
	head := make([]byte, 512)
	n, err := io.ReadFull(file, head)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return media.Inspection{}, err
	}
	return media.InspectBytes(filepath.Base(path), media.MIMEForExtension(path), head[:n])
}

func mediaPairKey(relative string) string {
	extension := filepath.Ext(relative)
	return strings.ToLower(filepath.ToSlash(strings.TrimSuffix(relative, extension)))
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
