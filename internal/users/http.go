package users

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/zxxx98/77Photo/internal/acl"
	"github.com/zxxx98/77Photo/internal/auth"
)

const usersPath = "/api/v1/users"

type HTTPHandler struct {
	service     *Service
	authService *auth.Service
}

func NewHTTPHandler(service *Service, authService *auth.Service) http.Handler {
	return &HTTPHandler{service: service, authService: authService}
}

func (h *HTTPHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == usersPath || r.URL.Path == usersPath+"/" {
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
	if !strings.HasPrefix(r.URL.Path, usersPath+"/") {
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "route not found", nil)
		return
	}
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, usersPath+"/"), "/")
	if id == "" || strings.Contains(id, "/") {
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "route not found", nil)
		return
	}
	switch r.Method {
	case http.MethodPatch:
		h.update(w, r, id)
	case http.MethodDelete:
		h.delete(w, r, id)
	default:
		methodNotAllowed(w, r, "PATCH, DELETE")
	}
}

func (h *HTTPHandler) list(w http.ResponseWriter, r *http.Request) {
	account, _, _, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	items, err := h.service.List(r.Context(), principal(account))
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
	var input struct {
		Username string   `json:"username"`
		Password string   `json:"password"`
		Role     acl.Role `json:"role"`
	}
	if !decodeBody(w, r, &input) {
		return
	}
	created, err := h.service.Create(r.Context(), principal(account), CreateInput{Username: input.Username, Password: input.Password, Role: input.Role})
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

func (h *HTTPHandler) update(w http.ResponseWriter, r *http.Request, id string) {
	account, session, _, err := h.authService.AuthenticateRequest(r.Context(), r)
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "AUTH_REQUIRED", "authentication required", nil)
		return
	}
	if err := h.authService.ValidateCSRF(session, r.Header.Get(auth.CSRFHeaderName())); err != nil {
		writeError(w, r, http.StatusForbidden, "CSRF_INVALID", "csrf token is invalid", nil)
		return
	}
	var input UpdateInput
	if !decodeBody(w, r, &input) {
		return
	}
	updated, err := h.service.Update(r.Context(), principal(account), id, input)
	if err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
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
	var input DeleteInput
	if r.Body != nil {
		if err := decodeOptionalBody(w, r, &input); err != nil {
			writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "request body is invalid", nil)
			return
		}
	}
	if err := h.service.Delete(r.Context(), principal(account), id, input); err != nil {
		h.writeServiceError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *HTTPHandler) writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrAdminRequired):
		writeError(w, r, http.StatusForbidden, "ADMIN_REQUIRED", "administrator role required", nil)
	case errors.Is(err, ErrUserNotFound):
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "user not found", nil)
	case errors.Is(err, ErrUsernameTaken):
		writeError(w, r, http.StatusConflict, "USERNAME_TAKEN", "username is already in use", nil)
	case errors.Is(err, ErrLastAdmin):
		writeError(w, r, http.StatusConflict, "LAST_ADMIN", "cannot remove the last active administrator", nil)
	case errors.Is(err, ErrTransferRequired):
		writeError(w, r, http.StatusUnprocessableEntity, "USER_TRANSFER_REQUIRED", "photo transfer target is required", nil)
	case errors.Is(err, ErrTransferInvalid):
		writeError(w, r, http.StatusUnprocessableEntity, "USER_TRANSFER_INVALID", "photo transfer target is invalid", nil)
	case errors.Is(err, ErrInvalidInput):
		writeError(w, r, http.StatusUnprocessableEntity, "INVALID_REQUEST", "user input is invalid", nil)
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
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "request body is invalid", nil)
		return false
	}
	return true
}

func decodeOptionalBody(w http.ResponseWriter, r *http.Request, target any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	err := decoder.Decode(target)
	if err == io.EOF {
		return nil
	}
	if err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return err
	}
	return nil
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
