package faces

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"image"
	"image/draw"
	"image/jpeg"
	"io"
	"net/http"
	"strings"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
	"github.com/zxxx98/77Photo/internal/maintenance"
)

type Handler struct {
	s    *Service
	auth *auth.Service
}

func NewHandler(s *Service, a *auth.Service) http.Handler { return &Handler{s, a} }
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	authenticated, e := h.auth.AuthenticateRequest(r.Context(), r)
	if e != nil {
		writeError(w, r, 401, "AUTH_REQUIRED")
		return
	}
	if authenticated.Account.Role != acl.RoleAdmin {
		writeError(w, r, 403, "ADMIN_REQUIRED")
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		if e = h.auth.AuthorizeWrite(r, authenticated); e != nil {
			writeError(w, r, 403, "CSRF_INVALID")
			return
		}
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/admin/")
	parts := strings.Split(path, "/")
	if path == "faces/config" && r.Method == "GET" {
		writeJSON(w, 200, map[string]any{"enabled": h.s.cfg.Enabled, "configured": h.s.cfg.URL != "" && h.s.cfg.Token != "", "automatic_matching": h.s.cfg.MatchThreshold < 1, "match_threshold": h.s.cfg.MatchThreshold, "match_margin": h.s.cfg.MatchMargin, "concurrency": max(1, h.s.cfg.Concurrency)})
		return
	}
	if path == "faces/test" && r.Method == "POST" {
		p, e := h.s.Test(r.Context())
		h.result(w, r, p, e)
		return
	}
	if path == "faces/jobs" {
		if r.Method == "GET" {
			jobs, e := h.s.Jobs(r.Context())
			h.result(w, r, map[string]any{"items": jobs}, e)
			return
		}
		if r.Method == "POST" {
			var in struct {
				Mode   string `json:"mode"`
				Folder string `json:"folder_id"`
			}
			if !readJSON(w, r, &in) {
				return
			}
			if in.Mode == "" {
				in.Mode = "incremental"
			}
			j, e := h.s.Start(r.Context(), authenticated.Account.ID, r.Header.Get("Idempotency-Key"), in.Mode, in.Folder)
			h.result(w, r, j, e)
			return
		}
	}
	if len(parts) >= 3 && parts[0] == "faces" && parts[1] == "jobs" {
		if len(parts) == 4 && parts[3] == "failed" && r.Method == "GET" {
			items, next, e := h.s.FailedItems(r.Context(), parts[2], r.URL.Query().Get("cursor"))
			h.result(w, r, map[string]any{"items": items, "next_cursor": next}, e)
			return
		}
		if len(parts) == 3 && r.Method == "GET" {
			j, e := h.s.Job(r.Context(), parts[2])
			h.result(w, r, j, e)
			return
		}
		if len(parts) == 4 && r.Method == "POST" {
			j, e := h.s.Control(r.Context(), parts[2], parts[3])
			h.result(w, r, j, e)
			return
		}
	}
	if path == "people" && r.Method == "GET" {
		items, next, e := h.s.People(r.Context(), r.URL.Query().Get("cursor"))
		h.result(w, r, map[string]any{"items": items, "next_cursor": next}, e)
		return
	}
	if len(parts) == 2 && parts[0] == "people" && r.Method == "PATCH" {
		var in struct {
			Name     string `json:"name"`
			Revision int    `json:"revision"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		h.result(w, r, map[string]bool{"ok": true}, h.s.Rename(r.Context(), parts[1], in.Name, in.Revision))
		return
	}
	if len(parts) == 3 && parts[0] == "people" {
		if parts[2] == "similar" && r.Method == "GET" {
			items, e := h.s.SimilarPeople(r.Context(), parts[1])
			h.result(w, r, map[string]any{"items": items}, e)
			return
		}
		if parts[2] == "faces" && r.Method == "GET" {
			items, next, e := h.s.FaceList(r.Context(), parts[1], r.URL.Query().Get("cursor"))
			h.result(w, r, map[string]any{"items": items, "next_cursor": next}, e)
			return
		}
		if parts[2] == "merge" && r.Method == "POST" {
			var in struct {
				Source         string `json:"source_id"`
				Revision       int    `json:"revision"`
				SourceRevision int    `json:"source_revision"`
			}
			if !readJSON(w, r, &in) {
				return
			}
			h.result(w, r, map[string]bool{"ok": true}, h.s.Merge(r.Context(), parts[1], in.Source, in.Revision, in.SourceRevision))
			return
		}
	}
	if len(parts) == 2 && parts[0] == "faces" && r.Method == "PATCH" {
		var in struct {
			Person   string `json:"person_id"`
			Ignored  bool   `json:"ignored"`
			Revision int    `json:"revision"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		h.result(w, r, map[string]bool{"ok": true}, h.s.Assign(r.Context(), parts[1], in.Person, in.Ignored, in.Revision))
		return
	}
	if len(parts) == 3 && parts[0] == "faces" && parts[2] == "thumbnail" && r.Method == "GET" {
		h.thumbnail(w, r, parts[1])
		return
	}
	writeError(w, r, 404, "NOT_FOUND")
}
func (h *Handler) thumbnail(w http.ResponseWriter, r *http.Request, fid string) {
	pid, b, e := h.s.facePhoto(r.Context(), fid)
	if e != nil {
		h.result(w, r, nil, e)
		return
	}
	raw, e := h.s.preview(r.Context(), pid)
	if e != nil {
		writeError(w, r, 503, "PREVIEW_UNAVAILABLE")
		return
	}
	img, _, e := image.Decode(bytes.NewReader(raw))
	if e != nil {
		writeError(w, r, 503, "PREVIEW_UNAVAILABLE")
		return
	}
	// Recheck after potentially slow preview generation so deletion cannot expose a stale crop.
	again, _, e := h.s.facePhoto(r.Context(), fid)
	if e != nil || again != pid {
		writeError(w, r, 404, "NOT_FOUND")
		return
	}
	bounds := img.Bounds()
	rect := image.Rect(int(b[0]*float64(bounds.Dx())), int(b[1]*float64(bounds.Dy())), int((b[0]+b[2])*float64(bounds.Dx())), int((b[1]+b[3])*float64(bounds.Dy()))).Intersect(bounds)
	if rect.Empty() {
		writeError(w, r, 404, "NOT_FOUND")
		return
	}
	crop := image.NewRGBA(image.Rect(0, 0, rect.Dx(), rect.Dy()))
	draw.Draw(crop, crop.Bounds(), img, rect.Min, draw.Src)
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "private, no-store")
	_ = jpeg.Encode(w, crop, &jpeg.Options{Quality: 85})
}
func readJSON(w http.ResponseWriter, r *http.Request, out any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if e := d.Decode(out); e != nil {
		writeError(w, r, 400, "INVALID_REQUEST")
		return false
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		writeError(w, r, 400, "INVALID_REQUEST")
		return false
	}
	return true
}
func (h *Handler) result(w http.ResponseWriter, r *http.Request, value any, e error) {
	if e == nil {
		writeJSON(w, 200, value)
		return
	}
	var we *WorkerError
	switch {
	case errors.Is(e, sql.ErrNoRows):
		writeError(w, r, 404, "NOT_FOUND")
	case errors.Is(e, ErrConflict):
		writeError(w, r, 409, "FACE_CONFLICT")
	case errors.Is(e, maintenance.ErrBusy):
		writeError(w, r, 409, "MAINTENANCE_IN_PROGRESS")
	case errors.Is(e, ErrDisabled):
		writeError(w, r, 409, "FACES_DISABLED")
	case errors.Is(e, ErrInvalid):
		writeError(w, r, 400, "INVALID_REQUEST")
	case errors.As(e, &we):
		writeError(w, r, 503, we.Code)
	default:
		writeError(w, r, 500, "FACE_REQUEST_FAILED")
	}
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func writeError(w http.ResponseWriter, r *http.Request, status int, code string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": code, "request_id": r.Header.Get("X-Request-ID")}})
}
