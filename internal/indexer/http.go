package indexer

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
)

type HTTPHandler struct {
	service     *Service
	authService *auth.Service
}

func NewHTTPHandler(service *Service, authService *auth.Service) http.Handler {
	return &HTTPHandler{service: service, authService: authService}
}

func (h *HTTPHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/api/v1/admin/rescan" && r.Method == http.MethodPost {
		h.start(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/v1/admin/rescan/") && r.Method == http.MethodGet {
		id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/admin/rescan/"), "/")
		if id == "" || strings.Contains(id, "/") {
			writeError(w, r, http.StatusNotFound, "NOT_FOUND", "rescan job not found")
			return
		}
		h.get(w, r, id)
		return
	}
	writeError(w, r, http.StatusNotFound, "NOT_FOUND", "route not found")
}

func (h *HTTPHandler) start(w http.ResponseWriter, r *http.Request) {
	authenticated, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required")
		return
	}
	if err := h.authService.AuthorizeWrite(r, authenticated); err != nil {
		writeError(w, r, http.StatusForbidden, "CSRF_INVALID", "csrf token is invalid")
		return
	}
	account := authenticated.Account
	job, err := h.service.Start(r.Context(), acl.Principal{UserID: account.ID, Role: account.Role})
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, job)
}

func (h *HTTPHandler) get(w http.ResponseWriter, r *http.Request, id string) {
	authenticated, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required")
		return
	}
	account := authenticated.Account
	job, err := h.service.Get(r.Context(), acl.Principal{UserID: account.ID, Role: account.Role}, id)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, job)
}

func (h *HTTPHandler) writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrForbidden):
		writeError(w, r, http.StatusForbidden, "ADMIN_REQUIRED", "administrator access is required")
	case errors.Is(err, ErrConflict):
		var conflict *ConflictError
		var details map[string]any
		if errors.As(err, &conflict) && conflict.JobID != "" {
			details = map[string]any{"job_id": conflict.JobID}
		}
		writeErrorWithDetails(w, r, http.StatusConflict, "RESCAN_IN_PROGRESS", "another rescan is already queued or running", details)
	case errors.Is(err, ErrNotFound):
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "rescan job not found")
	default:
		writeError(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "rescan could not be completed")
	}
}

func writeError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	writeErrorWithDetails(w, r, status, code, message, nil)
}

func writeErrorWithDetails(w http.ResponseWriter, r *http.Request, status int, code, message string, details map[string]any) {
	requestID := r.Header.Get("X-Request-ID")
	if requestID == "" {
		requestID = "request-id-missing"
	}
	errorPayload := map[string]any{"code": code, "message": message, "request_id": requestID}
	if details != nil {
		errorPayload["details"] = details
	}
	writeJSON(w, status, map[string]any{"error": errorPayload})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
