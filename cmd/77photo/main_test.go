package main

import (
	"bytes"
	"context"
	"log/slog"
	"path/filepath"
	"testing"
	"time"
)

func TestRunStopsGracefullyWhenContextIsCanceled(t *testing.T) {
	root := t.TempDir()
	t.Setenv("PHOTO_DATA_DIR", filepath.Join(root, "photos"))
	t.Setenv("PHOTO_CACHE_DIR", filepath.Join(root, "cache"))
	t.Setenv("PHOTO_DB_PATH", filepath.Join(root, "db", "77photo.db"))
	t.Setenv("PHOTO_LISTEN_ADDR", "127.0.0.1:0")
	logger := slog.New(slog.NewTextHandler(bytes.NewBuffer(nil), nil))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- run(ctx, logger) }()

	// Let ListenAndServe enter its serving state before asking it to stop.
	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("run() error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("run() did not stop after context cancellation")
	}
}
