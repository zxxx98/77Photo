package photos

import (
	"context"
	"testing"
)

type rejectingThumbnailQueue struct {
	calls int
}

func (q *rejectingThumbnailQueue) Enqueue(string) bool {
	q.calls++
	return false
}

func TestEnqueueScannedThumbnailDoesNotBlockOnFullQueue(t *testing.T) {
	queue := &rejectingThumbnailQueue{}
	service := &Service{queue: queue}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if err := service.enqueueScannedThumbnail(ctx, "p_scan"); err != nil {
		t.Fatalf("enqueueScannedThumbnail() error = %v, want nil", err)
	}
	if queue.calls != 1 {
		t.Fatalf("Enqueue() calls = %d, want 1", queue.calls)
	}
}
