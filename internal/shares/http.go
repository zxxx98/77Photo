package shares

import (
	"encoding/json"
	"errors"
	"io"
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
	if r.URL.Path == "/api/v1/shares" || r.URL.Path == "/api/v1/shares/" {
		switch r.Method {
		case http.MethodGet:
			h.list(w, r)
		case http.MethodPost:
			h.create(w, r)
		default:
			methodNotAllowed(w, r, "GET, POST")
		}
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/api/v1/shares/") {
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "route not found")
		return
	}
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/shares/"), "/")
	if id == "" || strings.Contains(id, "/") || r.Method != http.MethodDelete {
		methodNotAllowed(w, r, http.MethodDelete)
		return
	}
	h.revoke(w, r, id)
}

func (h *HTTPHandler) list(w http.ResponseWriter, r *http.Request) {
	account, _, _, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required")
		return
	}
	items, err := h.service.List(r.Context(), acl.Principal{UserID: account.ID, Role: account.Role})
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (h *HTTPHandler) create(w http.ResponseWriter, r *http.Request) {
	account, session, _, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required")
		return
	}
	if err := h.authService.ValidateCSRF(session, r.Header.Get(auth.CSRFHeaderName())); err != nil {
		writeError(w, r, http.StatusForbidden, "CSRF_INVALID", "csrf token is invalid")
		return
	}
	var input CreateInput
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "request body is invalid")
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "request body is invalid")
		return
	}
	share, err := h.service.Create(r.Context(), acl.Principal{UserID: account.ID, Role: account.Role}, input)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, share)
}

func (h *HTTPHandler) revoke(w http.ResponseWriter, r *http.Request, id string) {
	account, session, _, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required")
		return
	}
	if err := h.authService.ValidateCSRF(session, r.Header.Get(auth.CSRFHeaderName())); err != nil {
		writeError(w, r, http.StatusForbidden, "CSRF_INVALID", "csrf token is invalid")
		return
	}
	if err := h.service.Revoke(r.Context(), acl.Principal{UserID: account.ID, Role: account.Role}, id); err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *HTTPHandler) writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrForbidden):
		writeError(w, r, http.StatusForbidden, "SHARE_MANAGE_FORBIDDEN", "you cannot manage this folder share")
	case errors.Is(err, ErrNotFound):
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "share or folder not found")
	case errors.Is(err, ErrConflict):
		writeError(w, r, http.StatusConflict, "SHARE_CONFLICT", "folder is already shared with this user")
	case errors.Is(err, ErrInvalid):
		writeError(w, r, http.StatusUnprocessableEntity, "INVALID_REQUEST", "share request is invalid")
	default:
		writeError(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "share operation could not be completed")
	}
}

func writeError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	requestID := r.Header.Get("X-Request-ID")
	if requestID == "" {
		requestID = "request-id-missing"
	}
	writeJSON(w, status, map[string]any{"error": map[string]any{"code": code, "message": message, "request_id": requestID}})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func methodNotAllowed(w http.ResponseWriter, r *http.Request, allowed string) {
	w.Header().Set("Allow", allowed)
	writeError(w, r, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method not allowed")
}
