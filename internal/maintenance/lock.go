// Package maintenance serializes administrator maintenance jobs (rescan and
// reset, thumbnail rebuild, import, broken photo cleanup and moving a deleted
// user's files to another user) so they never
// mutate the library index or caches concurrently.
package maintenance

import (
	"errors"
	"sync"
)

type Kind string

const (
	KindTrash            Kind = "trash"
	KindFaceScan         Kind = "face_scan"
	KindRescan           Kind = "rescan"
	KindThumbnailRebuild Kind = "thumbnail_rebuild"
	KindImport           Kind = "import"
	KindCleanup          Kind = "cleanup"
	KindUserTransfer     Kind = "user_transfer"
)

var ErrBusy = errors.New("another maintenance task is queued or running")

type Activity struct {
	Kind  Kind   `json:"kind"`
	JobID string `json:"job_id,omitempty"`
}

type BusyError struct {
	Active Activity
}

func (e *BusyError) Error() string { return ErrBusy.Error() }

func (e *BusyError) Unwrap() error { return ErrBusy }

// Lock admits one maintenance activity at a time. A nil *Lock admits
// everything, which keeps services usable when no lock is wired in.
type Lock struct {
	mu     sync.Mutex
	active *Activity
}

// Acquire claims the lock for kind/jobID or reports the current holder. The
// returned release func is idempotent.
func (l *Lock) Acquire(kind Kind, jobID string) (func(), error) {
	if l == nil {
		return func() {}, nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.active != nil {
		return nil, &BusyError{Active: *l.active}
	}
	activity := &Activity{Kind: kind, JobID: jobID}
	l.active = activity
	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			if l.active == activity {
				l.active = nil
			}
			l.mu.Unlock()
		})
	}, nil
}

// Current returns the activity holding the lock, if any.
func (l *Lock) Current() (Activity, bool) {
	if l == nil {
		return Activity{}, false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.active == nil {
		return Activity{}, false
	}
	return *l.active, true
}

// Details renders a BusyError as API error details.
func Details(err error) map[string]any {
	var busy *BusyError
	if !errors.As(err, &busy) {
		return nil
	}
	details := map[string]any{"kind": busy.Active.Kind}
	if busy.Active.JobID != "" {
		details["job_id"] = busy.Active.JobID
	}
	return details
}
