package thumbnails

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
)

type RebuildHTTPHandler struct {
	service     *RebuildService
	authService *auth.Service
}

func NewRebuildHTTPHandler(service *RebuildService, authService *auth.Service) http.Handler {
	return &RebuildHTTPHandler{service: service, authService: authService}
}

func (h *RebuildHTTPHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	const base = "/api/v1/admin/thumbnails/rebuild"
	if r.URL.Path == base && r.Method == http.MethodPost {
		h.start(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, base+"/") && r.Method == http.MethodGet {
		id := strings.Trim(strings.TrimPrefix(r.URL.Path, base+"/"), "/")
		if id == "" || strings.Contains(id, "/") {
			rebuildWriteError(w, r, http.StatusNotFound, "NOT_FOUND", "thumbnail rebuild job not found", nil)
			return
		}
		h.get(w, r, id)
		return
	}
	rebuildWriteError(w, r, http.StatusNotFound, "NOT_FOUND", "route not found", nil)
}

func (h *RebuildHTTPHandler) start(w http.ResponseWriter, r *http.Request) {
	authenticated, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		rebuildWriteError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	if err := h.authService.AuthorizeWrite(r, authenticated); err != nil {
		rebuildWriteError(w, r, http.StatusForbidden, "CSRF_INVALID", "csrf token is invalid", nil)
		return
	}
	var input struct {
		Mode RebuildMode `json:"mode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil && !errors.Is(err, io.EOF) {
		rebuildWriteError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "request body must be valid JSON", nil)
		return
	}
	if input.Mode == "" {
		input.Mode = RebuildModeFull
	}

	account := authenticated.Account
	job, err := h.service.StartWithMode(r.Context(), acl.Principal{UserID: account.ID, Role: account.Role}, input.Mode)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	rebuildWriteJSON(w, http.StatusAccepted, job)
}

func (h *RebuildHTTPHandler) get(w http.ResponseWriter, r *http.Request, id string) {
	authenticated, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		rebuildWriteError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	account := authenticated.Account
	job, err := h.service.Get(r.Context(), acl.Principal{UserID: account.ID, Role: account.Role}, id)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	rebuildWriteJSON(w, http.StatusOK, job)
}

func (h *RebuildHTTPHandler) writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrRebuildForbidden):
		rebuildWriteError(w, r, http.StatusForbidden, "ADMIN_REQUIRED", "administrator access is required", nil)
	case errors.Is(err, ErrRebuildConflict):
		var conflict *RebuildConflictError
		var details map[string]any
		if errors.As(err, &conflict) && conflict.JobID != "" {
			details = map[string]any{"job_id": conflict.JobID}
		}
		rebuildWriteError(w, r, http.StatusConflict, "THUMBNAIL_REBUILD_IN_PROGRESS", "another thumbnail rebuild is already queued or running", details)
	case errors.Is(err, ErrRebuildNotFound):
		rebuildWriteError(w, r, http.StatusNotFound, "NOT_FOUND", "thumbnail rebuild job not found", nil)
	case errors.Is(err, ErrRebuildInvalidMode):
		rebuildWriteError(w, r, http.StatusBadRequest, "INVALID_REBUILD_MODE", "thumbnail rebuild mode must be full or incremental", nil)
	default:
		rebuildWriteError(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "thumbnail rebuild could not be completed", nil)
	}
}

func rebuildWriteError(w http.ResponseWriter, r *http.Request, status int, code, message string, details map[string]any) {
	requestID := r.Header.Get("X-Request-ID")
	if requestID == "" {
		requestID = "request-id-missing"
	}
	errorPayload := map[string]any{"code": code, "message": message, "request_id": requestID}
	if details != nil {
		errorPayload["details"] = details
	}
	rebuildWriteJSON(w, status, map[string]any{"error": errorPayload})
}

func rebuildWriteJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
