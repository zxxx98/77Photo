package httpapi

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/zxxx98/77Photo/internal/auth"
	dbstore "github.com/zxxx98/77Photo/internal/database"
	"github.com/zxxx98/77Photo/internal/users"
)

func TestNewHandlerWithServicesMountsAuthAndUserRoutes(t *testing.T) {
	db, err := dbstore.Open(context.Background(), filepath.Join(t.TempDir(), "77photo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authService := auth.NewService(db, time.Hour, false)
	userService := users.NewService(db, authService)
	handler := NewHandlerWithServices(HealthChecks{Database: func(context.Context) error { return nil }, Storage: func(context.Context) error { return nil }}, slog.New(slog.NewTextHandler(bytes.NewBuffer(nil), nil)), Services{Auth: authService, Users: userService})

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
}
