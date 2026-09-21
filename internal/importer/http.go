package importer

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
	if r.URL.Path == "/api/v1/admin/imports" && r.Method == http.MethodPost {
		h.start(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/v1/admin/imports/") && r.Method == http.MethodGet {
		id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/admin/imports/"), "/")
		if id == "" || strings.Contains(id, "/") {
			writeError(w, r, http.StatusNotFound, "NOT_FOUND", "import job not found")
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
	var input struct {
		OrganizeByDate bool   `json:"organize_by_date"`
		SourcePath     string `json:"source_path"`
		UserID         string `json:"user_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_JSON", "request body is invalid")
		return
	}
	account := authenticated.Account
	job, err := h.service.StartWithOptions(r.Context(), acl.Principal{UserID: account.ID, Role: account.Role}, input.SourcePath, input.UserID, input.OrganizeByDate)
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
		writeError(w, r, http.StatusConflict, "IMPORT_IN_PROGRESS", "another import is already queued or running")
	case errors.Is(err, ErrInvalidSource):
		writeError(w, r, http.StatusBadRequest, "INVALID_IMPORT_SOURCE", "import source must be a readable directory inside the photo root and outside managed users/shared directories")
	case errors.Is(err, ErrUserNotFound):
		writeError(w, r, http.StatusNotFound, "USER_NOT_FOUND", "target user not found")
	case errors.Is(err, ErrNotFound):
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "import job not found")
	default:
		writeError(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "photo import could not be completed")
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
