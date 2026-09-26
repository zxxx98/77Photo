package photos

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/url"
	"strings"

	"github.com/zxxx98/77Photo/internal/auth"
)

const (
	mapConfigPath = "/api/v1/map/config"
	mapPointsPath = "/api/v1/map/points"
)

// TileLayer is one raster layer; clients stack a config's layers in order.
// URL uses the Leaflet template placeholders {s}, {z}, {x} and {y}.
type TileLayer struct {
	URL        string `json:"url"`
	Subdomains string `json:"subdomains"`
}

// MapConfig tells clients which base map to draw. The zero value means no
// provider is configured and the map is disabled.
type MapConfig struct {
	Enabled        bool        `json:"enabled"`
	Provider       string      `json:"provider,omitempty"`
	TileLayers     []TileLayer `json:"tile_layers,omitempty"`
	MinZoom        int         `json:"min_zoom,omitempty"`
	MaxZoom        int         `json:"max_zoom,omitempty"`
	Attribution    string      `json:"attribution,omitempty"`
	AttributionURL string      `json:"attribution_url,omitempty"`
}

// TiandituMapConfig builds the Tianditu vector base map with Chinese labels
// in Web Mercator. The key is a browser key: it is only sent to signed-in
// clients, which request tiles from Tianditu directly.
func TiandituMapConfig(key string) MapConfig {
	if key == "" {
		return MapConfig{}
	}
	layer := func(name string) TileLayer {
		return TileLayer{
			URL:        "https://t{s}.tianditu.gov.cn/" + name + "_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=" + name + "&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=" + url.QueryEscape(key),
			Subdomains: "01234567",
		}
	}
	return MapConfig{
		Enabled:        true,
		Provider:       "tianditu",
		TileLayers:     []TileLayer{layer("vec"), layer("cva")},
		MinZoom:        1,
		MaxZoom:        18,
		Attribution:    "天地图",
		AttributionURL: "https://www.tianditu.gov.cn/",
	}
}

type MapHTTPHandler struct {
	service     *Service
	authService *auth.Service
	config      MapConfig
}

func NewMapHTTPHandler(service *Service, authService *auth.Service, config MapConfig) *MapHTTPHandler {
	return &MapHTTPHandler{service: service, authService: authService, config: config}
}

func (h *MapHTTPHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != mapConfigPath && r.URL.Path != mapPointsPath {
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "route not found", nil)
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeError(w, r, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method not allowed", nil)
		return
	}
	authenticated, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	if r.URL.Path == mapConfigPath {
		writeJSON(w, http.StatusOK, h.config)
		return
	}
	points, err := h.service.MapPoints(r.Context(), principal(authenticated.Account))
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "map points could not be loaded", nil)
		return
	}
	body, err := points.MarshalJSON()
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "map points could not be encoded", nil)
		return
	}
	sum := sha256.Sum256(body)
	etag := `W/"` + hex.EncodeToString(sum[:16]) + `"`
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("ETag", etag)
	w.Header().Set("Vary", "Cookie, Authorization, Accept-Encoding")
	if etagMatches(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if acceptsGzip(r.Header.Get("Accept-Encoding")) {
		var compressed bytes.Buffer
		writer := gzip.NewWriter(&compressed)
		if _, err := writer.Write(body); err == nil && writer.Close() == nil {
			w.Header().Set("Content-Encoding", "gzip")
			body = compressed.Bytes()
		}
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// etagMatches uses the weak comparison If-None-Match requires.
func etagMatches(header, etag string) bool {
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "*" || strings.TrimPrefix(candidate, "W/") == strings.TrimPrefix(etag, "W/") {
			return true
		}
	}
	return false
}

func acceptsGzip(header string) bool {
	for _, part := range strings.Split(header, ",") {
		coding, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		if !strings.EqualFold(strings.TrimSpace(coding), "gzip") {
			continue
		}
		quality := strings.ReplaceAll(strings.TrimSpace(params), " ", "")
		return quality != "q=0" && quality != "q=0.0" && quality != "q=0.00" && quality != "q=0.000"
	}
	return false
}
