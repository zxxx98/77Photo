package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/zxxx98/77Photo/internal/auth"
	dbstore "github.com/zxxx98/77Photo/internal/database"
	"github.com/zxxx98/77Photo/internal/sharelinks"
	"github.com/zxxx98/77Photo/internal/storage"
	"github.com/zxxx98/77Photo/internal/users"
	"github.com/zxxx98/77Photo/internal/webassets"
)

func TestNewHandlerWithServicesMountsAuthAndUserRoutes(t *testing.T) {
	db, err := dbstore.Open(context.Background(), filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authService := auth.NewService(db, time.Hour, false)
	userService := users.NewService(db, authService)
	handler := NewHandlerWithServices(HealthChecks{Database: func(context.Context) error { return nil }, Storage: func(context.Context) error { return nil }}, slog.New(slog.NewTextHandler(bytes.NewBuffer(nil), nil)), Services{Auth: authService, Users: userService, Static: webassets.Handler()})
	setupStatus := httptest.NewRecorder()
	handler.ServeHTTP(setupStatus, httptest.NewRequest(http.MethodGet, "/api/v1/setup/status", nil))
	if setupStatus.Code != http.StatusOK || !strings.Contains(setupStatus.Body.String(), `"required":true`) {
		t.Fatalf("setup status = %d/%q, want 200/required", setupStatus.Code, setupStatus.Body.String())
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/setup/admin", strings.NewReader(`{"username":"admin","password":"correct horse battery staple"}`))
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusCreated {
		t.Fatalf("setup status = %d, want 201: %s", res.Code, res.Body.String())
	}
	if res.Header().Get("X-Request-ID") == "" || res.Header().Get("Set-Cookie") == "" {
		t.Fatalf("middleware headers missing: %v", res.Header())
	}
	spa := httptest.NewRecorder()
	handler.ServeHTTP(spa, httptest.NewRequest(http.MethodGet, "/gallery", nil))
	if spa.Code != http.StatusOK || !strings.Contains(spa.Body.String(), "77Photo") {
		t.Fatalf("SPA route status/body = %d/%q", spa.Code, spa.Body.String())
	}
}

func TestNewHandlerWithServicesMountsMobileRoutes(t *testing.T) {
	db, err := dbstore.Open(context.Background(), filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authService := auth.NewService(db, time.Hour, false)
	if _, _, err := authService.SetupAdmin(context.Background(), "admin", "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	handler := NewHandlerWithServices(HealthChecks{}, slog.New(slog.NewTextHandler(bytes.NewBuffer(nil), nil)), Services{Auth: authService})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/mobile/auth/login", strings.NewReader(`{"username":"admin","password":"correct horse battery staple","device_name":"Pixel 9","platform":"android","app_version":"1.0.0"}`))
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"access_token"`) {
		t.Fatalf("mobile login = %d/%q", res.Code, res.Body.String())
	}
	if res.Header().Get("Set-Cookie") != "" || res.Header().Get(auth.CSRFHeaderName()) != "" {
		t.Fatalf("mobile route emitted browser session material: %v", res.Header())
	}
}

func TestMountedMobileMethodErrorUsesGeneratedRequestID(t *testing.T) {
	db, err := dbstore.Open(context.Background(), filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authService := auth.NewService(db, time.Hour, false)
	handler := NewHandlerWithServices(HealthChecks{}, slog.New(slog.NewTextHandler(bytes.NewBuffer(nil), nil)), Services{Auth: authService})
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/mobile/auth/login", nil))
	if res.Code != http.StatusMethodNotAllowed {
		t.Fatalf("mobile method error = %d, want 405", res.Code)
	}
	requestID := res.Header().Get("X-Request-ID")
	if requestID == "" {
		t.Fatal("mobile method error did not generate X-Request-ID")
	}
	var body struct {
		Error struct {
			RequestID string `json:"request_id"`
		} `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Error.RequestID != requestID {
		t.Fatalf("mobile error request_id = %q, header = %q", body.Error.RequestID, requestID)
	}
}

func TestNewHandlerWithServicesMountsPublicShareRoutes(t *testing.T) {
	db, err := dbstore.Open(context.Background(), filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store, err := storage.New(filepath.Join(t.TempDir(), "photos"))
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(bytes.NewBuffer(nil), nil))
	handler := NewHandlerWithServices(HealthChecks{}, logger, Services{ShareLinks: sharelinks.NewService(db, store, nil, false)})
	public := httptest.NewRecorder()
	handler.ServeHTTP(public, httptest.NewRequest(http.MethodGet, "/api/v1/share-links/not-a-real-token", nil))
	if public.Code != http.StatusNotFound || !strings.Contains(public.Body.String(), "SHARE_UNAVAILABLE") {
		t.Fatalf("public route status/body = %d/%q", public.Code, public.Body.String())
	}
	unknown := httptest.NewRecorder()
	handler.ServeHTTP(unknown, httptest.NewRequest(http.MethodGet, "/api/v1/unknown", nil))
	if unknown.Code != http.StatusNotFound || strings.Contains(unknown.Body.String(), "SHARE_UNAVAILABLE") {
		t.Fatalf("unknown route status/body = %d/%q", unknown.Code, unknown.Body.String())
	}
	logs := bytes.NewBuffer(nil)
	logHandler := NewHandlerWithServices(HealthChecks{}, slog.New(slog.NewTextHandler(logs, nil)), Services{ShareLinks: sharelinks.NewService(db, store, nil, false)})
	logHandler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/v1/share-links/secret-token/photos", nil))
	if strings.Contains(logs.String(), "secret-token") {
		t.Fatalf("share token was written to request logs: %s", logs.String())
	}
}
