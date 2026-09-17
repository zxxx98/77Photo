package thumbnails

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
)

type RebuildStatus string

const (
	RebuildQueued    RebuildStatus = "queued"
	RebuildRunning   RebuildStatus = "running"
	RebuildCompleted RebuildStatus = "completed"
	RebuildFailed    RebuildStatus = "failed"
)

var (
	ErrRebuildForbidden = errors.New("thumbnail rebuild requires administrator access")
	ErrRebuildConflict  = errors.New("a thumbnail rebuild is already queued or running")
	ErrRebuildNotFound  = errors.New("thumbnail rebuild job not found")
)

type RebuildConflictError struct {
	JobID string
}

func (e *RebuildConflictError) Error() string { return ErrRebuildConflict.Error() }

func (e *RebuildConflictError) Unwrap() error { return ErrRebuildConflict }

type RebuildCounts struct {
	Total       int `json:"total"`
	Processed   int `json:"processed"`
	Regenerated int `json:"regenerated"`
	Failed      int `json:"failed"`
}

type RebuildJob struct {
	ID         string         `json:"id"`
	Status     RebuildStatus  `json:"status"`
	StartedAt  time.Time      `json:"started_at"`
	FinishedAt *time.Time     `json:"finished_at,omitempty"`
	Counts     RebuildCounts  `json:"counts"`
	Error      *string        `json:"error,omitempty"`
}

type RebuildService struct {
	db         *sql.DB
	thumbnails *Service
	lifecycle  context.Context
	mu         sync.RWMutex
	job        *RebuildJob
	done       chan struct{}
}

func NewRebuildServiceWithContext(ctx context.Context, db *sql.DB, thumbnailService *Service) *RebuildService {
	return &RebuildService{db: db, thumbnails: thumbnailService, lifecycle: ctx}
}

func (s *RebuildService) Start(ctx context.Context, principal acl.Principal) (RebuildJob, error) {
	if principal.Role != acl.RoleAdmin {
		return RebuildJob{}, ErrRebuildForbidden
	}
	s.mu.Lock()
	if s.job != nil && (s.job.Status == RebuildQueued || s.job.Status == RebuildRunning) {
		jobID := s.job.ID
		s.mu.Unlock()
		return RebuildJob{}, &RebuildConflictError{JobID: jobID}
	}
	now := time.Now().UTC()
	job := &RebuildJob{ID: newRebuildJobID(), Status: RebuildQueued, StartedAt: now}
	s.job = job
	done := make(chan struct{})
	s.done = done
	snapshot := *job
	s.mu.Unlock()

	rebuildContext := s.lifecycle
	if rebuildContext == nil {
		rebuildContext = context.WithoutCancel(ctx)
	}
	go s.run(rebuildContext, job, done)
	return snapshot, nil
}

func (s *RebuildService) Get(_ context.Context, principal acl.Principal, id string) (RebuildJob, error) {
	if principal.Role != acl.RoleAdmin {
		return RebuildJob{}, ErrRebuildForbidden
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.job == nil || s.job.ID != id {
		return RebuildJob{}, ErrRebuildNotFound
	}
	return *s.job, nil
}

func (s *RebuildService) Wait() {
	s.mu.RLock()
	done := s.done
	s.mu.RUnlock()
	if done != nil {
		<-done
	}
}

func (s *RebuildService) run(ctx context.Context, job *RebuildJob, done chan struct{}) {
	defer close(done)
	s.mu.Lock()
	job.Status = RebuildRunning
	s.mu.Unlock()

	err := s.rebuild(ctx, job)
	s.mu.Lock()
	if err != nil {
		job.Status = RebuildFailed
		message := err.Error()
		job.Error = &message
	} else {
		job.Status = RebuildCompleted
	}
	finished := time.Now().UTC()
	job.FinishedAt = &finished
	s.mu.Unlock()
}

func (s *RebuildService) rebuild(ctx context.Context, job *RebuildJob) error {
	if s.db == nil || s.thumbnails == nil {
		return errors.New("thumbnail rebuild service is not initialized")
	}
	ids, err := s.loadCandidateIDs(ctx)
	if err != nil {
		return err
	}
	s.mu.Lock()
	job.Counts.Total = len(ids)
	s.mu.Unlock()

	for _, id := range ids {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := s.regenerate(ctx, id)
		s.mu.Lock()
		job.Counts.Processed++
		if err != nil {
			job.Counts.Failed++
		} else {
			job.Counts.Regenerated++
		}
		s.mu.Unlock()
	}
	return nil
}

func (s *RebuildService) loadCandidateIDs(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT id, mime_type FROM photos WHERE deleted_at IS NULL AND scan_status='indexed' ORDER BY id")
	if err != nil {
		return nil, fmt.Errorf("list thumbnail rebuild candidates: %w", err)
	}
	defer rows.Close()
	ids := make([]string, 0)
	for rows.Next() {
		var id, mimeType string
		if err := rows.Scan(&id, &mimeType); err != nil {
			return nil, fmt.Errorf("read thumbnail rebuild candidate: %w", err)
		}
		if isThumbnailMIME(mimeType) {
			ids = append(ids, id)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate thumbnail rebuild candidates: %w", err)
	}
	return ids, nil
}

func (s *RebuildService) regenerate(ctx context.Context, photoID string) error {
	if err := s.reserve(ctx, photoID); err != nil {
		return err
	}
	defer s.release(photoID)
	if s.thumbnails.workerCtx == nil {
		return errors.New("thumbnail worker service is not started")
	}
	if err := s.thumbnails.Invalidate(ctx, photoID); err != nil {
		return err
	}
	var lastErr error
	for attempt := 1; attempt <= MaxAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := s.thumbnails.generate(photoID); err == nil {
			return nil
		} else {
			lastErr = err
		}
	}
	return lastErr
}

func (s *RebuildService) reserve(ctx context.Context, photoID string) error {
	for {
		s.thumbnails.mu.Lock()
		if _, exists := s.thumbnails.pending[photoID]; !exists {
			s.thumbnails.pending[photoID] = struct{}{}
			s.thumbnails.mu.Unlock()
			return nil
		}
		s.thumbnails.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
}

func (s *RebuildService) release(photoID string) {
	s.thumbnails.mu.Lock()
	delete(s.thumbnails.pending, photoID)
	s.thumbnails.mu.Unlock()
}

func newRebuildJobID() string {
	var raw [12]byte
	if _, err := rand.Read(raw[:]); err == nil {
		return "tr_" + hex.EncodeToString(raw[:])
	}
	return fmt.Sprintf("tr_%x", time.Now().UnixNano())
}
