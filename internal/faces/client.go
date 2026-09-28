// Package faces implements optional, administrator-only local face indexing.
package faces

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Config struct {
	Enabled                     bool
	URL, Token                  string
	Timeout                     time.Duration
	AllowHTTP                   bool
	MatchThreshold, MatchMargin float64
	Concurrency                 int
}

func (c Config) Validate() error {
	if !c.Enabled {
		return nil
	}
	u, e := url.Parse(c.URL)
	if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return errors.New("face worker URL must be an origin without credentials, path or query")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && c.AllowHTTP) {
		return errors.New("face worker requires HTTPS or explicit insecure LAN opt-in")
	}
	if len(c.Token) < 32 || strings.IndexFunc(c.Token, func(r rune) bool { return r <= 32 || r >= 127 }) >= 0 {
		return errors.New("face worker token must contain at least 32 printable non-space ASCII characters")
	}
	if c.Timeout <= 0 || c.Timeout > 5*time.Minute {
		return errors.New("face request timeout must be between zero and five minutes")
	}
	if c.MatchThreshold < 0 || c.MatchThreshold > 1 || c.MatchMargin < 0 || c.MatchMargin > 1 || math.IsNaN(c.MatchThreshold) || math.IsNaN(c.MatchMargin) {
		return errors.New("face matching thresholds must be between zero and one")
	}
	if c.Concurrency < 1 || c.Concurrency > 8 {
		return errors.New("face concurrency must be between one and eight")
	}
	return nil
}

type Profile struct {
	API       string `json:"api_version"`
	Pipeline  string `json:"pipeline_id"`
	Model     string `json:"embedding_model_id"`
	Dimension int    `json:"embedding_dim"`
	Device    string `json:"device"`
}
type Detection struct {
	Index   int        `json:"index"`
	Box     [4]float64 `json:"bbox"`
	Score   float64    `json:"detection_score"`
	Quality struct {
		Usable  bool     `json:"usable"`
		Reasons []string `json:"reasons"`
	} `json:"quality"`
	Encoding  string    `json:"embedding_encoding"`
	Embedding string    `json:"embedding"`
	Vector    []float32 `json:"-"`
}
type Analysis struct {
	Profile
	RequestID string `json:"request_id"`
	Image     struct {
		Width  int `json:"width"`
		Height int `json:"height"`
	} `json:"image"`
	Faces []Detection `json:"faces"`
}
type Worker interface {
	Health(context.Context) (Profile, error)
	Analyze(context.Context, string, Profile, []byte) (Analysis, error)
}
type WorkerError struct {
	Code  string
	Retry bool
}

func (e *WorkerError) Error() string { return e.Code }
func retryable(e error) bool         { var w *WorkerError; return errors.As(e, &w) && w.Retry }

type Client struct {
	cfg  Config
	http *http.Client
}

func NewClient(c Config) *Client {
	return &Client{c, &http.Client{Timeout: c.Timeout, Transport: &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 5 * time.Second}).DialContext, MaxIdleConnsPerHost: max(1, c.Concurrency)}, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect refused") }}}
}
func (c *Client) call(ctx context.Context, path, contentType string, body io.Reader, out any) error {
	method := "GET"
	if body != nil {
		method = "POST"
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.cfg.URL, "/")+path, body)
	if err != nil {
		return &WorkerError{"WORKER_CONFIG", false}
	}
	req.Header.Set("Authorization", "Bearer "+c.cfg.Token)
	if body != nil {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return &WorkerError{"WORKER_OFFLINE", true}
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return &WorkerError{fmt.Sprintf("WORKER_HTTP_%d", resp.StatusCode), resp.StatusCode == 429 || resp.StatusCode >= 500}
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1024*1024+1))
	if err != nil {
		return &WorkerError{"WORKER_READ", true}
	}
	if len(raw) > 1024*1024 || json.Unmarshal(raw, out) != nil {
		return &WorkerError{"WORKER_PROTOCOL", false}
	}
	return nil
}
func (c *Client) Health(ctx context.Context) (Profile, error) {
	var p Profile
	err := c.call(ctx, "/v1/health", "", nil, &p)
	if err == nil {
		err = validateProfile(p)
	}
	return p, err
}
func validateProfile(p Profile) error {
	if p.API != "1" || p.Pipeline == "" || len(p.Pipeline) > 200 || p.Model == "" || len(p.Model) > 200 || p.Dimension < 16 || p.Dimension > 4096 || p.Device != "cuda" {
		return &WorkerError{"WORKER_INCOMPATIBLE", false}
	}
	return nil
}
func (c *Client) Analyze(ctx context.Context, id string, p Profile, jpeg []byte) (Analysis, error) {
	var a Analysis
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	part, _ := mw.CreateFormFile("image", "preview.jpg")
	_, _ = part.Write(jpeg)
	_ = mw.WriteField("request_id", id)
	_ = mw.WriteField("pipeline_id", p.Pipeline)
	_ = mw.Close()
	if body.Len() > 8*1024*1024 {
		return a, &WorkerError{"PREVIEW_TOO_LARGE", false}
	}
	err := c.call(ctx, "/v1/analyze", mw.FormDataContentType(), &body, &a)
	if err != nil {
		return a, err
	}
	return a, validateAnalysis(&a, id, p)
}
func validateAnalysis(a *Analysis, id string, p Profile) error {
	bad := &WorkerError{"WORKER_PROTOCOL", false}
	if a.RequestID != id || a.API != p.API || a.Pipeline != p.Pipeline || a.Model != p.Model || a.Dimension != p.Dimension || a.Image.Width < 1 || a.Image.Height < 1 || a.Image.Width > 1280 || a.Image.Height > 1280 || len(a.Faces) > 100 {
		return bad
	}
	for i := range a.Faces {
		f := &a.Faces[i]
		if f.Index != i || !finite(f.Score) || f.Score < 0 || f.Score > 1 {
			return bad
		}
		for _, v := range f.Box {
			if !finite(v) || v < 0 || v > 1 {
				return bad
			}
		}
		if f.Box[2] <= 0 || f.Box[3] <= 0 || f.Box[0]+f.Box[2] > 1.000001 || f.Box[1]+f.Box[3] > 1.000001 {
			return bad
		}
		if !f.Quality.Usable {
			if f.Embedding != "" {
				return bad
			}
			continue
		}
		if f.Encoding != "float32-le-base64" {
			return bad
		}
		raw, err := base64.StdEncoding.DecodeString(f.Embedding)
		if err != nil || len(raw) != p.Dimension*4 {
			return bad
		}
		f.Vector = decodeVector(raw)
		norm := 0.0
		for _, v := range f.Vector {
			if !finite(float64(v)) {
				return bad
			}
			norm += float64(v) * float64(v)
		}
		if math.Abs(norm-1) > 0.02 {
			return bad
		}
	}
	return nil
}
func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }
func decodeVector(b []byte) []float32 {
	v := make([]float32, len(b)/4)
	for i := range v {
		v[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[i*4:]))
	}
	return v
}
func encodeVector(v []float32) []byte {
	b := make([]byte, len(v)*4)
	for i, x := range v {
		binary.LittleEndian.PutUint32(b[i*4:], math.Float32bits(x))
	}
	return b
}
