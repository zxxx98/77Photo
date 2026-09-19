package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
	"github.com/zxxx98/77Photo/internal/cleanup"
	"github.com/zxxx98/77Photo/internal/config"
	"github.com/zxxx98/77Photo/internal/database"
	"github.com/zxxx98/77Photo/internal/folders"
	"github.com/zxxx98/77Photo/internal/httpapi"
	"github.com/zxxx98/77Photo/internal/importer"
	"github.com/zxxx98/77Photo/internal/indexer"
	"github.com/zxxx98/77Photo/internal/media"
	"github.com/zxxx98/77Photo/internal/photos"
	"github.com/zxxx98/77Photo/internal/sharelinks"
	"github.com/zxxx98/77Photo/internal/shares"
	"github.com/zxxx98/77Photo/internal/storage"
	"github.com/zxxx98/77Photo/internal/thumbnails"
	"github.com/zxxx98/77Photo/internal/users"
	"github.com/zxxx98/77Photo/internal/webassets"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if err := run(context.Background(), logger); err != nil {
		logger.Error("server stopped with error", "error", err)
		os.Exit(1)
	}
}

func run(parent context.Context, logger *slog.Logger) error {
	ctx, stop := signal.NotifyContext(parent, os.Interrupt, syscall.SIGTERM)
	defer stop()
	cfg, err := config.LoadFromEnv()
	if err != nil {
		return fmt.Errorf("load configuration: %w", err)
	}
	if err := cfg.ValidateFilesystem(); err != nil {
		return fmt.Errorf("validate filesystem: %w", err)
	}
	mediaTools := &media.Tools{
		FFmpeg:         cfg.FFmpegPath,
		FFprobe:        cfg.FFprobePath,
		HeifConvert:    cfg.HeifConvertPath,
		Runner:         media.NewRunner(cfg.MaxUploadSize),
		Timeout:        cfg.MediaTimeout,
		MaxOutputBytes: cfg.MaxUploadSize,
		MaxInputBytes:  cfg.MaxUploadSize,
	}
	db, err := database.Open(ctx, cfg.DBPath)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer db.Close()
	authService := auth.NewService(db, cfg.SessionTTL, os.Getenv("PHOTO_COOKIE_SECURE") != "false")
	userService := users.NewService(db, authService)
	photoStore, err := storage.New(cfg.DataDir)
	if err != nil {
		return fmt.Errorf("initialize photo storage: %w", err)
	}
	folderService := folders.NewService(db, photoStore)
	photoService := photos.NewService(db, photoStore, cfg.MaxUploadSize)
	photoService.SetLogger(logger)
	photoService.SetMediaTools(mediaTools)
	authorizer := acl.NewAuthorizer(db)
	folderService.SetAuthorizer(authorizer)
	photoService.SetAuthorizer(authorizer)
	shareService := shares.NewService(db)
	indexerService := indexer.NewServiceWithContext(ctx, db, photoStore, photoService)
	indexerService.SetMediaTools(mediaTools)
	defer indexerService.Wait()
	importerService := importer.NewServiceWithContext(ctx, db, photoStore, indexerService)
	importerService.SetMediaTools(mediaTools)
	defer importerService.Wait()
	thumbnailService, err := thumbnails.NewService(photoService, photoStore, cfg.CacheDir, cfg.ThumbnailWorkers, thumbnails.DefaultQueueCapacity)
	if err != nil {
		return fmt.Errorf("initialize thumbnail service: %w", err)
	}
	thumbnailService.SetMediaTools(mediaTools)
	indexerService.SetThumbnailResetter(thumbnailService)
	photoService.SetCacheInvalidator(thumbnailService)
	photoService.SetThumbnailEnqueuer(thumbnailService)
	thumbnailService.Start(ctx)
	defer thumbnailService.Close()
	thumbnailRebuildService := thumbnails.NewRebuildServiceWithContext(ctx, db, thumbnailService)
	defer thumbnailRebuildService.Wait()
	thumbnailRebuildHandler := thumbnails.NewRebuildHTTPHandler(thumbnailRebuildService, authService)
	photoCleanupService := cleanup.NewService(db, photoStore, photoService)
	photoCleanupHandler := cleanup.NewHTTPHandler(photoCleanupService, authService)

	secureCookies := os.Getenv("PHOTO_COOKIE_SECURE") != "false"
	shareLinkService := sharelinks.NewService(db, photoStore, thumbnailService, secureCookies)
	handler := httpapi.NewHandlerWithServices(configuredHealthChecks(cfg, db, mediaTools), logger, httpapi.Services{Auth: authService, Users: userService, Folders: folderService, Photos: photoService, Thumbnails: thumbnailService, ThumbnailRebuild: thumbnailRebuildHandler, PhotoCleanup: photoCleanupHandler, Shares: shareService, ShareLinks: shareLinkService, Indexer: indexerService, Importer: importerService, SecureCookies: secureCookies, Static: webassets.Handler()})
	server := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
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

func configuredHealthChecks(cfg config.Config, db *sql.DB, mediaTools *media.Tools) httpapi.HealthChecks {
	return httpapi.HealthChecks{
		Database: func(ctx context.Context) error {
			if err := db.PingContext(ctx); err != nil {
				return fmt.Errorf("database unavailable: %w", err)
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
		Media: func(context.Context) error {
			if mediaTools == nil {
				return errors.New("media tools unavailable")
			}
			for _, executable := range []string{mediaTools.FFmpeg, mediaTools.FFprobe, mediaTools.HeifConvert} {
				if _, err := exec.LookPath(executable); err != nil {
					return fmt.Errorf("media tool %q unavailable: %w", executable, err)
				}
			}
			return nil
		},
	}
}
