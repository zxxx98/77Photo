package folders

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
)

const foldersPath = "/api/v1/folders"

type HTTPHandler struct {
	service     *Service
	authService *auth.Service
}

func NewHTTPHandler(service *Service, authService *auth.Service) http.Handler {
	return &HTTPHandler{service: service, authService: authService}
}

func (h *HTTPHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == foldersPath || r.URL.Path == foldersPath+"/" {
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
	if !strings.HasPrefix(r.URL.Path, foldersPath+"/") {
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "route not found", nil)
		return
	}
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, foldersPath+"/"), "/")
	if id == "" {
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "route not found", nil)
		return
	}
	if strings.HasSuffix(id, "/move") {
		sourceID := strings.TrimSuffix(id, "/move")
		if sourceID == "" || strings.Contains(sourceID, "/") || r.Method != http.MethodPost {
			methodNotAllowed(w, r, http.MethodPost)
			return
		}
		h.move(w, r, sourceID)
		return
	}
	if strings.Contains(id, "/") {
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "route not found", nil)
		return
	}
	switch r.Method {
	case http.MethodGet:
		h.get(w, r, id)
	case http.MethodPatch:
		h.rename(w, r, id)
	case http.MethodDelete:
		h.delete(w, r, id)
	default:
		methodNotAllowed(w, r, "GET, PATCH, DELETE")
	}
	return
}

func (h *HTTPHandler) list(w http.ResponseWriter, r *http.Request) {
	account, _, _, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	var parentID *string
	if value := strings.TrimSpace(r.URL.Query().Get("parent_id")); value != "" {
		parentID = &value
	}
	items, err := h.service.List(r.Context(), principal(account), parentID)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (h *HTTPHandler) create(w http.ResponseWriter, r *http.Request) {
	account, session, _, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	if err := h.authService.ValidateCSRF(session, r.Header.Get(auth.CSRFHeaderName())); err != nil {
		writeError(w, r, http.StatusForbidden, "CSRF_INVALID", "csrf token is invalid", nil)
		return
	}
	var input CreateInput
	if !decodeBody(w, r, &input) {
		return
	}
	created, err := h.service.Create(r.Context(), principal(account), input)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

func (h *HTTPHandler) get(w http.ResponseWriter, r *http.Request, id string) {
	account, _, _, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	folder, err := h.service.Get(r.Context(), principal(account), id)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, folder)
}

func (h *HTTPHandler) rename(w http.ResponseWriter, r *http.Request, id string) {
	account, session, _, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	if err := h.authService.ValidateCSRF(session, r.Header.Get(auth.CSRFHeaderName())); err != nil {
		writeError(w, r, http.StatusForbidden, "CSRF_INVALID", "csrf token is invalid", nil)
		return
	}
	var input RenameInput
	if !decodeBody(w, r, &input) {
		return
	}
	folder, err := h.service.Rename(r.Context(), principal(account), id, input)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, folder)
}

func (h *HTTPHandler) move(w http.ResponseWriter, r *http.Request, id string) {
	account, session, _, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	if err := h.authService.ValidateCSRF(session, r.Header.Get(auth.CSRFHeaderName())); err != nil {
		writeError(w, r, http.StatusForbidden, "CSRF_INVALID", "csrf token is invalid", nil)
		return
	}
	var input struct {
		TargetFolderID string `json:"target_folder_id"`
		Conflict       string `json:"conflict"`
	}
	if !decodeBody(w, r, &input) {
		return
	}
	if input.Conflict == "" {
		input.Conflict = "reject"
	}
	folder, err := h.service.MoveWithConflict(r.Context(), principal(account), id, input.TargetFolderID, input.Conflict)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, folder)
}

func (h *HTTPHandler) delete(w http.ResponseWriter, r *http.Request, id string) {
	account, session, _, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	if err := h.authService.ValidateCSRF(session, r.Header.Get(auth.CSRFHeaderName())); err != nil {
		writeError(w, r, http.StatusForbidden, "CSRF_INVALID", "csrf token is invalid", nil)
		return
	}
	if err := h.service.Delete(r.Context(), principal(account), id); err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *HTTPHandler) writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrForbidden):
		code, message := "WRITE_FORBIDDEN", "folder is not writable"
		if r.Method == http.MethodGet {
			code, message = "READ_FORBIDDEN", "folder is not accessible"
		}
		writeError(w, r, http.StatusForbidden, code, message, nil)
	case errors.Is(err, ErrNotFound):
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "folder not found", nil)
	case errors.Is(err, ErrInvalidName):
		writeError(w, r, http.StatusUnprocessableEntity, "INVALID_REQUEST", "folder name is invalid", nil)
	case errors.Is(err, ErrNameConflict):
		writeError(w, r, http.StatusConflict, "NAME_CONFLICT", "a folder with this name already exists", nil)
	case errors.Is(err, ErrNotEmpty):
		writeError(w, r, http.StatusConflict, "FOLDER_NOT_EMPTY", "folder must be empty before deletion", nil)
	case errors.Is(err, ErrDescendant):
		writeError(w, r, http.StatusConflict, "FOLDER_DESCENDANT", "folder cannot move into its own descendant", nil)
	default:
		writeError(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "request could not be completed", nil)
	}
}

func principal(account auth.Account) acl.Principal {
	return acl.Principal{UserID: account.ID, Role: account.Role}
}

func decodeBody(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "request body is invalid", nil)
		return false
	}
	return true
}

func writeError(w http.ResponseWriter, r *http.Request, status int, code, message string, details map[string]any) {
	requestID := r.Header.Get("X-Request-ID")
	if requestID == "" {
		requestID = "request-id-missing"
	}
	payload := map[string]any{"error": map[string]any{"code": code, "message": message, "request_id": requestID}}
	if details != nil {
		payload["error"].(map[string]any)["details"] = details
	}
	writeJSON(w, status, payload)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func methodNotAllowed(w http.ResponseWriter, r *http.Request, allowed string) {
	w.Header().Set("Allow", allowed)
	writeError(w, r, http.StatusMethodNotAllowed, "INVALID_REQUEST", "method not allowed", nil)
}
