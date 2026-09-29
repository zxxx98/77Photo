package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/zxxx98/77Photo/internal/sharelinks"
	"github.com/zxxx98/77Photo/internal/storage"
)

func TestHealthzReportsDependencyFailureAndRequestID(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(bytes.NewBuffer(nil), nil))
	h := NewHandler(HealthChecks{
		Database: func(context.Context) error { return nil },
		Storage:  func(context.Context) error { return errors.New("disk unavailable") },
	}, logger)

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.Header.Set("X-Request-ID", "client-request-123")
	res := httptest.NewRecorder()
	h.ServeHTTP(res, req)

	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", res.Code)
	}
	if got := res.Header().Get("X-Request-ID"); got != "client-request-123" {
		t.Fatalf("X-Request-ID = %q, want propagated ID", got)
	}
	var body struct {
		Status   string `json:"status"`
		Database string `json:"database"`
		Storage  string `json:"storage"`
		Media    string `json:"media"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("decode health response: %v", err)
	}
	if body.Status != "degraded" || body.Database != "ok" || body.Storage != "unavailable" || body.Media != "unavailable" {
		t.Fatalf("health body = %+v", body)
	}
}

func TestHealthzIsOKWhenDependenciesAreAvailable(t *testing.T) {
	h := NewHandler(HealthChecks{
		Database: func(context.Context) error { return nil },
		Storage:  func(context.Context) error { return nil },
	}, slog.New(slog.NewTextHandler(bytes.NewBuffer(nil), nil)))
	res := httptest.NewRecorder()
	h.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.Code)
	}
	var body struct {
		Media string `json:"media"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("decode health response: %v", err)
	}
	if body.Media != "unavailable" {
		t.Fatalf("media = %q, want unavailable when capability is not configured", body.Media)
	}
}

func TestWriteErrorUsesUnifiedEnvelope(t *testing.T) {
	res := httptest.NewRecorder()
	WriteError(res, http.StatusForbidden, "WRITE_FORBIDDEN", "read-only members cannot modify shared resources", "req-test", map[string]any{"resource": "folder"})
	if got := res.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", got)
	}
	var body map[string]any
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("decode error response: %v", err)
	}
	errBody, ok := body["error"].(map[string]any)
	if !ok || errBody["code"] != "WRITE_FORBIDDEN" || errBody["request_id"] != "req-test" {
		t.Fatalf("error body = %#v", body)
	}
}

func TestRequestIDIsGeneratedWhenHeaderIsMissing(t *testing.T) {
	h := NewHandler(HealthChecks{
		Database: func(context.Context) error { return nil },
		Storage:  func(context.Context) error { return nil },
	}, slog.New(slog.NewTextHandler(bytes.NewBuffer(nil), nil)))
	res := httptest.NewRecorder()
	h.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if got := res.Header().Get("X-Request-ID"); len(got) != 32 {
		t.Fatalf("generated X-Request-ID = %q, want 32 hex characters", got)
	}
}

func TestManagedShareRoutesAreMountedSeparatelyFromPublicLinks(t *testing.T) {
	handler := NewHandlerWithServices(HealthChecks{}, nil, Services{ShareLinks: sharelinks.NewService(nil, storage.Store{}, nil, false)})
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/v1/me/share-links"},
		{http.MethodDelete, "/api/v1/me/share-links/sl_1"},
	} {
		out := httptest.NewRecorder()
		handler.ServeHTTP(out, httptest.NewRequest(tc.method, tc.path, nil))
		if out.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s = %d, want management authentication", tc.method, tc.path, out.Code)
		}
	}
}
