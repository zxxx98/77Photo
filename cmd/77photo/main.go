package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/zxxx98/77Photo/internal/config"
	"github.com/zxxx98/77Photo/internal/httpapi"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if err := run(context.Background(), logger); err != nil {
		logger.Error("server stopped with error", "error", err)
		os.Exit(1)
	}
}

func run(parent context.Context, logger *slog.Logger) error {
	cfg, err := config.LoadFromEnv()
	if err != nil {
		return fmt.Errorf("load configuration: %w", err)
	}
	if err := cfg.ValidateFilesystem(); err != nil {
		return fmt.Errorf("validate filesystem: %w", err)
	}
	if err := ensureDatabaseFile(cfg.DBPath); err != nil {
		return fmt.Errorf("initialize database path: %w", err)
	}

	handler := httpapi.NewHandler(configuredHealthChecks(cfg), logger)
	server := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	ctx, stop := signal.NotifyContext(parent, os.Interrupt, syscall.SIGTERM)
	defer stop()
	serveErr := make(chan error, 1)
	go func() {
		logger.Info("server started", "addr", cfg.ListenAddr)
		if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
			return
		}
		serveErr <- nil
	}()

	select {
	case err := <-serveErr:
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		logger.Info("server stopping", "reason", ctx.Err())
		if err := server.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("graceful shutdown: %w", err)
		}
		return <-serveErr
	}
}

func configuredHealthChecks(cfg config.Config) httpapi.HealthChecks {
	return httpapi.HealthChecks{
		// T03 replaces this file-existence probe with a SQLite PingContext.
		Database: func(context.Context) error {
			info, err := os.Stat(cfg.DBPath)
			if err != nil {
				return fmt.Errorf("database unavailable: %w", err)
			}
			if info.IsDir() {
				return fmt.Errorf("database unavailable: path is a directory")
			}
			return nil
		},
		Storage: func(context.Context) error {
			info, err := os.Stat(cfg.DataDir)
			if err != nil {
				return fmt.Errorf("photo storage unavailable: %w", err)
			}
			if !info.IsDir() {
				return fmt.Errorf("photo storage unavailable: path is not a directory")
			}
			return nil
		},
	}
}

func ensureDatabaseFile(path string) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o640)
	if err != nil {
		return err
	}
	return file.Close()
}
