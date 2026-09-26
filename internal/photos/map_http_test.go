package photos

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/zxxx98/77Photo/internal/auth"
)

func mapRequest(method, target, token string) *http.Request {
	request := httptest.NewRequest(method, target, nil)
	if token != "" {
		request.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: token})
	}
	return request
}

func TestMapHTTPRequiresAuthentication(t *testing.T) {
	f := newMapFixture(t)
	handler := NewMapHTTPHandler(f.service, f.auth, TiandituMapConfig("key"))
	for _, target := range []string{mapConfigPath, mapPointsPath} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, mapRequest(http.MethodGet, target, ""))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("GET %s without session = %d, want 401", target, response.Code)
		}
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, mapRequest(http.MethodPost, mapPointsPath, f.adminToken))
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("POST points = %d allow=%q, want 405 GET", response.Code, response.Header().Get("Allow"))
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, mapRequest(http.MethodGet, "/api/v1/map/tiles", f.adminToken))
	if response.Code != http.StatusNotFound {
		t.Fatalf("GET unknown map route = %d, want 404", response.Code)
	}
}

func TestMapHTTPConfig(t *testing.T) {
	f := newMapFixture(t)
	response := httptest.NewRecorder()
	NewMapHTTPHandler(f.service, f.auth, TiandituMapConfig("")).ServeHTTP(response, mapRequest(http.MethodGet, mapConfigPath, f.memberToken))
	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != `{"enabled":false}` {
		t.Fatalf("disabled config = %d %s", response.Code, response.Body.String())
	}

	response = httptest.NewRecorder()
	NewMapHTTPHandler(f.service, f.auth, TiandituMapConfig("ab&c/d")).ServeHTTP(response, mapRequest(http.MethodGet, mapConfigPath, f.memberToken))
	var config MapConfig
	if err := json.Unmarshal(response.Body.Bytes(), &config); err != nil {
		t.Fatal(err)
	}
	if !config.Enabled || config.Provider != "tianditu" || config.MinZoom != 1 || config.MaxZoom != 18 || len(config.TileLayers) != 2 {
		t.Fatalf("config = %+v", config)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("config Cache-Control = %q, want no-store", response.Header().Get("Cache-Control"))
	}
	for i, layer := range []string{"vec", "cva"} {
		url := config.TileLayers[i].URL
		if !strings.HasPrefix(url, "https://t{s}.tianditu.gov.cn/"+layer+"_w/wmts?") || !strings.Contains(url, "&LAYER="+layer+"&") ||
			!strings.Contains(url, "TILEMATRIX={z}&TILEROW={y}&TILECOL={x}") || !strings.HasSuffix(url, "&tk=ab%26c%2Fd") || config.TileLayers[i].Subdomains != "01234567" {
			t.Fatalf("layer %d = %+v", i, config.TileLayers[i])
		}
	}
}

func TestMapHTTPPointsSupportGzipAndRevalidation(t *testing.T) {
	f := newMapFixture(t)
	trip := f.add(t, f.sharedFolder, "trip.jpg", coordinate(-33.8568), coordinate(151.2153), "2026-06-01T00:00:00Z")
	f.add(t, f.privateFolder, "home.jpg", coordinate(31.2304), coordinate(121.4737), "2026-05-01T00:00:00Z")
	handler := NewMapHTTPHandler(f.service, f.auth, MapConfig{})

	request := mapRequest(http.MethodGet, mapPointsPath, f.memberToken)
	request.Header.Set("Accept-Encoding", "br, gzip")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("points = %d encoding=%q", response.Code, response.Header().Get("Content-Encoding"))
	}
	if response.Header().Get("Cache-Control") != "private, no-cache" || !strings.Contains(response.Header().Get("Vary"), "Accept-Encoding") {
		t.Fatalf("points cache headers = %v", response.Header())
	}
	reader, err := gzip.NewReader(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Items       [][]any `json:"items"`
		TotalPhotos int     `json:"total_photos"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
	if len(payload.Items) != 1 || payload.Items[0][0] != trip.ID || payload.Items[0][1] != -33.8568 || payload.Items[0][2] != 151.2153 || payload.Items[0][3] != "2026-06-01T00:00:00Z" || payload.TotalPhotos != 1 {
		t.Fatalf("member payload = %s", body)
	}

	etag := response.Header().Get("ETag")
	if !strings.HasPrefix(etag, `W/"`) {
		t.Fatalf("ETag = %q, want weak validator", etag)
	}
	request = mapRequest(http.MethodGet, mapPointsPath, f.memberToken)
	request.Header.Set("If-None-Match", `"stale", `+etag)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNotModified || response.Body.Len() != 0 {
		t.Fatalf("revalidation = %d with %d body bytes, want 304", response.Code, response.Body.Len())
	}

	request = mapRequest(http.MethodGet, mapPointsPath, f.memberToken)
	request.Header.Set("Accept-Encoding", "gzip;q=0")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Header().Get("Content-Encoding") != "" || !bytes.Equal(response.Body.Bytes(), body) {
		t.Fatalf("identity response encoding=%q body=%s", response.Header().Get("Content-Encoding"), response.Body.String())
	}
	if response.Header().Get("ETag") != etag {
		t.Fatalf("identity ETag = %q, want %q", response.Header().Get("ETag"), etag)
	}
}

func TestHTTPListValidatesBBox(t *testing.T) {
	f := newMapFixture(t)
	inside := f.add(t, f.privateFolder, "inside.jpg", coordinate(31.2304), coordinate(121.4737), "2026-05-01T00:00:00Z")
	f.add(t, f.privateFolder, "outside.jpg", coordinate(39.9), coordinate(116.4), "2026-04-01T00:00:00Z")
	handler := NewHTTPHandler(f.service, f.auth)

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, mapRequest(http.MethodGet, "/api/v1/photos?bbox=121,31,122", f.adminToken))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid bbox = %d %s, want 400", response.Code, response.Body.String())
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, mapRequest(http.MethodGet, "/api/v1/photos?bbox=121,31,122,32&limit=10", f.adminToken))
	var page PhotoPage
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || len(page.Items) != 1 || page.Items[0].ID != inside.ID {
		t.Fatalf("bbox list = %d %s", response.Code, response.Body.String())
	}
}
