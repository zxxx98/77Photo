package duplicates

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
	"github.com/zxxx98/77Photo/internal/maintenance"
	"github.com/zxxx98/77Photo/internal/photos"
)

type Handler struct {
	s    *Service
	auth *auth.Service
}

func NewHandler(s *Service, a *auth.Service) http.Handler { return &Handler{s, a} }
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	authenticated, e := h.auth.AuthenticateRequest(r.Context(), r)
	if e != nil {
		failure(w, r, 401, "AUTH_REQUIRED")
		return
	}
	if authenticated.Account.Role != acl.RoleAdmin {
		failure(w, r, 403, "ADMIN_REQUIRED")
		return
	}
	if r.Method != "GET" {
		if e = h.auth.AuthorizeWrite(r, authenticated); e != nil {
			failure(w, r, 403, "CSRF_INVALID")
			return
		}
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/admin/duplicates/")
	parts := strings.Split(path, "/")
	if path == "config" && r.Method == "GET" {
		respond(w, 200, map[string]bool{"ai_enabled": h.s.ai})
		return
	}
	if path == "groups" && r.Method == "GET" {
		kind := r.URL.Query().Get("kind")
		if kind == "" {
			kind = "exact"
		}
		v, e := h.s.Groups(r.Context(), kind, r.URL.Query().Get("cursor"))
		h.result(w, r, v, e)
		return
	}
	if path == "cleanup" && r.Method == "POST" {
		var in CleanupInput
		if !readBody(w, r, &in) {
			return
		}
		v, e := h.s.Cleanup(r.Context(), acl.Principal{UserID: authenticated.Account.ID, Role: acl.RoleAdmin}, in)
		h.result(w, r, v, e)
		return
	}
	if path == "jobs" {
		if r.Method == "GET" {
			v, e := h.s.Jobs(r.Context())
			h.result(w, r, map[string]any{"items": v}, e)
			return
		}
		if r.Method == "POST" {
			var in struct {
				Mode string `json:"mode"`
			}
			if !readBody(w, r, &in) {
				return
			}
			v, e := h.s.Start(r.Context(), in.Mode)
			h.result(w, r, v, e)
			return
		}
	}
	if len(parts) == 2 && parts[0] == "jobs" && r.Method == "GET" {
		v, e := h.s.Job(r.Context(), parts[1])
		h.result(w, r, v, e)
		return
	}
	if len(parts) == 3 && parts[0] == "jobs" && r.Method == "POST" {
		v, e := h.s.Control(r.Context(), parts[1], parts[2])
		h.result(w, r, v, e)
		return
	}
	failure(w, r, 404, "NOT_FOUND")
}
func readBody(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 65536)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if d.Decode(v) != nil {
		failure(w, r, 400, "INVALID_REQUEST")
		return false
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		failure(w, r, 400, "INVALID_REQUEST")
		return false
	}
	return true
}
func respond(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func failure(w http.ResponseWriter, r *http.Request, status int, code string) {
	respond(w, status, map[string]any{"error": map[string]string{"code": code, "message": code, "request_id": r.Header.Get("X-Request-ID")}})
}
func (h *Handler) result(w http.ResponseWriter, r *http.Request, v any, e error) {
	if e == nil {
		respond(w, 200, v)
		return
	}
	switch {
	case errors.Is(e, ErrInvalid), errors.Is(e, photos.ErrConfirmationRequired):
		failure(w, r, 400, "INVALID_REQUEST")
	case errors.Is(e, ErrChanged), errors.Is(e, photos.ErrTrashChanged):
		failure(w, r, 409, "DUPLICATE_GROUP_CHANGED")
	case errors.Is(e, ErrDisabled):
		failure(w, r, 409, "SIMILARITY_DISABLED")
	case errors.Is(e, maintenance.ErrBusy):
		failure(w, r, 409, "MAINTENANCE_IN_PROGRESS")
	case errors.Is(e, photos.ErrForbidden):
		failure(w, r, 403, "WRITE_FORBIDDEN")
	case errors.Is(e, sql.ErrNoRows), errors.Is(e, photos.ErrNotFound):
		failure(w, r, 404, "NOT_FOUND")
	default:
		failure(w, r, 503, "DUPLICATE_REQUEST_FAILED")
	}
}
