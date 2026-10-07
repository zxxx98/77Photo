package main

import (
	"bytes"
	"context"
	"log/slog"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestRunStopsGracefullyWhenContextIsCanceled(t *testing.T) {
	root := t.TempDir()
	t.Setenv("PHOTO_DATA_DIR", filepath.Join(root, "photos"))
	t.Setenv("PHOTO_CACHE_DIR", filepath.Join(root, "cache"))
	t.Setenv("PHOTO_DB_PATH", filepath.Join(root, "db", "77photo.db"))
	t.Setenv("PHOTO_LISTEN_ADDR", "127.0.0.1:0")
	ready := make(chan struct{})
	logger := slog.New(&readyHandler{Handler: slog.NewTextHandler(bytes.NewBuffer(nil), nil), ready: ready})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- run(ctx, logger) }()

	// Wait for actual startup rather than racing migrations on a busy host.
	select {
	case <-ready:
	case err := <-done:
		t.Fatalf("startup stopped early: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("server did not start")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("run() error = %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("run() did not stop after context cancellation")
	}
}

type readyHandler struct {
	slog.Handler
	ready chan struct{}
	once  sync.Once
}

func (h *readyHandler) Handle(ctx context.Context, r slog.Record) error {
	if r.Message == "server started" {
		h.once.Do(func() { close(h.ready) })
	}
	return h.Handler.Handle(ctx, r)
}
