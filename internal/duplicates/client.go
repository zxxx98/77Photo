package duplicates

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime/multipart"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/zxxx98/77Photo/internal/faces"
)

type Profile struct {
	API       string `json:"api_version"`
	Pipeline  string `json:"pipeline_id"`
	Model     string `json:"embedding_model_id"`
	Dimension int    `json:"embedding_dim"`
	Device    string `json:"device"`
}
type Analysis struct {
	Profile
	RequestID string          `json:"request_id"`
	Encoding  string          `json:"embedding_encoding"`
	Embedding string          `json:"embedding"`
	Local     json.RawMessage `json:"local_features"`
	Vector    []float32       `json:"-"`
}
type Worker interface {
	Health(context.Context) (Profile, error)
	Analyze(context.Context, string, Profile, []byte) (Analysis, error)
	Verify(context.Context, Profile, string, string) (bool, error)
}
type Client struct {
	cfg  faces.Config
	http *http.Client
}

func NewClient(c faces.Config) *Client {
	return &Client{c, &http.Client{Timeout: c.Timeout, Transport: &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 5 * time.Second}).DialContext}, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect refused") }}}
}
func (c *Client) call(ctx context.Context, path, ct string, body io.Reader, out any) error {
	method := "GET"
	if body != nil {
		method = "POST"
	}
	req, e := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.cfg.URL, "/")+path, body)
	if e != nil {
		return e
	}
	req.Header.Set("Authorization", "Bearer "+c.cfg.Token)
	req.Header.Set("Content-Type", ct)
	resp, e := c.http.Do(req)
	if e != nil {
		return errors.New("SIMILARITY_WORKER_OFFLINE")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("SIMILARITY_WORKER_HTTP_%d", resp.StatusCode)
	}
	raw, e := io.ReadAll(io.LimitReader(resp.Body, 1024*1024+1))
	if e != nil || len(raw) > 1024*1024 || json.Unmarshal(raw, out) != nil {
		return errors.New("SIMILARITY_WORKER_PROTOCOL")
	}
	return nil
}
func (c *Client) Health(ctx context.Context) (Profile, error) {
	var p Profile
	e := c.call(ctx, "/v1/similarity/health", "", nil, &p)
	if e == nil && (p.API != "1" || p.Pipeline == "" || len(p.Pipeline) > 200 || p.Model == "" || len(p.Model) > 200 || p.Dimension < 16 || p.Dimension > 4096 || p.Device != "cuda") {
		e = errors.New("SIMILARITY_WORKER_INCOMPATIBLE")
	}
	return p, e
}
func (c *Client) Analyze(ctx context.Context, id string, p Profile, jpeg []byte) (Analysis, error) {
	var a Analysis
	var buf bytes.Buffer
	m := multipart.NewWriter(&buf)
	part, _ := m.CreateFormFile("image", "preview.jpg")
	_, _ = part.Write(jpeg)
	_ = m.WriteField("request_id", id)
	_ = m.WriteField("pipeline_id", p.Pipeline)
	_ = m.Close()
	if buf.Len() > 8<<20 {
		return a, errors.New("PREVIEW_TOO_LARGE")
	}
	e := c.call(ctx, "/v1/similarity/analyze", m.FormDataContentType(), &buf, &a)
	if e != nil {
		return a, e
	}
	if a.RequestID != id || a.Profile != p || a.Encoding != "float32-le-base64" || len(a.Local) > 160000 || !validLocal(a.Local) {
		return a, errors.New("SIMILARITY_WORKER_PROTOCOL")
	}
	raw, e := base64.StdEncoding.DecodeString(a.Embedding)
	if e != nil || len(raw) != p.Dimension*4 {
		return a, errors.New("SIMILARITY_WORKER_PROTOCOL")
	}
	a.Vector = vectorFromBytes(raw)
	norm := 0.0
	for _, x := range a.Vector {
		if math.IsNaN(float64(x)) || math.IsInf(float64(x), 0) {
			return a, errors.New("SIMILARITY_WORKER_PROTOCOL")
		}
		norm += float64(x) * float64(x)
	}
	if math.Abs(norm-1) > .02 {
		return a, errors.New("SIMILARITY_WORKER_PROTOCOL")
	}
	return a, nil
}
func (c *Client) Verify(ctx context.Context, p Profile, a, b string) (bool, error) {
	body, e := json.Marshal(map[string]any{"pipeline_id": p.Pipeline, "left": json.RawMessage(a), "right": json.RawMessage(b)})
	if e != nil {
		return false, e
	}
	var out struct {
		Verified bool `json:"verified"`
	}
	e = c.call(ctx, "/v1/similarity/verify", "application/json", bytes.NewReader(body), &out)
	return out.Verified, e
}

// Reject corrupted/unbounded local data before saving a feature row.
func validLocal(raw json.RawMessage) bool {
	var fields map[string]string
	if json.Unmarshal(raw, &fields) != nil || len(fields) != 2 {
		return false
	}
	points, ok := fields["points"]
	if !ok {
		return false
	}
	descriptors, ok := fields["descriptors"]
	if !ok {
		return false
	}
	xy, err := base64.StdEncoding.DecodeString(points)
	if err != nil || len(xy)%8 != 0 || len(xy) > 600*8 {
		return false
	}
	desc, err := base64.StdEncoding.DecodeString(descriptors)
	if err != nil || len(desc) != len(xy)/8*32 {
		return false
	}
	for _, v := range vectorFromBytes(xy) {
		if math.IsNaN(float64(v)) || math.IsInf(float64(v), 0) || v < 0 || v > 1 {
			return false
		}
	}
	return true
}
