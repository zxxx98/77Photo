package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/zxxx98/77Photo/internal/auth"
	"github.com/zxxx98/77Photo/internal/folders"
	"github.com/zxxx98/77Photo/internal/importer"
	"github.com/zxxx98/77Photo/internal/indexer"
	"github.com/zxxx98/77Photo/internal/photos"
	"github.com/zxxx98/77Photo/internal/sharelinks"
	"github.com/zxxx98/77Photo/internal/shares"
	"github.com/zxxx98/77Photo/internal/users"
)

type contextKey string

const requestIDKey contextKey = "request_id"

// HealthChecks are supplied by the database and storage layers. A nil check
// is treated as unavailable so a partially initialized service cannot report
// a false healthy status.
type HealthChecks struct {
	Database func(context.Context) error
	Storage  func(context.Context) error
}

// NewHandler builds the public HTTP surface available before the feature
// handlers are registered. Feature packages can be mounted under the same
// middleware in later tasks.
func NewHandler(checks HealthChecks, logger *slog.Logger) http.Handler {
	return NewHandlerWithServices(checks, logger, Services{})
}

type Services struct {
	Auth          *auth.Service
	Users         *users.Service
	Folders       *folders.Service
	Photos        *photos.Service
	Thumbnails    photos.ThumbnailService
	Shares        *shares.Service
	ShareLinks    *sharelinks.Service
	Indexer       *indexer.Service
	Importer      *importer.Service
	SecureCookies bool
	Static        http.Handler
}

func NewHandlerWithServices(checks HealthChecks, logger *slog.Logger, services Services) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		healthz(w, r, checks)
	})
	if services.Auth != nil {
		authHandler := auth.NewHTTPHandler(services.Auth, services.SecureCookies)
		mux.Handle("/api/v1/setup/status", authHandler)
		mux.Handle("/api/v1/setup/admin", authHandler)
		mux.Handle("/api/v1/auth/", authHandler)
		mux.Handle("/api/v1/mobile/", auth.NewMobileHTTPHandler(services.Auth))
	}
	if services.Auth != nil && services.Users != nil {
		userHandler := users.NewHTTPHandler(services.Users, services.Auth)
		mux.Handle("/api/v1/users", userHandler)
		mux.Handle("/api/v1/users/", userHandler)
	}
	if services.Auth != nil && services.Folders != nil {
		folderHandler := folders.NewHTTPHandler(services.Folders, services.Auth)
		mux.Handle("/api/v1/folders", folderHandler)
		mux.Handle("/api/v1/folders/", folderHandler)
	}
	if services.Auth != nil && services.Shares != nil {
		mux.Handle("/api/v1/shares", shares.NewHTTPHandler(services.Shares, services.Auth))
		mux.Handle("/api/v1/shares/", shares.NewHTTPHandler(services.Shares, services.Auth))
	}
	if services.ShareLinks != nil {
		shareLinkHandler := sharelinks.NewHTTPHandler(services.ShareLinks, services.Auth)
		mux.Handle("/api/v1/share-links", shareLinkHandler)
		mux.Handle("/api/v1/share-links/", shareLinkHandler)
	}
	if services.Auth != nil && services.Indexer != nil {
		mux.Handle("/api/v1/admin/rescan", indexer.NewHTTPHandler(services.Indexer, services.Auth))
		mux.Handle("/api/v1/admin/rescan/", indexer.NewHTTPHandler(services.Indexer, services.Auth))
	}
	if services.Auth != nil && services.Importer != nil {
		importHandler := importer.NewHTTPHandler(services.Importer, services.Auth)
		mux.Handle("/api/v1/admin/imports", importHandler)
		mux.Handle("/api/v1/admin/imports/", importHandler)
	}
	if services.Auth != nil && services.Photos != nil {
		photoHandler := photos.NewHTTPHandler(services.Photos, services.Auth)
		photoHandler.SetThumbnailService(services.Thumbnails)
		mux.Handle("/api/v1/photos/upload", photoHandler)
		mux.Handle("/api/v1/photos/", photoHandler)
		mux.Handle("/api/v1/live-photos/", photos.NewLiveHTTPHandler(services.Photos, services.Auth))
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if services.Static != nil && !strings.HasPrefix(r.URL.Path, "/api/") {
			services.Static.ServeHTTP(w, r)
			return
		}
		WriteError(w, http.StatusNotFound, "NOT_FOUND", "route not found", RequestID(r.Context()), nil)
	})
	return requestIDMiddleware(loggingMiddleware(mux, logger))
}

func healthz(w http.ResponseWriter, r *http.Request, checks HealthChecks) {
	databaseOK := runHealthCheck(r.Context(), checks.Database)
	storageOK := runHealthCheck(r.Context(), checks.Storage)
	status := "ok"
	code := http.StatusOK
	if !databaseOK || !storageOK {
		status = "degraded"
		code = http.StatusServiceUnavailable
	}
	writeJSON(w, code, map[string]any{
		"status":     status,
		"database":   availability(databaseOK),
		"storage":    availability(storageOK),
		"request_id": RequestID(r.Context()),
	})
}

func runHealthCheck(ctx context.Context, check func(context.Context) error) bool {
	return check != nil && check(ctx) == nil
}

func availability(ok bool) string {
	if ok {
		return "ok"
	}
	return "unavailable"
}

func requestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := sanitizeRequestID(r.Header.Get("X-Request-ID"))
		if id == "" {
			id = newRequestID()
		}
		r.Header.Set("X-Request-ID", id)
		ctx := context.WithValue(r.Context(), requestIDKey, id)
		w.Header().Set("X-Request-ID", id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func loggingMiddleware(next http.Handler, logger *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		recorder := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(recorder, r)
		status := recorder.status
		if status == 0 {
			status = http.StatusOK
		}
		logger.Info("http request",
			"request_id", RequestID(r.Context()),
			"method", r.Method,
			"path", redactLogPath(r.URL.Path),
			"status", status,
			"duration_ms", time.Since(started).Milliseconds(),
		)
	})
}

func redactLogPath(path string) string {
	const prefix = "/api/v1/share-links/"
	if !strings.HasPrefix(path, prefix) {
		return path
	}
	remainder := strings.TrimPrefix(path, prefix)
	if remainder == "" {
		return prefix + "[redacted]"
	}
	parts := strings.SplitN(remainder, "/", 2)
	redacted := prefix + "[redacted]"
	if len(parts) == 2 {
		redacted += "/" + parts[1]
	}
	return redacted
}

type statusWriter struct {
	http.ResponseWriter
	status       int
	bytesWritten int
}

func (w *statusWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(body)
	w.bytesWritten += n
	return n, err
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func WriteError(w http.ResponseWriter, status int, code, message, requestID string, details map[string]any) {
	if requestID == "" {
		requestID = newRequestID()
	}
	payload := map[string]any{
		"error": map[string]any{
			"code":       code,
			"message":    message,
			"request_id": requestID,
		},
	}
	if details != nil {
		payload["error"].(map[string]any)["details"] = details
	}
	writeJSON(w, status, payload)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		// The response may already be committed; logging belongs to the caller's
		// structured request log and no sensitive payload is included here.
		return
	}
}

func RequestID(ctx context.Context) string {
	if id, ok := ctx.Value(requestIDKey).(string); ok {
		return id
	}
	return ""
}

func sanitizeRequestID(value string) string {
	value = strings.TrimSpace(value)
	if len(value) < 1 || len(value) > 128 {
		return ""
	}
	for _, r := range value {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '-' && r != '_' && r != '.' {
			return ""
		}
	}
	return value
}

func newRequestID() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err == nil {
		return hex.EncodeToString(raw[:])
	}
	return fmt.Sprintf("%032x", time.Now().UnixNano())
}
