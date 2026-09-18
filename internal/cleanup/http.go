package cleanup

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
)

const cleanupPath = "/api/v1/admin/photos/cleanup"

type HTTPHandler struct {
	service     *Service
	authService *auth.Service
}

func NewHTTPHandler(service *Service, authService *auth.Service) http.Handler {
	return &HTTPHandler{service: service, authService: authService}
}

func (h *HTTPHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != cleanupPath {
		cleanupWriteError(w, r, http.StatusNotFound, "NOT_FOUND", "route not found")
		return
	}
	switch r.Method {
	case http.MethodGet:
		h.scan(w, r)
	case http.MethodPost:
		h.cleanup(w, r)
	default:
		w.Header().Set("Allow", "GET, POST")
		cleanupWriteError(w, r, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method not allowed")
	}
}

func (h *HTTPHandler) scan(w http.ResponseWriter, r *http.Request) {
	authenticated, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		cleanupWriteError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required")
		return
	}
	result, err := h.service.Scan(r.Context(), acl.Principal{UserID: authenticated.Account.ID, Role: authenticated.Account.Role})
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	cleanupWriteJSON(w, http.StatusOK, result)
}

func (h *HTTPHandler) cleanup(w http.ResponseWriter, r *http.Request) {
	authenticated, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		cleanupWriteError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required")
		return
	}
	if err := h.authService.AuthorizeWrite(r, authenticated); err != nil {
		cleanupWriteError(w, r, http.StatusForbidden, "CSRF_INVALID", "csrf token is invalid")
		return
	}
	var input struct {
		Confirm bool `json:"confirm"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&input); err != nil {
		cleanupWriteError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "request body is invalid")
		return
	}
	result, err := h.service.Cleanup(r.Context(), acl.Principal{UserID: authenticated.Account.ID, Role: authenticated.Account.Role}, input.Confirm)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	cleanupWriteJSON(w, http.StatusOK, result)
}

func (h *HTTPHandler) writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrForbidden):
		cleanupWriteError(w, r, http.StatusForbidden, "ADMIN_REQUIRED", "administrator access is required")
	case errors.Is(err, ErrConfirmationRequired):
		cleanupWriteError(w, r, http.StatusUnprocessableEntity, "CONFIRMATION_REQUIRED", "explicit confirmation is required before cleaning broken photos")
	default:
		cleanupWriteError(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "broken photo scan could not be completed")
	}
}

func cleanupWriteError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	requestID := r.Header.Get("X-Request-ID")
	if requestID == "" {
		requestID = "request-id-missing"
	}
	cleanupWriteJSON(w, status, map[string]any{"error": map[string]any{
		"code": code, "message": message, "request_id": requestID,
	}})
}

func cleanupWriteJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
