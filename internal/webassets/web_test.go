package webassets

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandlerServesEmbeddedIndexAndSPARefresh(t *testing.T) {
	h := Handler()
	for _, path := range []string{"/", "/gallery", "/folders/2026"} {
		res := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		h.ServeHTTP(res, req)
		if res.Code != http.StatusOK {
			t.Fatalf("GET %s status = %d, want 200", path, res.Code)
		}
		if !strings.Contains(res.Body.String(), "77Photo") {
			t.Fatalf("GET %s did not return the embedded app shell", path)
		}
	}
}

func TestHandlerReturnsNotFoundForMissingAsset(t *testing.T) {
	res := httptest.NewRecorder()
	Handler().ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/assets/missing.js", nil))
	if res.Code != http.StatusNotFound {
		t.Fatalf("missing asset status = %d, want 404", res.Code)
	}
}
